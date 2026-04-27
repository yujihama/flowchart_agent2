import type { FlowEdge, FlowModel, FlowNode } from "./flow-model";

export type ValidationIssue = {
  level: "error" | "warning";
  path: string;
  message: string;
};

export type ValidationResult = {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  issues: ValidationIssue[];
};

const NODE_TYPES = new Set(["start", "end", "process", "decision", "document", "system_process"]);
const LANE_TYPES = new Set(["department", "role", "system", "external_party"]);
const EDGE_TYPES = new Set(["normal", "rollback", "exception", "escalation"]);

export function validateFlowModel(model: FlowModel): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (level: ValidationIssue["level"], path: string, message: string) => {
    issues.push({ level, path, message });
  };

  if (!isNonEmptyString(model.schema_version)) add("error", "schema_version", "schema_version は必須です");
  if (!isNonEmptyString(model.flow_id)) add("error", "flow_id", "flow_id は必須です");
  if (!isNonEmptyString(model.title)) add("error", "title", "title は必須です");

  assertArray(model.lanes, "lanes", add);
  assertArray(model.phases, "phases", add);
  assertArray(model.nodes, "nodes", add);
  assertArray(model.edges, "edges", add);

  const lanes = Array.isArray(model.lanes) ? model.lanes : [];
  const phases = Array.isArray(model.phases) ? model.phases : [];
  const nodes = Array.isArray(model.nodes) ? model.nodes : [];
  const edges = Array.isArray(model.edges) ? model.edges : [];
  const sources = Array.isArray(model.sources) ? model.sources : [];

  checkDuplicates(lanes, "lanes", add);
  checkDuplicates(phases, "phases", add);
  checkDuplicates(nodes, "nodes", add);
  checkDuplicates(edges, "edges", add);
  checkDuplicates(sources, "sources", add);

  const laneIds = new Set(lanes.map((lane) => lane.id));
  const phaseIds = new Set(phases.map((phase) => phase.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const sourceIds = new Set(sources.map((source) => source.id));

  lanes.forEach((lane, index) => {
    if (!isNonEmptyString(lane.id)) add("error", `lanes[${index}].id`, "レーンIDは必須です");
    if (!isNonEmptyString(lane.name)) add("error", `lanes[${index}].name`, "レーン名は必須です");
    if (!LANE_TYPES.has(lane.type)) add("error", `lanes[${index}].type`, `未知のレーン種別です: ${lane.type}`);
  });

  phases.forEach((phase, index) => {
    if (!isNonEmptyString(phase.id)) add("error", `phases[${index}].id`, "フェーズIDは必須です");
    if (!isNonEmptyString(phase.name)) add("error", `phases[${index}].name`, "フェーズ名は必須です");
  });

  nodes.forEach((node, index) => {
    validateNode(node, index, laneIds, phaseIds, sourceIds, add);
  });

  edges.forEach((edge, index) => {
    validateEdge(edge, index, nodeIds, sourceIds, add);
  });

  const startCount = nodes.filter((node) => node.type === "start").length;
  const endCount = nodes.filter((node) => node.type === "end").length;
  if (startCount === 0) add("error", "nodes", "start ノードが少なくとも1つ必要です");
  if (endCount === 0) add("warning", "nodes", "end ノードを少なくとも1つ置くことを推奨します");

  const outgoingByNode = groupEdgesByFrom(edges);
  const connectedNodeIds = new Set(edges.flatMap((edge) => [edge.from, edge.to]));

  nodes.forEach((node) => {
    const outgoing = outgoingByNode.get(node.id) ?? [];
    if (node.type === "decision") {
      if (outgoing.length < 2) {
        add("warning", `nodes.${node.id}`, "decision ノードから出るエッジは2本以上を推奨します");
      }
      const labels = outgoing.map((edge) => edge.label?.trim()).filter(Boolean) as string[];
      outgoing.forEach((edge) => {
        if (!edge.label?.trim()) {
          add("warning", `edges.${edge.id}.label`, "decision ノードの出力エッジには label を付けることを推奨します");
        }
      });
      const duplicatedLabels = findDuplicates(labels);
      duplicatedLabels.forEach((label) => {
        add("warning", `nodes.${node.id}`, `同一 decision から重複した edge label が出ています: ${label}`);
      });
    }

    if (!connectedNodeIds.has(node.id) && nodes.length > 1) {
      add("warning", `nodes.${node.id}`, "孤立ノードです");
    }
    if (node.label.length > 40) {
      add("warning", `nodes.${node.id}.label`, "node.label は40文字以内を推奨します");
    }
  });

  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    issues,
  };
}

