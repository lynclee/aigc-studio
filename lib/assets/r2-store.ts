import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOneOptions } from "node:dns";
import { Transform } from "node:stream";
import { request } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getR2Client } from "@/lib/r2";
import type { ProviderOutputAsset } from "@/lib/aigc/types";
import {
  extForAsset,
  isAllowedContentType,
  maxBytesForCategory,
  normalizeContentType,
  type AssetCategory,
} from "@/lib/delivery/asset-policy";
import type { WorkflowAssetRule } from "@/lib/workflows/definitions";
import { validateOutputContract } from "@/lib/workflows/output-contract";

const TRUSTED_PROVIDER_HOST_SUFFIXES = [
  "fal.media",
  "fal.ai",
  "fal.run",
  "modal.run",
  "storage.googleapis.com",
];

const ASSET_FETCH_TIMEOUT_MS = 60_000;

type DownloadedAsset = {
  body: Transform;
  contentLength: number;
  contentType: string;
  abort: () => void;
};

export interface StoredAsset extends ProviderOutputAsset {
  r2Key?: string;
}

export async function storeProviderAssetsInR2(params: {
  userId: string;
  jobId: string;
  outputContract: readonly WorkflowAssetRule[];
  assets: ProviderOutputAsset[];
  keyVersion?: string;
}): Promise<StoredAsset[]> {
  validateOutputContract(params.outputContract, params.assets);
  const r2 = getR2Client();
  if (!r2) {
    throw new Error(
      "R2 asset persistence is required but R2 is not configured",
    );
  }

  const stored: StoredAsset[] = [];
  for (const asset of params.assets) {
    const category = providerAssetCategoryForContract(params.outputContract, asset.assetType);
    if (!asset.url || asset.r2Key) {
      stored.push(asset);
      continue;
    }
    const url = await validateProviderAssetUrl(asset.url);
    const downloaded = await downloadProviderAsset(url, category);
    const ext = extForAsset(
      category,
      downloaded.contentType,
      filenameFromPathname(url.pathname),
    );
    const key = providerAssetKey({
      userId: params.userId,
      jobId: params.jobId,
      assetType: asset.assetType,
      position: asset.position,
      ext,
      keyVersion: params.keyVersion,
    });

    try {
      await r2.client.send(
        new PutObjectCommand({
          Bucket: r2.bucket,
          Key: key,
          Body: downloaded.body,
          ContentLength: downloaded.contentLength,
          ContentType: downloaded.contentType,
        }),
      );
    } catch (error) {
      throw new Error(
        `Failed to upload provider asset to R2: ${errorMessage(error)}`,
      );
    } finally {
      downloaded.abort();
    }

    stored.push({ ...asset, r2Key: key, contentType: downloaded.contentType });
  }
  return stored;
}

function safeKeyVersion(value: string | undefined): string {
  return (value ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

export function providerAssetKey(params: {
  userId: string;
  jobId: string;
  assetType: string;
  position: number;
  ext: string;
  keyVersion?: string;
}): string {
  const version = safeKeyVersion(params.keyVersion);
  return `${params.userId}/${params.jobId}/${params.assetType}-${params.position}${version ? `-${version}` : ""}.${params.ext}`;
}

async function validateProviderAssetUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Provider asset URL is invalid");
  }

  if (url.protocol !== "https:") {
    throw new Error("Provider asset URL must use HTTPS");
  }

  if (url.username || url.password) {
    throw new Error("Provider asset URL must not include credentials");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!isTrustedProviderHost(hostname)) {
    throw new Error(`Provider asset host is not allowlisted: ${hostname}`);
  }

  const addresses = await lookupAndValidatePublicAddresses(hostname);
  if (addresses.length === 0) {
    throw new Error(
      `Provider asset host DNS lookup returned no addresses: ${hostname}`,
    );
  }

  return url;
}

