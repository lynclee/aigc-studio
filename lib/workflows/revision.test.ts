import { describe, expect, it } from "vitest"
import type { AigcJobRecord, ProviderSubmitResult } from "@/lib/aigc/types"
import {
  assertSubmissionMatchesWorkflowSnapshot,
  createWorkflowJobSnapshot,
  workflowAssetRuleForJob,
  workflowOutputContractForGeneration,
  workflowSnapshotForJob,
  WorkflowSnapshotError,
  type WorkflowJobSnapshot,
} from "@/lib/workflows/revision"

describe("workflow Job revision snapshots", () => {
  it("pins exact base/reference execution identities", () => {
    const base = createWorkflowJobSnapshot({
      kind: "video", workflowId: "standard", provider: "modal-bridge", referenceCount: 0,
    })
    const referenced = createWorkflowJobSnapshot({
      kind: "video", workflowId: "standard", provider: "modal-bridge", referenceCount: 4,
    })
    const multiview = createWorkflowJobSnapshot({
      kind: "model3d", workflowId: "game-asset", provider: "fal-model3d", referenceCount: 3,
    })

    expect(base).toMatchObject({ definitionRevision: "1", executionVariant: "seedance2_t2v", referenceCount: 0 })
    expect(referenced).toMatchObject({ executionVariant: "seedance2_r2v", referenceCount: 4 })
    expect(multiview).toMatchObject({ executionVariant: "tripo3d-multiview", referenceCount: 3 })
    expect(Object.isFrozen(referenced)).toBe(true)
    expect(Object.isFrozen(referenced.outputContract)).toBe(true)
    expect(Object.isFrozen(referenced.outputContract[0])).toBe(true)
  })

  it("uses a valid retired workflow snapshot without consulting the live catalog", () => {
    const snapshot = retiredSnapshot()
    const job = jobIdentity(snapshot)

    expect(workflowSnapshotForJob(job)).toEqual(snapshot)
    expect(workflowAssetRuleForJob(job, "legacy-render")).toEqual({
      assetType: "legacy-render", category: "image", required: true, primary: true,
    })
  })

  it("fails closed for partially present, malformed, or mismatched snapshots", () => {
    const snapshot = retiredSnapshot()
    expect(() => workflowSnapshotForJob({
      ...jobIdentity(snapshot), workflow_snapshot: null,
    })).toThrow(WorkflowSnapshotError)
    expect(() => workflowSnapshotForJob({
      ...jobIdentity(snapshot), workflow_snapshot: { ...snapshot, kind: "video" },
    })).toThrow(WorkflowSnapshotError)
    expect(() => workflowSnapshotForJob({
      ...jobIdentity(snapshot), workflow_snapshot: { ...snapshot, outputContract: [] },
    })).toThrow(WorkflowSnapshotError)
  })

  it("allows current-catalog fallback only for a double-null legacy Job", () => {
    const legacy = {
      kind: "image" as const,
      workflow_id: "standard",
      provider: "modal-bridge",
      workflow_revision: null,
      workflow_snapshot: null,
    }
    expect(workflowAssetRuleForJob(legacy, "image")?.primary).toBe(true)
  })

  it("does not reinterpret malformed generation metadata as a legacy generation", () => {
    expect(() => workflowOutputContractForGeneration({
      kind: "image",
      workflow_id: "standard",
      provider: "modal-bridge",
      workflow_revision: 123,
      workflow_snapshot: "corrupt",
    })).toThrow(WorkflowSnapshotError)
  })

  it("rejects provider audit metadata that differs from the pinned execution", () => {
    const snapshot = retiredSnapshot()
    const submission: ProviderSubmitResult = {
      provider: "modal-bridge",
      providerJobId: "provider-1",
      status: "running",
      response: {
        catalog_workflow_id: "retired-v1",
        execution_variant: "different-variant",
        template_version: "7",
      },
    }
    expect(() => assertSubmissionMatchesWorkflowSnapshot(jobIdentity(snapshot), submission)).toThrow(
      WorkflowSnapshotError,
    )
  })
})

function retiredSnapshot(): WorkflowJobSnapshot {
  return {
    schemaVersion: 1,
    definitionRevision: "legacy-7",
    kind: "image",
    workflowId: "retired-v1",
    provider: "modal-bridge",
    executionVariant: "retired-image-v7",
    templateVersion: "7",
    referenceCount: 0,
    outputContract: [
      { assetType: "legacy-render", category: "image", required: true, primary: true },
      { assetType: "preview", category: "image", required: false, primary: false },
    ],
  }
}

function jobIdentity(snapshot: WorkflowJobSnapshot): Pick<
  AigcJobRecord,
  "kind" | "workflow_id" | "provider" | "workflow_revision" | "workflow_snapshot"
> {
  return {
    kind: snapshot.kind,
    workflow_id: snapshot.workflowId,
    provider: snapshot.provider,
    workflow_revision: snapshot.definitionRevision,
    workflow_snapshot: snapshot,
  }
}