function validateNode(
  node: FlowNode,
  index: number,
  laneIds: Set<string>,
  phaseIds: Set<string>,
  sourceIds: Set<string>,
  add: (level: ValidationIssue["level"], path: string, message: string) => void,
) {
  if (!isNonEmptyString(node.id)) add("error", `nodes[${index}].id`, "ノードIDは必須です");
  if (!NODE_TYPES.has(node.type)) add("error", `nodes[${index}].type`, `未知のノード種別です: ${node.type}`);
  if (!isNonEmptyString(node.label)) add("error", `nodes[${index}].label`, "ノード label は必須です");
  if (!laneIds.has(node.lane_id)) add("error", `nodes[${index}].lane_id`, `存在しない lane_id です: ${node.lane_id}`);
  if (!phaseIds.has(node.phase_id)) add("error", `nodes[${index}].phase_id`, `存在しない phase_id です: ${node.phase_id}`);
  checkSourceRefs(node.source_refs, sourceIds, `nodes[${index}].source_refs`, add);
}

function validateEdge(
  edge: FlowEdge,
  index: number,
  nodeIds: Set<string>,
  sourceIds: Set<string>,
  add: (level: ValidationIssue["level"], path: string, message: string) => void,
) {
  if (!isNonEmptyString(edge.id)) add("error", `edges[${index}].id`, "エッジIDは必須です");
  if (!nodeIds.has(edge.from)) add("error", `edges[${index}].from`, `存在しない from ノードです: ${edge.from}`);
  if (!nodeIds.has(edge.to)) add("error", `edges[${index}].to`, `存在しない to ノードです: ${edge.to}`);
  if (edge.edge_type && !EDGE_TYPES.has(edge.edge_type)) {
    add("error", `edges[${index}].edge_type`, `未知の edge_type です: ${edge.edge_type}`);
  }
  if (edge.condition && !isNonEmptyString(edge.condition.text)) {
    add("warning", `edges[${index}].condition.text`, "condition.text は UI 表示向けに設定することを推奨します");
  }
  checkSourceRefs(edge.source_refs, sourceIds, `edges[${index}].source_refs`, add);
}

function assertArray(
  value: unknown,
  path: string,
  add: (level: ValidationIssue["level"], path: string, message: string) => void,
) {
  if (!Array.isArray(value)) add("error", path, `${path} は配列である必要があります`);
}

function checkDuplicates<T extends { id: string }>(
  items: T[],
  path: string,
  add: (level: ValidationIssue["level"], path: string, message: string) => void,
) {
  findDuplicates(items.map((item) => item.id)).forEach((id) => {
    add("error", path, `IDが重複しています: ${id}`);
  });
}

function checkSourceRefs(
  refs: string[] | undefined,
  sourceIds: Set<string>,
  path: string,
  add: (level: ValidationIssue["level"], path: string, message: string) => void,
) {
  if (!refs) return;
  refs.forEach((ref) => {
    if (!sourceIds.has(ref)) add("error", path, `存在しない source_refs です: ${ref}`);
  });
}

function findDuplicates(values: string[]) {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  values.forEach((value) => {
    if (seen.has(value)) duplicated.add(value);
    seen.add(value);
  });
  return Array.from(duplicated);
}

function groupEdgesByFrom(edges: FlowEdge[]) {
  const grouped = new Map<string, FlowEdge[]>();
  edges.forEach((edge) => {
    grouped.set(edge.from, [...(grouped.get(edge.from) ?? []), edge]);
  });
  return grouped;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
