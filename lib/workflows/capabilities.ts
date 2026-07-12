import type { AigcKind } from "@/lib/aigc/types"

export type WorkflowProvider =
  | "modal-image"
  | "modal-bridge"
  | "openrouter-image"
  | "fal-image"
  | "comfyui-image"
  | "fal-video"
  | "fal-model3d"

export type ReferenceCapability = {
  enabled: boolean
  minImages: number
  maxImages: number
  roles: readonly string[]
}

export type ReferenceCapabilityMap = Record<AigcKind, Record<string, ReferenceCapability>>

const NONE: ReferenceCapability = { enabled: false, minImages: 0, maxImages: 0, roles: [] }

const PROVIDER_CAPABILITIES: Partial<
  Record<WorkflowProvider, Partial<Record<AigcKind, Record<string, ReferenceCapability>>>>
> = {
  "modal-image": {
    image: {
      standard: { enabled: true, minImages: 1, maxImages: 1, roles: ["reference"] },
    },
  },
  "modal-bridge": {
    image: {
      standard: { enabled: true, minImages: 1, maxImages: 1, roles: ["reference"] },
    },
    // Until the actual API nodes are verified with missing slots, only the exported full-cardinality
    // graphs are part of the public contract. Partial cardinalities must fail before provider submit.
    video: {
      standard: {
        enabled: true,
        minImages: 4,
        maxImages: 4,
        roles: ["reference-1", "reference-2", "reference-3", "reference-4"],
      },
    },
    model3d: {
      standard: { enabled: true, minImages: 3, maxImages: 3, roles: ["front", "side", "back"] },
      "game-asset": { enabled: true, minImages: 3, maxImages: 3, roles: ["front", "side", "back"] },
    },
  },
  "fal-model3d": {
    // fal's existing adapters accept one image or an ordered multi-view set up to four images.
    model3d: {
      standard: {
        enabled: true,
        minImages: 1,
        maxImages: 4,
        roles: ["front", "back", "left", "right"],
      },
      "game-asset": {
        enabled: true,
        minImages: 1,
        maxImages: 4,
        roles: ["front", "back", "left", "right"],
      },
    },
  },
}

const WORKFLOWS: Record<AigcKind, readonly string[]> = {
  image: ["standard", "detail"],
  video: ["standard"],
  model3d: ["standard", "game-asset"],
}

export function referenceCapabilityFor(
  kind: AigcKind,
  workflowId: string,
  provider: WorkflowProvider,
): ReferenceCapability {
  return PROVIDER_CAPABILITIES[provider]?.[kind]?.[workflowId] ?? NONE
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
  return {
    image: capabilityMapForKind("image", "openrouter-image"),
    video: capabilityMapForKind("video", "fal-video"),
    model3d: Object.fromEntries(WORKFLOWS.model3d.map((workflowId) => [workflowId, NONE])),
  }
}

function capabilityMapForKind(kind: AigcKind, provider: WorkflowProvider): Record<string, ReferenceCapability> {
  return Object.fromEntries(
    WORKFLOWS[kind].map((workflowId) => [workflowId, referenceCapabilityFor(kind, workflowId, provider)]),
  )
}
