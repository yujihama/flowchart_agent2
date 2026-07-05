import type { FlowEdge, FlowNode, Lane, Phase } from "../domain/flow-model";

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

export type PhaseBandData = {
  kind: "phaseBand";
  phase: Phase;
  bandIndex: number;
  width: number;
  height: number;
  showBoundary: boolean;
};

export type FlowEdgeData = {
  edge: FlowEdge;
  routePath?: Array<{ x: number; y: number }>;
  labelPoint?: { x: number; y: number };
  skipHorizontalOverlapResolve?: boolean;
};
