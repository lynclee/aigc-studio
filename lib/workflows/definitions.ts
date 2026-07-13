import type { AigcKind } from "@/lib/aigc/types"

/**
 * Stable server-side provider identifiers. These names are never included in
 * the public workflow catalog sent to the browser.
 */
export type WorkflowProvider =
  | "modal-image"
  | "modal-bridge"
  | "openrouter-image"
  | "fal-image"
  | "comfyui-image"
  | "fal-video"
  | "fal-model3d"

export type ReferenceCapability = Readonly<{
  enabled: boolean
  minImages: number
  maxImages: number
  roles: readonly string[]
}>

export type WorkflowAssetCategory = "image" | "video" | "model" | "output"

export type WorkflowAssetRule = Readonly<{
  assetType: string
  category: WorkflowAssetCategory
  required: boolean
  primary: boolean
}>

export type WorkflowInputSchema = Readonly<{
  prompt: Readonly<{ minLength: number; maxLength: number }>
  supportsDimensions?: true
  supportsAspectRatio?: true
  supportsSeed?: true
  dimensions?: Readonly<{ min: number; max: number }>
  aspectRatio?: Readonly<{ keywords: readonly string[]; pattern: string; maxRatio: number }>
  seed?: Readonly<{ min: number; maxExclusive: number }>
}>

export type WorkflowReferenceVariant = Readonly<{
  variant: string
  minImages: number
  maxImages: number
}>

/**
 * Provider-private execution data. `baseVariant` / `referenceVariant` are
 * logical, versioned execution identities rather than browser-facing workflow
 * ids. Adapters may map those identities to deploy-specific endpoints.
 */
export type WorkflowExecution = Readonly<{
  baseVariant: string
  templateVersion: string
  inputSchema?: WorkflowInputSchema
  referenceVariant?: string
  referenceVariants?: readonly WorkflowReferenceVariant[]
  reference?: ReferenceCapability
}>

export type ResolvedExecutionVariant = Readonly<{
  execution: WorkflowExecution
  variant: string
}>

export type WorkflowDefinition = Readonly<{
  id: string
  /** Bump whenever the server-authoritative workflow contract changes. */
  revision: string
  kind: AigcKind
  title: string
  hint: string
  placeholder: string
  inputSchema: WorkflowInputSchema
  outputContract: readonly WorkflowAssetRule[]
  executions: Readonly<Partial<Record<WorkflowProvider, WorkflowExecution>>>
}>

/** Provider-free projection that is safe to serialize into a client component. */
export type PublicWorkflowDefinition = Readonly<{
  id: string
  kind: AigcKind
  title: string
  hint: string
  placeholder: string
  inputSchema: WorkflowInputSchema
  reference: ReferenceCapability
}>

export type PublicWorkflowCatalog = Readonly<Record<AigcKind, readonly PublicWorkflowDefinition[]>>

export type ReferenceCapabilityMap = Record<AigcKind, Record<string, ReferenceCapability>>

const NO_REFERENCE: ReferenceCapability = Object.freeze({
  enabled: false,
  minImages: 0,
  maxImages: 0,
  roles: Object.freeze([]) as readonly string[],
})

const PROMPT = Object.freeze({ minLength: 1, maxLength: 4000 })
const DIMENSIONS = Object.freeze({ min: 64, max: 4096 })
const ASPECT_RATIO = Object.freeze({
  keywords: Object.freeze(["square", "portrait", "landscape", "wide"]),
  pattern: "^\\d{1,2}:\\d{1,2}$",
  maxRatio: 4,
})
const SEED = Object.freeze({ min: 0, maxExclusive: 0x100000000 })

const IMAGE_INPUT: WorkflowInputSchema = Object.freeze({
  prompt: PROMPT,
  supportsDimensions: true,
  supportsAspectRatio: true,
  supportsSeed: true,
  dimensions: DIMENSIONS,
  aspectRatio: ASPECT_RATIO,
  seed: SEED,
})

const SEEDED_INPUT: WorkflowInputSchema = Object.freeze({
  prompt: PROMPT,
  supportsSeed: true,
  seed: SEED,
})

const PROMPT_ONLY_INPUT: WorkflowInputSchema = Object.freeze({ prompt: PROMPT })

const IMAGE_OUTPUT: readonly WorkflowAssetRule[] = Object.freeze([
  Object.freeze({ assetType: "image", category: "image", required: true, primary: true }),
  Object.freeze({ assetType: "preview", category: "image", required: false, primary: false }),
])

