import type { FlowNode } from "../domain/flow-model";

export const LANE_WIDTH = 420;
export const LANE_HEADER_HEIGHT = 62;
export const NODE_TOP_PADDING = 34;
export const BOARD_PADDING_BOTTOM = 70;
export const HANDLE_SLOT_COUNT = 3;

/** 行間コリドー(水平配線帯)の設定 */
export const CORRIDOR_MIN_HEIGHT = 44;
export const CORRIDOR_TRACK_SPACING = 16;

/** レーン境界ガター(垂直配線帯)の設定 */
export const GUTTER_TRACK_SPACING = 15;
export const GUTTER_EDGE_MARGIN = 12;

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

/** レーン内でノード列の左右に確保される配線余白(最も広いノード基準) */
export const LANE_SIDE_REGION = (LANE_WIDTH - Math.max(...Object.values(NODE_WIDTH_BY_TYPE))) / 2;

/**
 * ノード上下辺のアンカーX位置(中央→左→右→内側の順)。
 * Excel出力のカスタム接続点もこの並びで定義するため、順序を変えないこと。
 */
export const ANCHOR_PERCENTS = [0.5, 0.3, 0.7, 0.4, 0.6] as const;

/** ノード左右辺のアンカーY(中心からのpxオフセット、スロット順) */
export const SIDE_ANCHOR_OFFSETS = [0, -11, 11, -22, 22] as const;
