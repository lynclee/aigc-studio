/**
 * Compatibility surface for callers that have not moved to the full workflow
 * definition catalog yet. The capability data itself lives exclusively in
 * `definitions.ts`; do not add provider/workflow matrices here.
 */
export {
  emptyReferenceCapabilityMap,
  referenceCapabilityFor,
  referenceCapabilityMapForProviders,
} from "@/lib/workflows/definitions"

export type {
  ReferenceCapability,
  ReferenceCapabilityMap,
  WorkflowProvider,
} from "@/lib/workflows/definitions"
