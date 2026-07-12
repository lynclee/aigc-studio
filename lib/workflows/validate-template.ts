import type { AigcKind } from "@/lib/aigc/types"
import { isRecord } from "@/lib/aigc/http"

export type WorkflowTemplateFormat = "wrapped" | "graph"

export type WorkflowTemplateSpec = {
  id: string
  kind: AigcKind
  format: WorkflowTemplateFormat
  placeholders: readonly string[]
  referencePlaceholders?: readonly string[]
  primaryOutputs: readonly { classType: string; input: string }[]
}

export class WorkflowTemplateValidationError extends Error {
  readonly code = "invalid_workflow_template"

  constructor(
    readonly workflowId: string,
    detail: string,
  ) {
    super(`${workflowId}: ${detail}`)
  }
}

export function validateWorkflowTemplate(template: unknown, spec: WorkflowTemplateSpec): void {
  const graph = graphFromTemplate(template, spec)
  const nodeIds = new Set(Object.keys(graph))
  if (nodeIds.size === 0) fail(spec, "workflow graph is empty")

  const foundPlaceholders = new Map<string, number>()
  const referenceNodes = new Map<string, string>()
  const connectionsByNode = new Map<string, Set<string>>()
  const primaryNodeIds = new Set<string>()

  for (const [nodeId, rawNode] of Object.entries(graph)) {
    if (!nodeId) fail(spec, "workflow contains an empty node id")
    if (!isRecord(rawNode)) fail(spec, `node '${nodeId}' must be an object`)
    const classType = typeof rawNode.class_type === "string" ? rawNode.class_type.trim() : ""
    if (!classType) fail(spec, `node '${nodeId}' is missing class_type`)
    if (!isRecord(rawNode.inputs)) fail(spec, `node '${nodeId}' is missing inputs`)
    collectPlaceholders(rawNode.inputs, foundPlaceholders)
    const image = rawNode.inputs.image
    if (classType === "LoadImage" && typeof image === "string") {
      const exact = image.match(/^\{\{([A-Z0-9_]+)\}\}$/)
      if (exact?.[1]?.startsWith("REFERENCE_IMAGE")) {
        if (referenceNodes.has(exact[1])) fail(spec, `reference placeholder '${exact[1]}' is duplicated`)
        referenceNodes.set(exact[1], nodeId)
      }
    }
    const upstream = new Set<string>()
    collectConnections(rawNode.inputs, nodeIds, upstream, spec, nodeId)
    connectionsByNode.set(nodeId, upstream)
    for (const output of spec.primaryOutputs) {
      if (classType !== output.classType) continue
      const connection = parseConnection(rawNode.inputs[output.input])
      if (!connection || !nodeIds.has(connection[0])) {
        fail(spec, `primary output '${nodeId}' has no connected '${output.input}' input`)
      }
      primaryNodeIds.add(nodeId)
    }
  }

  if (primaryNodeIds.size === 0) {
    fail(spec, `missing primary output node (${spec.primaryOutputs.map((v) => v.classType).join(" or ")})`)
  }

  const expected = new Set(spec.placeholders)
  for (const placeholder of foundPlaceholders.keys()) {
    if (!expected.has(placeholder)) fail(spec, `unknown placeholder '{{${placeholder}}}'`)
  }
  for (const placeholder of expected) {
    if (!foundPlaceholders.has(placeholder)) fail(spec, `required placeholder '{{${placeholder}}}' is missing`)
  }

  const expectedReferences = spec.referencePlaceholders ?? []
  if (referenceNodes.size !== expectedReferences.length) {
    fail(spec, `expected ${expectedReferences.length} reference image slots, found ${referenceNodes.size}`)
  }
  for (const placeholder of expectedReferences) {
    const nodeId = referenceNodes.get(placeholder)
    if (!nodeId) fail(spec, `reference slot '{{${placeholder}}}' is missing from a LoadImage node`)
    if (foundPlaceholders.get(placeholder) !== 1) {
      fail(spec, `reference slot '{{${placeholder}}}' must appear exactly once in LoadImage.inputs.image`)
    }
    if (!isReachableFromPrimary(nodeId, primaryNodeIds, connectionsByNode)) {
      fail(spec, `reference slot '{{${placeholder}}}' is not upstream of a primary output`)
    }
  }
}

function graphFromTemplate(
  template: unknown,
  spec: WorkflowTemplateSpec,
): Record<string, unknown> {
  if (spec.format === "graph") {
    if (!isRecord(template)) fail(spec, "raw workflow template must be an object")
    return template
  }
  if (!isRecord(template) || !isRecord(template.input) || !isRecord(template.input.workflow)) {
    fail(spec, "wrapped workflow template must contain input.workflow")
  }
  return template.input.workflow
}

function collectPlaceholders(value: unknown, found: Map<string, number>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) {
      found.set(match[1], (found.get(match[1]) ?? 0) + 1)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, found)
    return
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectPlaceholders(item, found)
  }
}

function collectConnections(
  value: unknown,
  nodeIds: Set<string>,
  referencedNodeIds: Set<string>,
  spec: WorkflowTemplateSpec,
  ownerNodeId: string,
): void {
  if (Array.isArray(value)) {
    const connection = parseConnection(value)
    if (connection) {
      const upstream = connection[0]
      if (!nodeIds.has(upstream)) fail(spec, `node '${ownerNodeId}' references missing node '${upstream}'`)
      if (connection[1] < 0) fail(spec, `node '${ownerNodeId}' uses a negative output index`)
      referencedNodeIds.add(upstream)
      return
    }
    for (const item of value) collectConnections(item, nodeIds, referencedNodeIds, spec, ownerNodeId)
    return
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectConnections(item, nodeIds, referencedNodeIds, spec, ownerNodeId)
  }
}

function parseConnection(value: unknown): [string, number] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !/^\d+(?::\d+)*$/.test(value[0]) ||
    !Number.isInteger(value[1])
  ) return null
  return [value[0], value[1] as number]
}

function isReachableFromPrimary(
  target: string,
  primaryNodeIds: Set<string>,
  connectionsByNode: Map<string, Set<string>>,
): boolean {
  const pending = [...primaryNodeIds]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const nodeId = pending.pop() as string
    if (nodeId === target) return true
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    for (const upstream of connectionsByNode.get(nodeId) ?? []) pending.push(upstream)
  }
  return false
}

function fail(spec: WorkflowTemplateSpec, detail: string): never {
  throw new WorkflowTemplateValidationError(spec.id, detail)
}
