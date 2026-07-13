import { describe, expect, it } from "vitest"
import {
  assetRuleForWorkflow,
  emptyPublicWorkflowCatalog,
  listWorkflowDefinitions,
  publicWorkflowCatalogForProviders,
  publicWorkflowDefinitionsForProvider,
  resolveExecutionVariant,
  validateWorkflowDefinitions,
  workflowDefinition,
  workflowExecutionFor,
  type WorkflowDefinition,
  type WorkflowExecution,
} from "@/lib/workflows/definitions"

describe("workflow definitions", () => {
  it("is the authoritative public workflow allowlist", () => {
    expect(listWorkflowDefinitions("image").map((item) => item.id)).toEqual(["standard", "detail"])
    expect(listWorkflowDefinitions("video").map((item) => item.id)).toEqual(["standard"])
    expect(listWorkflowDefinitions("model3d").map((item) => item.id)).toEqual(["standard", "game-asset"])
    expect(workflowDefinition("video", "detail")).toBeUndefined()
  })

  it("resolves provider-private base/reference variants and versions", () => {
    expect(workflowExecutionFor("image", "standard", "modal-bridge")).toMatchObject({
      baseVariant: "z_image_turbo",
      referenceVariant: "z_image_turbo_i2i",
      templateVersion: "1",
    })
    expect(workflowExecutionFor("video", "standard", "modal-bridge")).toMatchObject({
      baseVariant: "seedance2_t2v",
      referenceVariant: "seedance2_r2v",
      reference: { minImages: 4, maxImages: 4 },
    })
    expect(workflowExecutionFor("model3d", "game-asset", "fal-model3d")).toMatchObject({
      baseVariant: "tripo3d",
      referenceVariant: "tripo3d-image",
      reference: { minImages: 1, maxImages: 4 },
    })
    expect(workflowExecutionFor("video", "standard", "fal-model3d")).toBeUndefined()
  })

  it("selects execution variants by validated reference cardinality", () => {
    expect(resolveExecutionVariant("image", "standard", "modal-bridge", 0)?.variant).toBe("z_image_turbo")
    expect(resolveExecutionVariant("image", "standard", "modal-bridge", 1)?.variant).toBe("z_image_turbo_i2i")
    expect(resolveExecutionVariant("image", "standard", "modal-bridge", 2)).toBeUndefined()
    expect(resolveExecutionVariant("video", "standard", "modal-bridge", 3)).toBeUndefined()
    expect(resolveExecutionVariant("video", "standard", "modal-bridge", 4)?.variant).toBe("seedance2_r2v")
    expect(resolveExecutionVariant("model3d", "game-asset", "fal-model3d", 1)?.variant).toBe("tripo3d-image")
    expect(resolveExecutionVariant("model3d", "game-asset", "fal-model3d", 2)?.variant).toBe(
      "tripo3d-multiview",
    )
    expect(resolveExecutionVariant("model3d", "game-asset", "fal-model3d", 5)).toBeUndefined()
    expect(resolveExecutionVariant("model3d", "standard", "fal-model3d", -1)).toBeUndefined()
  })

  it("projects only workflows supported by the selected provider", () => {
    expect(publicWorkflowDefinitionsForProvider("video", "fal-video").map((item) => item.id)).toEqual(["standard"])
    expect(publicWorkflowDefinitionsForProvider("video", "modal-image")).toEqual([])
    expect(publicWorkflowDefinitionsForProvider("image", "modal-image").map((item) => item.id)).toEqual([
      "standard",
      "detail",
    ])
    expect(publicWorkflowDefinitionsForProvider("image", "modal-image")[0].inputSchema).toMatchObject({
      supportsDimensions: true,
      supportsAspectRatio: true,
      supportsSeed: true,
    })
    expect(publicWorkflowDefinitionsForProvider("image", "fal-image")[0].inputSchema).toEqual({
      prompt: { minLength: 1, maxLength: 4000 },
    })
    expect(publicWorkflowDefinitionsForProvider("image", "openrouter-image")[0].inputSchema).toEqual({
      prompt: { minLength: 1, maxLength: 4000 },
    })
  })

  it("never leaks provider or execution details through the public projection", () => {
    const catalog = publicWorkflowCatalogForProviders({
      image: "modal-bridge",
      video: "modal-bridge",
      model3d: "fal-model3d",
    })
    const serialized = JSON.stringify(catalog)
    expect(serialized).not.toContain("executions")
    expect(serialized).not.toContain("baseVariant")
    expect(serialized).not.toContain("referenceVariant")
    expect(serialized).not.toContain("modal-bridge")
    expect(serialized).not.toContain("fal-model3d")
    expect(catalog.video[0].reference).toMatchObject({ enabled: true, minImages: 4, maxImages: 4 })
    assertNoPrivateExecutionKeys(catalog)
  })

  it("keeps the logged-out catalog visible without advertising uploads", () => {
    const catalog = emptyPublicWorkflowCatalog()
    expect(catalog.image.map((item) => item.id)).toEqual(["standard", "detail"])
    expect(catalog.model3d.map((item) => item.id)).toEqual(["standard", "game-asset"])
    expect(Object.values(catalog).flat().every((item) => item.reference.enabled === false)).toBe(true)
  })

  it("classifies previews independently from each workflow's primary output", () => {
    expect(assetRuleForWorkflow("image", "standard", "image")).toMatchObject({ category: "image", primary: true })
    expect(assetRuleForWorkflow("video", "standard", "video")).toMatchObject({ category: "video", primary: true })
    expect(assetRuleForWorkflow("video", "standard", "preview")).toMatchObject({ category: "image", primary: false })
    expect(assetRuleForWorkflow("model3d", "game-asset", "model")).toMatchObject({
      category: "model",
      primary: true,
    })
    expect(assetRuleForWorkflow("model3d", "standard", "preview")).toMatchObject({
      category: "image",
      primary: false,
    })
    expect(assetRuleForWorkflow("video", "standard", "image")).toBeUndefined()
    expect(assetRuleForWorkflow("image", "missing", "image")).toBeUndefined()
  })

  it("has valid reference cardinality and version metadata for every execution", () => {
    for (const kind of ["image", "video", "model3d"] as const) {
      for (const definition of listWorkflowDefinitions(kind)) {
        expect(definition.inputSchema.prompt.minLength).toBeGreaterThan(0)
        expect(definition.revision).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
        expect(definition.inputSchema.prompt.maxLength).toBeGreaterThanOrEqual(
          definition.inputSchema.prompt.minLength,
        )
        expect(definition.outputContract.some((rule) => rule.primary)).toBe(true)
        for (const execution of Object.values(definition.executions)) {
          expect(execution?.baseVariant).toBeTruthy()
          expect(execution?.templateVersion).toBeTruthy()
          if (!execution?.reference) continue
          expect(execution.reference.enabled).toBe(true)
          expect(execution.reference.minImages).toBeGreaterThan(0)
          expect(execution.reference.maxImages).toBeGreaterThanOrEqual(execution.reference.minImages)
          expect(execution.reference.roles.length).toBeGreaterThanOrEqual(execution.reference.maxImages)
          expect(execution.referenceVariant).toBeTruthy()
        }
      }
    }
    expect(() =>
      validateWorkflowDefinitions(
        (["image", "video", "model3d"] as const).flatMap((kind) => listWorkflowDefinitions(kind)),
      ),
    ).not.toThrow()
  })

  it("rejects duplicate identities and ambiguous reference ranges", () => {
    const base = workflowDefinition("model3d", "game-asset") as WorkflowDefinition
    expect(() => validateWorkflowDefinitions([base, base])).toThrow(/duplicate workflow identity/)

    const execution = base.executions["fal-model3d"] as WorkflowExecution
    const broken = {
      ...base,
      executions: {
        ...base.executions,
        "fal-model3d": {
          ...execution,
          referenceVariants: [
            { variant: "one", minImages: 1, maxImages: 2 },
            { variant: "two", minImages: 2, maxImages: 4 },
          ],
        },
      },
    } satisfies WorkflowDefinition
    expect(() => validateWorkflowDefinitions([broken])).toThrow(/cover each supported count exactly once/)

    const wrongProvider = {
      ...base,
      executions: { "fal-video": { baseVariant: "bad", templateVersion: "1" } },
    } satisfies WorkflowDefinition
    expect(() => validateWorkflowDefinitions([wrongProvider])).toThrow(/provider cannot execute this workflow kind/)

    expect(() => validateWorkflowDefinitions([{ ...base, revision: "" }])).toThrow(/invalid workflow revision/)
  })
})

function assertNoPrivateExecutionKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoPrivateExecutionKeys)
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    expect([
      "provider",
      "executions",
      "baseVariant",
      "referenceVariant",
      "referenceVariants",
      "templateVersion",
      "revision",
    ]).not.toContain(key)
    if (typeof child === "string") {
      expect([
        "modal-image",
        "modal-bridge",
        "openrouter-image",
        "fal-image",
        "comfyui-image",
        "fal-video",
        "fal-model3d",
      ]).not.toContain(child)
    }
    assertNoPrivateExecutionKeys(child)
  }
}