const VIDEO_OUTPUT: readonly WorkflowAssetRule[] = Object.freeze([
  Object.freeze({ assetType: "video", category: "video", required: true, primary: true }),
  Object.freeze({ assetType: "preview", category: "image", required: false, primary: false }),
])

// Modal Bridge historically reports `model3d`, while URL providers normalize
// their main mesh as `model`. Both are primary alternatives; successful jobs
// must contain at least one primary rule, not both aliases.
const MODEL_OUTPUT: readonly WorkflowAssetRule[] = Object.freeze([
  Object.freeze({ assetType: "model3d", category: "model", required: false, primary: true }),
  Object.freeze({ assetType: "model", category: "model", required: false, primary: true }),
  Object.freeze({ assetType: "preview", category: "image", required: false, primary: false }),
])

const ONE_REFERENCE: ReferenceCapability = Object.freeze({
  enabled: true,
  minImages: 1,
  maxImages: 1,
  roles: Object.freeze(["reference"]),
})

const FOUR_VIDEO_REFERENCES: ReferenceCapability = Object.freeze({
  enabled: true,
  minImages: 4,
  maxImages: 4,
  roles: Object.freeze(["reference-1", "reference-2", "reference-3", "reference-4"]),
})

const THREE_MODEL_REFERENCES: ReferenceCapability = Object.freeze({
  enabled: true,
  minImages: 3,
  maxImages: 3,
  roles: Object.freeze(["front", "side", "back"]),
})

const FAL_MODEL_REFERENCES: ReferenceCapability = Object.freeze({
  enabled: true,
  minImages: 1,
  maxImages: 4,
  roles: Object.freeze(["front", "back", "left", "right"]),
})

const PROVIDER_KINDS: Readonly<Record<WorkflowProvider, readonly AigcKind[]>> = Object.freeze({
  "modal-image": ["image"],
  "modal-bridge": ["image", "video", "model3d"],
  "openrouter-image": ["image"],
  "fal-image": ["image"],
  "comfyui-image": ["image"],
  "fal-video": ["video"],
  "fal-model3d": ["model3d"],
})

const DEFINITIONS: readonly WorkflowDefinition[] = Object.freeze([
  {
    id: "standard",
    revision: "1",
    kind: "image",
    title: "标准出图",
    hint: "适合快速探索画面方向",
    placeholder: "描述你想要的画面、风格、主体、构图和用途……",
    inputSchema: IMAGE_INPUT,
    outputContract: IMAGE_OUTPUT,
    executions: {
      "modal-image": {
        baseVariant: "z_image_turbo",
        referenceVariant: "z_image_turbo_i2i",
        templateVersion: "1",
        reference: ONE_REFERENCE,
      },
      "modal-bridge": {
        baseVariant: "z_image_turbo",
        referenceVariant: "z_image_turbo_i2i",
        templateVersion: "1",
        reference: ONE_REFERENCE,
      },
      "comfyui-image": { baseVariant: "z_image_turbo", templateVersion: "1" },
      "openrouter-image": {
        baseVariant: "openrouter-standard",
        templateVersion: "1",
        inputSchema: PROMPT_ONLY_INPUT,
      },
      "fal-image": {
        baseVariant: "fal-image-standard",
        templateVersion: "1",
        inputSchema: PROMPT_ONLY_INPUT,
      },
    },
  },
  {
    id: "detail",
    revision: "1",
    kind: "image",
    title: "细节增强",
    hint: "适合更完整的美术描述",
    placeholder: "描述你想要的画面、风格、主体、构图和用途……",
    inputSchema: IMAGE_INPUT,
    outputContract: IMAGE_OUTPUT,
    executions: {
      "modal-image": { baseVariant: "flux2_klein", templateVersion: "1" },
      "modal-bridge": { baseVariant: "flux2_klein", templateVersion: "1" },
      "comfyui-image": { baseVariant: "flux2_klein", templateVersion: "1" },
      "openrouter-image": {
        baseVariant: "openrouter-detail",
        templateVersion: "1",
        inputSchema: PROMPT_ONLY_INPUT,
      },
      "fal-image": {
        baseVariant: "fal-image-detail",
        templateVersion: "1",
        inputSchema: PROMPT_ONLY_INPUT,
      },
    },
  },
  {
    id: "standard",
    revision: "1",
    kind: "video",
    title: "标准视频",
    hint: "适合短镜头概念",
    placeholder: "描述镜头内容、运动方式、氛围和画面风格……",
    inputSchema: SEEDED_INPUT,
    outputContract: VIDEO_OUTPUT,
    executions: {
      "modal-bridge": {
        baseVariant: "seedance2_t2v",
        referenceVariant: "seedance2_r2v",
        templateVersion: "1",
        reference: FOUR_VIDEO_REFERENCES,
      },
      "fal-video": { baseVariant: "fal-wan25-t2v", templateVersion: "1" },
    },
  },
  {
    id: "standard",
    revision: "1",
    kind: "model3d",
    title: "标准模型",
    hint: "只需填写提示词，适合常规 3D 资产",
    placeholder: "描述模型外观、材质、比例、用途和需要强调的细节……",
    inputSchema: SEEDED_INPUT,
    outputContract: MODEL_OUTPUT,
    executions: {
      "modal-bridge": {
        baseVariant: "tripo3_t2model",
        referenceVariant: "tripo3_i2model",
        templateVersion: "1",
        reference: THREE_MODEL_REFERENCES,
      },
      "fal-model3d": {
        baseVariant: "hunyuan3d",
        referenceVariant: "hunyuan3d-image",
        referenceVariants: [{ variant: "hunyuan3d-image", minImages: 1, maxImages: 4 }],
        templateVersion: "1",
        reference: FAL_MODEL_REFERENCES,
      },
    },
  },
  {
    id: "game-asset",
    revision: "1",
    kind: "model3d",
    title: "游戏资产",
    hint: "只需填写提示词，更偏向可下载资产",
    placeholder: "描述模型外观、材质、比例、用途和需要强调的细节……",
    inputSchema: SEEDED_INPUT,
    outputContract: MODEL_OUTPUT,
    executions: {
      "modal-bridge": {
        baseVariant: "tripo3_t2model",
        referenceVariant: "tripo3_i2model",
        templateVersion: "1",
        reference: THREE_MODEL_REFERENCES,
      },
      "fal-model3d": {
        baseVariant: "tripo3d",
        referenceVariant: "tripo3d-image",
        referenceVariants: [
          { variant: "tripo3d-image", minImages: 1, maxImages: 1 },
          { variant: "tripo3d-multiview", minImages: 2, maxImages: 4 },
        ],
        templateVersion: "1",
        reference: FAL_MODEL_REFERENCES,
      },
    },
  },
] satisfies readonly WorkflowDefinition[])

