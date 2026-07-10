import type { FlowEdge, FlowNode, Lane } from "../domain/flow-model";

export type FlowNodeData = {
  kind: "flow";
  node: FlowNode;
  laneName: string;
  phaseName: string;
};

export type LaneNodeData = {
  kind: "lane";
  lane: Lane;
  laneIndex: number;
  height: number;
  width?: number;
};

/** エッジ端点の接続位置(Excel出力でカスタム接続点を選ぶために使う) */
export type EdgeAnchorInfo = {
  side: "top" | "bottom" | "left" | "right";
  slot: number;
};

export type FlowEdgeData = {
  edge: FlowEdge;
  routePath?: Array<{ x: number; y: number }>;
  labelPoint?: { x: number; y: number };
  sourceAnchor?: EdgeAnchorInfo;
  targetAnchor?: EdgeAnchorInfo;
};
