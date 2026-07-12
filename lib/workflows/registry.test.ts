import { describe, expect, it } from "vitest"
import { renderWorkflow } from "@/lib/workflows/registry"

function img(name: string) {
  return { name, image: `data:image/png;base64,${name}` }
}

function inputWith(images: { name: string; image: string }[], extra: Record<string, unknown> = {}) {
  return { workflow: "standard", seed: 7, images, ...extra }
}

describe("renderWorkflow — video (seedance)", () => {
  it("无参考图时走文生视频模板(t2v)", () => {
    const { workflow } = renderWorkflow("video", { prompt: "a cat", input: { workflow: "standard", seed: 7 } })
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
    const { workflow } = renderWorkflow("video", { prompt: "runway", input: inputWith(names.map(img)) })
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

  it("欠槽(2 张)→ 多余 LoadImage 节点删除、引用它们的参考键也删除", () => {
    const { workflow } = renderWorkflow("video", { prompt: "x", input: inputWith([img("x.png"), img("y.png")]) })
    expect((workflow["356"] as any).inputs.image).toBe("x.png")
    expect((workflow["352"] as any).inputs.image).toBe("y.png")
    // slot 3/4 的 LoadImage 节点整节点删除
    expect(workflow["353"]).toBeUndefined()
    expect(workflow["354"]).toBeUndefined()
    const ref = (workflow["360"] as any).inputs
    expect(ref["model.reference_images.image_1"]).toEqual(["356", 0])
    expect(ref["model.reference_images.image_2"]).toEqual(["352", 0])
    // 引用被删节点的键随之断开
    expect("model.reference_images.image_3" in ref).toBe(false)
    expect("model.reference_images.image_4" in ref).toBe(false)
  })
})

describe("renderWorkflow — model3d (tripo)", () => {
  it("无参考图时走文生 3D 模板(t2model)", () => {
    const { workflow } = renderWorkflow("model3d", { prompt: "a sword", input: { workflow: "standard", seed: 7 } })
    const node = workflow["3"] as Record<string, Record<string, unknown>>
    expect(node.class_type).toBe("TripoTextToModelNode")
    expect(node.inputs.prompt).toBe("a sword")
    expect(workflow["19"]).toBeUndefined() // 无 BatchImagesNode
  })

  it("3 张 → 3 个 LoadImage 全保留、BatchImages 三键齐全", () => {
    const { workflow } = renderWorkflow("model3d", {
      prompt: "hero",
      input: inputWith([img("front.png"), img("side.png"), img("back.png")], { workflow: "game-asset" }),
    })
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

  it("欠槽(1 张)→ 其余 LoadImage 与批量键删除", () => {
    const { workflow } = renderWorkflow("model3d", { prompt: "x", input: inputWith([img("only.png")]) })
    expect((workflow["2"] as any).inputs.image).toBe("only.png")
    expect(workflow["4"]).toBeUndefined()
    expect(workflow["3"]).toBeUndefined()
    const batch = (workflow["19"] as any).inputs
    expect(batch["images.image0"]).toEqual(["2", 0])
    expect("images.image1" in batch).toBe(false)
    expect("images.image2" in batch).toBe(false)
  })
})