export class WorkflowDefinitionValidationError extends Error {
  readonly code = "invalid_workflow_definition"
}

/** Fail fast when the data-driven catalog contains an ambiguous contract. */
export function validateWorkflowDefinitions(definitions: readonly WorkflowDefinition[]): void {
  const identities = new Set<string>()
  for (const definition of definitions) {
    const identity = `${definition.kind}:${definition.id}`
    if (identities.has(identity)) throw invalidDefinition(identity, "duplicate workflow identity")
    identities.add(identity)
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(definition.id)) {
      throw invalidDefinition(identity, "invalid public workflow id")
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(definition.revision)) {
      throw invalidDefinition(identity, "invalid workflow revision")
    }
    validateInputSchema(identity, definition.inputSchema)

    const assetTypes = new Set<string>()
    for (const rule of definition.outputContract) {
      if (!rule.assetType || assetTypes.has(rule.assetType)) {
        throw invalidDefinition(identity, "duplicate or empty output asset type")
      }
      assetTypes.add(rule.assetType)
    }
    if (![...definition.outputContract].some((rule) => rule.primary)) {
      throw invalidDefinition(identity, "output contract has no primary asset")
    }

    const executions = Object.entries(definition.executions) as [WorkflowProvider, WorkflowExecution][]
    if (executions.length === 0) throw invalidDefinition(identity, "workflow has no provider execution")
    for (const [provider, execution] of executions) {
      const executionIdentity = `${identity}:${provider}`
      if (!PROVIDER_KINDS[provider]?.includes(definition.kind)) {
        throw invalidDefinition(executionIdentity, "provider cannot execute this workflow kind")
      }
      if (!execution.baseVariant.trim() || !execution.templateVersion.trim()) {
        throw invalidDefinition(executionIdentity, "empty execution variant or template version")
      }
      if (execution.inputSchema) validateInputSchema(executionIdentity, execution.inputSchema)
      const hasReferenceVariants = Boolean(execution.referenceVariant || execution.referenceVariants?.length)
      if (Boolean(execution.reference) !== hasReferenceVariants) {
        throw invalidDefinition(executionIdentity, "reference capability and variant metadata must appear together")
      }
      if (!execution.reference) continue
      validateReferenceExecution(executionIdentity, execution)
    }
  }
}

