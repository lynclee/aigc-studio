import type { AigcKind, SubmitRequest } from "@/lib/aigc/types"

export class JobInputError extends Error {
  readonly status = 400
}

const ALLOWED_WORKFLOWS: Record<AigcKind, readonly string[]> = {
  image: ["standard", "detail"],
  model3d: ["standard", "game-asset"],
  video: ["standard"],
}

export function sanitizeSubmitRequest(
  body: Record<string, unknown>,
  kind: AigcKind,
  userId: string,
): SubmitRequest {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
  if (prompt.length < 1) throw new JobInputError("prompt_required")
  if (prompt.length > 4000) throw new JobInputError("prompt_too_long")

  const workflow = typeof body.workflow === "string" ? body.workflow.trim() : "standard"
  if (!ALLOWED_WORKFLOWS[kind].includes(workflow)) {
    throw new JobInputError(
      `unsupported_workflow: ${kind} accepts ${ALLOWED_WORKFLOWS[kind].join(", ")}`,
    )
  }

  return {
    prompt,
    workflowId: workflow,
    input: { workflow },
    userId,
  }
}