function downloadProviderAsset(
  url: URL,
  category: AssetCategory,
): Promise<DownloadedAsset> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let source: IncomingMessage | null = null;
    let countedBody: Transform | null = null;

    const destroyStreams = (error?: Error) => {
      source?.destroy(error);
      countedBody?.destroy(error);
    };

    const fail = (error: unknown) => {
      if (!settled) {
        clearTimeout(timeout);
        settled = true;
        destroyStreams(error instanceof Error ? error : undefined);
        reject(
          new Error(
            `Failed to download provider asset for R2 persistence: ${errorMessage(error)}`,
          ),
        );
      }
    };

    const req = request(url, {
      lookup: secureLookup as RequestOptions["lookup"],
    });

    const abortDownload = (error?: Error) => {
      clearTimeout(timeout);
      req.destroy(error);
      destroyStreams(error);
    };
    const timeout = setTimeout(
      () => abortDownload(new Error("Provider asset download timed out")),
      ASSET_FETCH_TIMEOUT_MS,
    );

    req.on("response", (res) => {
      if (settled) return;
      source = res;
      if (res.statusCode !== 200) {
        res.destroy();
        fail(`HTTP ${res.statusCode ?? "unknown"}`);
        return;
      }

      try {
        const maxBytes = maxBytesForCategory(category);
        const contentLength = parseContentLength(
          headerValue(res.headers["content-length"]),
          maxBytes,
        );
        const contentType = normalizeContentType(
          headerValue(res.headers["content-type"]),
        );
        if (!contentType) {
          throw new Error("Provider asset is missing a Content-Type header");
        }
        if (!isAllowedContentType(category, contentType)) {
          throw new Error(
            `Provider asset MIME type is not allowed for ${category}: ${contentType}`,
          );
        }

        countedBody = createByteLimitTransform({
          contentLength,
          maxBytes,
        });
        res.on("error", (error) => countedBody?.destroy(error));
        countedBody.on("error", (error) => res.destroy(error));
        res.pipe(countedBody);

        settled = true;
        resolve({
          body: countedBody,
          contentLength,
          contentType,
          abort: () => abortDownload(),
        });
      } catch (error) {
        res.destroy();
        fail(error);
      }
    });

    req.on("error", fail);
    req.end();
  });

  function secureLookup(
    host: string,
    options: LookupOneOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string,
      family: 4 | 6,
    ) => void,
  ) {
    const requestedFamily = options.family;
    lookupAndValidatePublicAddresses(host)
      .then((addresses) => {
        const address =
          addresses.find(
            (entry) => !requestedFamily || entry.family === requestedFamily,
          ) ?? addresses[0];
        callback(null, address.address, address.family as 4 | 6);
      })
      .catch((error) => callback(error as NodeJS.ErrnoException, "", 4));
  }
}

function createByteLimitTransform(params: {
  contentLength: number;
  maxBytes: number;
}): Transform {
  let bytesRead = 0;
  const byteLimit = Math.min(params.contentLength, params.maxBytes);

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesRead += chunk.length;
      if (bytesRead > byteLimit) {
        callback(
          new Error(
            `Provider asset download exceeded allowed size (${bytesRead} > ${byteLimit} bytes)`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (bytesRead !== params.contentLength) {
        callback(
          new Error(
            `Provider asset downloaded byte count does not match Content-Length (${bytesRead} !== ${params.contentLength})`,
          ),
        );
        return;
      }
      callback();
    },
  });
}

async function lookupAndValidatePublicAddresses(
  hostname: string,
): Promise<LookupAddress[]> {
  let addresses: LookupAddress[];
  try {
    addresses = (await lookup(hostname, {
      all: true,
      verbatim: true,
    })) as LookupAddress[];
  } catch (error) {
    throw new Error(
      `Provider asset host DNS lookup failed: ${errorMessage(error)}`,
    );
  }

  for (const { address } of addresses) {
    if (isBlockedIpAddress(address)) {
      throw new Error(
        `Provider asset host resolves to a blocked address: ${hostname}`,
      );
    }
  }

  return addresses;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function isTrustedProviderHost(hostname: string): boolean {
  return trustedProviderHostSuffixes().some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function trustedProviderHostSuffixes(): string[] {
  const configured = parseHostList(process.env.AIGC_ASSET_HOST_ALLOWLIST);
  const modalEndpointHost = hostFromUrl(process.env.MODAL_ENDPOINT_BASE);
  return [
    ...TRUSTED_PROVIDER_HOST_SUFFIXES,
    ...configured,
    ...(modalEndpointHost ? [modalEndpointHost] : []),
  ];
}

function parseHostList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => normalizeHostname(host.trim()))
    .filter(Boolean);
}

function hostFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeHostname(new URL(value).hostname);
  } catch {
    return null;
  }
}

function parseContentLength(value: string | null, maxBytes: number): number {
  if (!value) {
    throw new Error("Provider asset is missing a Content-Length header");
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("Provider asset Content-Length is invalid");
  }
  const contentLength = Number(value);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw new Error(
      "Provider asset Content-Length must be a positive safe integer",
    );
  }
  if (contentLength > maxBytes) {
    throw new Error(
      `Provider asset exceeds maximum allowed size (${contentLength} > ${maxBytes} bytes)`,
    );
  }
  return contentLength;
}

export function providerAssetCategoryForContract(
  outputContract: readonly WorkflowAssetRule[],
  assetType: string,
): AssetCategory {
  const rule = outputContract.find((candidate) => candidate.assetType === assetType);
  if (!rule) throw new Error(`Provider asset type is not allowed by the pinned workflow contract: ${assetType}`);
  return rule.category;
}

function isBlockedIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  const [a, b] = parts;
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return true;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const mappedIpv4 = normalized.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  );
}

function filenameFromPathname(pathname: string): string | undefined {
  const filename = pathname.split("/").pop();
  return filename || undefined;
}

function headerValue(
  value: string | string[] | number | undefined,
): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "number") return String(value);
  return value ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
