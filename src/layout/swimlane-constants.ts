import type { FlowNode } from "../domain/flow-model";

export const LANE_WIDTH = 420;
export const LANE_HEADER_HEIGHT = 62;
export const ROW_HEIGHT = 150;
export const NODE_TOP_PADDING = 30;
export const BOARD_PADDING_BOTTOM = 90;
export const HANDLE_SLOT_COUNT = 3;

export const LANE_PALETTE = [
  { fill: "#eef7fb", header: "#d9eef6", accent: "#2f6f8f", chip: "#c8e4ee" },
  { fill: "#f5f1fb", header: "#e7dcf4", accent: "#7654a6", chip: "#dac9ee" },
  { fill: "#f7f4e8", header: "#ebe2bd", accent: "#9d6d1f", chip: "#e2d39c" },
  { fill: "#edf8f2", header: "#d5eedf", accent: "#2f8f6f", chip: "#c0e2ce" },
  { fill: "#fbf1ef", header: "#f2d9d4", accent: "#b55345", chip: "#e7c3bd" },
] as const;

export const NODE_WIDTH_BY_TYPE: Record<FlowNode["type"], number> = {
  start: 124,
  end: 124,
  process: 190,
  decision: 225,
  document: 190,
  system_process: 190,
};

export const NODE_HEIGHT_BY_TYPE: Record<FlowNode["type"], number> = {
  start: 54,
  end: 54,
  process: 86,
  decision: 92,
  document: 86,
  system_process: 86,
};
