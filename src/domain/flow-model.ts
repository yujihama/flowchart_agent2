export type LaneType = "department" | "role" | "system" | "external_party";

export type Lane = {
  id: string;
  name: string;
  type: LaneType;
};

export type Phase = {
  id: string;
  name: string;
};

export type NodeType =
  | "start"
  | "end"
  | "process"
  | "decision"
  | "document"
  | "system_process";

export type Condition =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "threshold";
      field: string;
      operator: ">=" | ">" | "<=" | "<" | "==" | "!=";
      value: number | string;
      unit?: string;
      text: string;
    }
  | {
      type: "and" | "or";
      conditions: Condition[];
      text: string;
    };

export type FlowNode = {
  id: string;
  type: NodeType;
  label: string;
  lane_id: string;
  phase_id: string;
  description?: string;
  source_refs?: string[];
};

export type EdgeType = "normal" | "rollback" | "exception" | "escalation";

export type FlowEdge = {
  id: string;
  from: string;
  to: string;
  label?: string;
  edge_type?: EdgeType;
  condition?: Condition;
  source_refs?: string[];
};

export type SourceRef = {
  id: string;
  file_name: string;
  page?: number;
  section?: string;
  quote?: string;
};

export type FlowModel = {
  schema_version: string;
  flow_id: string;
  title: string;
  description?: string;
  lanes: Lane[];
  phases: Phase[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  sources?: SourceRef[];
};