function validateInputSchema(identity: string, schema: WorkflowInputSchema): void {
  if (schema.prompt.minLength < 1 || schema.prompt.maxLength < schema.prompt.minLength) {
    throw invalidDefinition(identity, "invalid prompt bounds")
  }
  if (Boolean(schema.supportsDimensions) !== Boolean(schema.dimensions)) {
    throw invalidDefinition(identity, "dimension support and bounds must appear together")
  }
  if (schema.dimensions && (
    !Number.isInteger(schema.dimensions.min) ||
    !Number.isInteger(schema.dimensions.max) ||
    schema.dimensions.min < 1 ||
    schema.dimensions.max < schema.dimensions.min
  )) {
    throw invalidDefinition(identity, "invalid dimension bounds")
  }
  if (Boolean(schema.supportsAspectRatio) !== Boolean(schema.aspectRatio)) {
    throw invalidDefinition(identity, "aspect-ratio support and rule must appear together")
  }
  if (schema.aspectRatio) {
    try {
      new RegExp(schema.aspectRatio.pattern)
    } catch {
      throw invalidDefinition(identity, "invalid aspect-ratio pattern")
    }
    if (schema.aspectRatio.keywords.length === 0 || schema.aspectRatio.maxRatio < 1) {
      throw invalidDefinition(identity, "invalid aspect-ratio rule")
    }
  }
  if (Boolean(schema.supportsSeed) !== Boolean(schema.seed)) {
    throw invalidDefinition(identity, "seed support and bounds must appear together")
  }
  if (schema.seed && (
    !Number.isInteger(schema.seed.min) ||
    !Number.isInteger(schema.seed.maxExclusive) ||
    schema.seed.min < 0 ||
    schema.seed.maxExclusive <= schema.seed.min
  )) {
    throw invalidDefinition(identity, "invalid seed bounds")
  }
}

function validateReferenceExecution(identity: string, execution: WorkflowExecution): void {
  const capability = execution.reference as ReferenceCapability
  if (
    !capability.enabled ||
    !Number.isInteger(capability.minImages) ||
    !Number.isInteger(capability.maxImages) ||
    capability.minImages < 1 ||
    capability.maxImages < capability.minImages ||
    capability.roles.length < capability.maxImages
  ) {
    throw invalidDefinition(identity, "invalid reference capability")
  }

  const ranges = execution.referenceVariants
  if (!ranges?.length) return
  for (let count = capability.minImages; count <= capability.maxImages; count += 1) {
    const matches = ranges.filter((range) => count >= range.minImages && count <= range.maxImages)
    if (matches.length !== 1) {
      throw invalidDefinition(identity, "reference variant ranges must cover each supported count exactly once")
    }
  }
  for (const range of ranges) {
    if (
      !range.variant.trim() ||
      !Number.isInteger(range.minImages) ||
      !Number.isInteger(range.maxImages) ||
      range.minImages < capability.minImages ||
      range.maxImages > capability.maxImages ||
      range.maxImages < range.minImages
    ) {
      throw invalidDefinition(identity, "invalid reference variant range")
    }
  }
}

function invalidDefinition(identity: string, reason: string): WorkflowDefinitionValidationError {
  return new WorkflowDefinitionValidationError(`${identity}: ${reason}`)
}

validateWorkflowDefinitions(DEFINITIONS)

const DEFINITIONS_BY_KIND: Readonly<Record<AigcKind, readonly WorkflowDefinition[]>> = Object.freeze({
  image: Object.freeze(DEFINITIONS.filter((definition) => definition.kind === "image")),
  video: Object.freeze(DEFINITIONS.filter((definition) => definition.kind === "video")),
  model3d: Object.freeze(DEFINITIONS.filter((definition) => definition.kind === "model3d")),
})

export function listWorkflowDefinitions(kind: AigcKind): readonly WorkflowDefinition[] {
  return DEFINITIONS_BY_KIND[kind]
}

export function workflowDefinition(kind: AigcKind, workflowId: string): WorkflowDefinition | undefined {
  return DEFINITIONS_BY_KIND[kind].find((definition) => definition.id === workflowId)
}

export function workflowExecutionFor(
  kind: AigcKind,
  workflowId: string,
  provider: WorkflowProvider,
): WorkflowExecution | undefined {
  return workflowDefinition(kind, workflowId)?.executions[provider]
}

/** Provider-effective schema; executions may narrow parameters an adapter ignores. */
export function workflowInputSchemaFor(
  kind: AigcKind,
  workflowId: string,
  provider: WorkflowProvider,
): WorkflowInputSchema | undefined {
  const definition = workflowDefinition(kind, workflowId)
  const execution = definition?.executions[provider]
  if (!definition || !execution) return undefined
  return execution.inputSchema ?? definition.inputSchema
}

