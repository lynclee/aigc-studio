import { describe, expect, it } from "vitest"
import { renderWorkflow, WorkflowReferenceInputError } from "@/lib/workflows/registry"

function img(name: string) {
  return { name, image: `data:image/png;base64,${name}` }
}

function inputWith(images: { name: string; image: string }[], extra: Record<string, unknown> = {}) {
  return { workflow: "standard", seed: 7, images, ...extra }
}

describe("renderWorkflow — image", () => {
  it("records text and image variants separately", () => {
    expect(renderWorkflow("image", { prompt: "cat", input: { workflow: "standard", seed: 7 } }).id)
      .toBe("z_image_turbo")
    expect(renderWorkflow("image", { prompt: "cat", input: inputWith([img("reference.png")]) }).id)
      .toBe("z_image_turbo_i2i")
  })
})

describe("renderWorkflow — video (seedance)", () => {
  it("无参考图时走文生视频模板(t2v)", () => {
    const rendered = renderWorkflow("video", { prompt: "a cat", input: { workflow: "standard", seed: 7 } })
    const { workflow } = rendered
    expect(rendered.id).toBe("seedance2_t2v")
    expect(rendered.templateVersion).toBe("1")
    // t2v 模板节点 "1" 是 ByteDance2TextToVideoNode
    const node = workflow["1"] as Record<string, Record<string, unknown>>
    expect(node.class_type).toBe("ByteDance2TextToVideoNode")
    expect(node.inputs["model.prompt"]).toBe("a cat")
    expect(node.inputs.seed).toBe(7)
    // 不应出现参考图变体的 ByteDance2ReferenceNode
    expect(workflow["360"]).toBeUndefined()
  })

  it("满 4 张 → 4 个 LoadImage 全保留、按 slot 顺序填名、参考键齐全", () => {
    const names = ["a.png", "b.png", "c.png", "d.png"]
    const rendered = renderWorkflow("video", { prompt: "runway", input: inputWith(names.map(img)) })
    const { workflow } = rendered
    expect(rendered.id).toBe("seedance2_r2v")
    expect((workflow["356"] as any).inputs.image).toBe("a.png") // slot 1
    expect((workflow["352"] as any).inputs.image).toBe("b.png") // slot 2
    expect((workflow["353"] as any).inputs.image).toBe("c.png") // slot 3
    expect((workflow["354"] as any).inputs.image).toBe("d.png") // slot 4
    const ref = (workflow["360"] as any).inputs
    expect(ref["model.prompt"]).toBe("runway")
    expect(ref.seed).toBe(7)
    expect(ref["model.reference_images.image_1"]).toEqual(["356", 0])
    expect(ref["model.reference_images.image_4"]).toEqual(["354", 0])
  })

  it.each([1, 2, 3])("真机验证前拒绝 %s 张欠槽 Seedance graph", (count) => {
    const images = Array.from({ length: count }, (_, index) => img(`${index}.png`))
    expect(() => renderWorkflow("video", { prompt: "x", input: inputWith(images) }))
      .toThrow(WorkflowReferenceInputError)
  })
})

describe("renderWorkflow — model3d (tripo)", () => {
  it("无参考图时走文生 3D 模板(t2model)", () => {
    const rendered = renderWorkflow("model3d", { prompt: "a sword", input: { workflow: "standard", seed: 7 } })
    const { workflow } = rendered
    expect(rendered.id).toBe("tripo3_t2model")
    const node = workflow["3"] as Record<string, Record<string, unknown>>
    expect(node.class_type).toBe("TripoTextToModelNode")
    expect(node.inputs.prompt).toBe("a sword")
    expect(workflow["19"]).toBeUndefined() // 无 BatchImagesNode
  })

  it("3 张 → 3 个 LoadImage 全保留、BatchImages 三键齐全", () => {
    const rendered = renderWorkflow("model3d", {
      prompt: "hero",
      input: inputWith([img("front.png"), img("side.png"), img("back.png")], { workflow: "game-asset" }),
    })
    const { workflow } = rendered
    expect(rendered.id).toBe("tripo3_i2model")
    expect((workflow["2"] as any).inputs.image).toBe("front.png") // slot 1
    expect((workflow["4"] as any).inputs.image).toBe("side.png") // slot 2
    expect((workflow["3"] as any).inputs.image).toBe("back.png") // slot 3
    const batch = (workflow["19"] as any).inputs
    expect(batch["images.image0"]).toEqual(["2", 0])
    expect(batch["images.image1"]).toEqual(["4", 0])
    expect(batch["images.image2"]).toEqual(["3", 0])
    // seed 透传到 TripoImageToModelNode
    expect((workflow["1"] as any).inputs.model_seed).toBe(7)
  })

  it.each([1, 2])("真机验证前拒绝 %s 张欠槽 Tripo graph", (count) => {
    const images = Array.from({ length: count }, (_, index) => img(`${index}.png`))
    expect(() => renderWorkflow("model3d", { prompt: "x", input: inputWith(images) }))
      .toThrow(WorkflowReferenceInputError)
  })
})