/**
 * Resolve the exact logical execution variant for the submitted reference
 * cardinality. Invalid/unsupported combinations return `undefined`, allowing
 * API validation and provider adapters to share the same decision without
 * silently falling back to a text-only variant.
 */
export function resolveExecutionVariant(
  kind: AigcKind,
  workflowId: string,
  provider: WorkflowProvider,
  referenceCount = 0,
): ResolvedExecutionVariant | undefined {
  if (!Number.isInteger(referenceCount) || referenceCount < 0) return undefined
  const execution = workflowExecutionFor(kind, workflowId, provider)
  if (!execution) return undefined
  if (referenceCount === 0) return { execution, variant: execution.baseVariant }

  const capability = execution.reference
  if (
    !capability?.enabled ||
    referenceCount < capability.minImages ||
    referenceCount > capability.maxImages
  ) {
    return undefined
  }

  const ranged = execution.referenceVariants?.find(
    (candidate) => referenceCount >= candidate.minImages && referenceCount <= candidate.maxImages,
  )
  const variant = ranged?.variant ?? execution.referenceVariant
  return variant ? { execution, variant } : undefined
}

export function assetRuleForWorkflow(
  kind: AigcKind,
  workflowId: string,
  assetType: string,
): WorkflowAssetRule | undefined {
  return workflowDefinition(kind, workflowId)?.outputContract.find((rule) => rule.assetType === assetType)
}

export function referenceCapabilityFor(
  kind: AigcKind,
  workflowId: string,
  provider: WorkflowProvider,
): ReferenceCapability {
  return workflowExecutionFor(kind, workflowId, provider)?.reference ?? NO_REFERENCE
}

export function publicWorkflowDefinitionsForProvider(
  kind: AigcKind,
  provider: WorkflowProvider,
): readonly PublicWorkflowDefinition[] {
  return DEFINITIONS_BY_KIND[kind]
    .filter((definition) => Boolean(definition.executions[provider]))
    .map((definition) => publicDefinition(
      definition,
      referenceCapabilityFor(kind, definition.id, provider),
      workflowInputSchemaFor(kind, definition.id, provider) as WorkflowInputSchema,
    ))
}

export function publicWorkflowCatalogForProviders(
  providers: Record<AigcKind, WorkflowProvider>,
): PublicWorkflowCatalog {
  return {
    image: publicWorkflowDefinitionsForProvider("image", providers.image),
    video: publicWorkflowDefinitionsForProvider("video", providers.video),
    model3d: publicWorkflowDefinitionsForProvider("model3d", providers.model3d),
  }
}

/**
 * Logged-out / provider-unavailable projection: keep the catalog visible while
 * advertising no upload capability. It intentionally contains no execution
 * data and is therefore safe for client serialization.
 */
export function emptyPublicWorkflowCatalog(): PublicWorkflowCatalog {
  return {
    image: DEFINITIONS_BY_KIND.image.map((definition) => publicDefinition(definition, NO_REFERENCE)),
    video: DEFINITIONS_BY_KIND.video.map((definition) => publicDefinition(definition, NO_REFERENCE)),
    model3d: DEFINITIONS_BY_KIND.model3d.map((definition) => publicDefinition(definition, NO_REFERENCE)),
  }
}

export function referenceCapabilityMapForProviders(
  providers: Record<AigcKind, WorkflowProvider>,
): ReferenceCapabilityMap {
  return {
    image: capabilityMapForKind("image", providers.image),
    video: capabilityMapForKind("video", providers.video),
    model3d: capabilityMapForKind("model3d", providers.model3d),
  }
}

export function emptyReferenceCapabilityMap(): ReferenceCapabilityMap {
  const catalog = emptyPublicWorkflowCatalog()
  return {
    image: Object.fromEntries(catalog.image.map((definition) => [definition.id, definition.reference])),
    video: Object.fromEntries(catalog.video.map((definition) => [definition.id, definition.reference])),
    model3d: Object.fromEntries(catalog.model3d.map((definition) => [definition.id, definition.reference])),
  }
}

function capabilityMapForKind(kind: AigcKind, provider: WorkflowProvider): Record<string, ReferenceCapability> {
  return Object.fromEntries(
    publicWorkflowDefinitionsForProvider(kind, provider).map((definition) => [definition.id, definition.reference]),
  )
}

function publicDefinition(
  definition: WorkflowDefinition,
  reference: ReferenceCapability,
  inputSchema: WorkflowInputSchema = definition.inputSchema,
): PublicWorkflowDefinition {
  return {
    id: definition.id,
    kind: definition.kind,
    title: definition.title,
    hint: definition.hint,
    placeholder: definition.placeholder,
    inputSchema,
    reference,
  }
}
