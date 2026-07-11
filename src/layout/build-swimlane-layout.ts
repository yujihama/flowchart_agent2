import type { Edge, Node } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import type { FlowEdge, FlowModel, FlowNode } from "../domain/flow-model";
import type { EdgeAnchorInfo, FlowEdgeData, FlowNodeData, LaneNodeData } from "./flow-reactflow-types";
import {
  ANCHOR_PERCENTS,
  BOARD_PADDING_BOTTOM,
  CORRIDOR_MIN_HEIGHT,
  CORRIDOR_TRACK_SPACING,
  GUTTER_EDGE_MARGIN,
  GUTTER_TRACK_SPACING,
  LANE_HEADER_HEIGHT,
  LANE_SIDE_REGION,
  LANE_WIDTH,
  NODE_HEIGHT_BY_TYPE,
  NODE_TOP_PADDING,
  NODE_WIDTH_BY_TYPE,
  SIDE_ANCHOR_OFFSETS,
} from "./swimlane-constants";

export type SwimlaneLayout = {
  nodes: Array<Node<FlowNodeData | LaneNodeData>>;
  edges: Edge<FlowEdgeData>[];
};

type Point = { x: number; y: number };

/**
 * レイアウトは3段階で決定論的に行う。後段で座標を書き換えるパスは持たない。
 *   1. 配置   — レーン(列) × 行のグリッドにノードを割り当てる
 *   2. 経路   — 各エッジを「コリドー(行間の水平配線帯)」と「ガター(レーン境界の
 *               垂直配線帯)」の使用列として抽象的に決め、帯ごとにトラックを割り当てる
 *   3. 実体化 — トラック数からコリドー高さと行のY座標を確定し、折れ線座標を出力する
 * エッジ同士の平行重なりはトラック割当により構造的に発生しない。
 */
export function buildSwimlaneLayout(model: FlowModel): SwimlaneLayout {
  const placement = placeNodes(model);
  const routes = routeEdges(model, placement);
  const geometry = resolveGeometry(placement, routes);
  return emitReactFlow(model, placement, routes, geometry);
}

// ---------------------------------------------------------------------------
// 1. 配置
// ---------------------------------------------------------------------------

type PlacedNode = {
  node: FlowNode;
  laneIndex: number;
  row: number;
  width: number;
  height: number;
};

type Placement = {
  laneCount: number;
  rowCount: number;
  placedById: Map<string, PlacedNode>;
  occupiedCells: Set<string>;
};

function placeNodes(model: FlowModel): Placement {
  const laneIndexById = new Map(model.lanes.map((lane, index) => [lane.id, index]));
  const backEdgeIds = findBackEdgeIds(model);
  const depthByNodeId = calculateDepths(model, backEdgeIds);

  const nodeIndexById = new Map(model.nodes.map((node, index) => [node.id, index]));
  const sortedNodes = [...model.nodes].sort((a, b) => {
    const depthDiff = (depthByNodeId.get(a.id) ?? 0) - (depthByNodeId.get(b.id) ?? 0);
    if (depthDiff !== 0) return depthDiff;
    return (nodeIndexById.get(a.id) ?? 0) - (nodeIndexById.get(b.id) ?? 0);
  });

  const incomingForwardByTarget = new Map<string, FlowEdge[]>();
  model.edges.forEach((edge) => {
    if (backEdgeIds.has(edge.id)) return;
    const incoming = incomingForwardByTarget.get(edge.to) ?? [];
    incoming.push(edge);
    incomingForwardByTarget.set(edge.to, incoming);
  });

  const occupiedRowsByLane = new Map<number, Set<number>>();
  const rowByNodeId = new Map<string, number>();

  sortedNodes.forEach((node) => {
    const laneIndex = laneIndexById.get(node.lane_id) ?? 0;
    const occupiedRows = occupiedRowsByLane.get(laneIndex) ?? new Set<number>();
    let row = depthByNodeId.get(node.id) ?? 0;
    (incomingForwardByTarget.get(node.id) ?? []).forEach((edge) => {
      const sourceRow = rowByNodeId.get(edge.from);
      if (sourceRow !== undefined) row = Math.max(row, sourceRow + 1);
    });
    while (occupiedRows.has(row)) row += 1;
    occupiedRows.add(row);
    occupiedRowsByLane.set(laneIndex, occupiedRows);
    rowByNodeId.set(node.id, row);
  });

  const placedById = new Map<string, PlacedNode>();
  const occupiedCells = new Set<string>();
  let rowCount = 0;
  model.nodes.forEach((node) => {
    const laneIndex = laneIndexById.get(node.lane_id) ?? 0;
    const row = rowByNodeId.get(node.id) ?? 0;
    rowCount = Math.max(rowCount, row + 1);
    placedById.set(node.id, {
      node,
      laneIndex,
      row,
      width: NODE_WIDTH_BY_TYPE[node.type],
      height: NODE_HEIGHT_BY_TYPE[node.type],
    });
    occupiedCells.add(cellKey(laneIndex, row));
  });

  return { laneCount: model.lanes.length, rowCount, placedById, occupiedCells };
}

/** DFSで循環を閉じるエッジを検出する(edge_typeに依存しない構造的な判定) */
function findBackEdgeIds(model: FlowModel) {
  const outgoingByNode = new Map<string, FlowEdge[]>();
  model.edges.forEach((edge) => {
    const outgoing = outgoingByNode.get(edge.from) ?? [];
    outgoing.push(edge);
    outgoingByNode.set(edge.from, outgoing);
  });

  const backEdgeIds = new Set<string>();
  const state = new Map<string, "visiting" | "done">();

  const visit = (nodeId: string) => {
    // 反復DFS(深いフローでのスタックオーバーフローを避ける)
    const stack: Array<{ nodeId: string; edgeIndex: number }> = [{ nodeId, edgeIndex: 0 }];
    state.set(nodeId, "visiting");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const edges = outgoingByNode.get(frame.nodeId) ?? [];
      if (frame.edgeIndex >= edges.length) {
        state.set(frame.nodeId, "done");
        stack.pop();
        continue;
      }
      const edge = edges[frame.edgeIndex];
      frame.edgeIndex += 1;
      const targetState = state.get(edge.to);
      if (targetState === "visiting") {
        backEdgeIds.add(edge.id);
      } else if (targetState === undefined) {
        state.set(edge.to, "visiting");
        stack.push({ nodeId: edge.to, edgeIndex: 0 });
      }
    }
  };

  model.nodes.forEach((node) => {
    if (!state.has(node.id)) visit(node.id);
  });

  return backEdgeIds;
}

/** 逆流エッジを除いた最長経路で各ノードの深さを求める */
function calculateDepths(model: FlowModel, backEdgeIds: Set<string>) {
  const depthByNodeId = new Map(model.nodes.map((node) => [node.id, 0]));
  const forwardEdges = model.edges.filter(
    (edge) => !backEdgeIds.has(edge.id) && depthByNodeId.has(edge.from) && depthByNodeId.has(edge.to),
  );

  for (let pass = 0; pass < model.nodes.length; pass += 1) {
    let changed = false;
    forwardEdges.forEach((edge) => {
      const sourceDepth = depthByNodeId.get(edge.from) ?? 0;
      if (sourceDepth + 1 > (depthByNodeId.get(edge.to) ?? 0)) {
        depthByNodeId.set(edge.to, sourceDepth + 1);
        changed = true;
      }
    });
    if (!changed) break;
  }

  return depthByNodeId;
}

function cellKey(laneIndex: number, row: number) {
  return `${laneIndex}:${row}`;
}

// ---------------------------------------------------------------------------
// 2. 経路(抽象)
// ---------------------------------------------------------------------------

type Side = "left" | "right";

/** コリドー k は行 k と行 k+1 の間の水平帯 */
type CorridorRun = { corridor: number; x1: number; x2: number; track: number };
/** ガター g はレーン g-1 と g の境界の垂直帯。r1/r2 は行位置(row*1000+offset)で表す */
type GutterRun = { gutter: number; r1: number; r2: number; track: number };

type EdgeRoute =
  | { kind: "straight"; exitX: number }
  | {
      kind: "bottomExit";
      exitX: number;
      entryX: number;
      corridorA: CorridorRun;
      gutter?: GutterRun;
      corridorB?: CorridorRun;
    }
  | {
      kind: "sideExit";
      side: Side;
      exitY: number; // ノード中心からの相対オフセット
      entryX: number;
      gutter: GutterRun;
      corridorB?: CorridorRun;
    };

type RoutedEdge = {
  edge: FlowEdge;
  source: PlacedNode;
  target: PlacedNode;
  route: EdgeRoute;
  sourceHandle: string;
  targetHandle: string;
  sourceAnchor: EdgeAnchorInfo;
  targetAnchor: EdgeAnchorInfo;
  isDecisionBranch: boolean;
};

const ROW_MID = 500;
const ROW_CORRIDOR = 950;

function rowPos(row: number, offset: number) {
  return row * 1000 + offset;
}

function anchorPercentToSlot(percent: number) {
  if (percent === 0.3) return 1;
  if (percent === 0.7) return 2;
  return 0;
}

class TrackAllocator {
  private intervalsByBandTrack = new Map<string, Array<{ a: number; b: number }>>();
  private trackCountByBand = new Map<string, number>();

  /** 帯(band)内で [a,b] 区間が既存トラックと重ならない最小トラック番号を確保する */
  reserve(band: string, a: number, b: number) {
    const lo = Math.min(a, b) - 4;
    const hi = Math.max(a, b) + 4;
    let track = 0;
    for (;;) {
      const key = `${band}#${track}`;
      const intervals = this.intervalsByBandTrack.get(key) ?? [];
      if (intervals.every((iv) => hi <= iv.a || lo >= iv.b)) {
        intervals.push({ a: lo, b: hi });
        this.intervalsByBandTrack.set(key, intervals);
        this.trackCountByBand.set(band, Math.max(this.trackCountByBand.get(band) ?? 0, track + 1));
        return track;
      }
      track += 1;
    }
  }

  trackCount(band: string) {
    return this.trackCountByBand.get(band) ?? 0;
  }
}

type Routing = {
  routedEdges: RoutedEdge[];
  corridorTracks: TrackAllocator;
  gutterTracks: TrackAllocator;
};

function routeEdges(model: FlowModel, placement: Placement): Routing {
  const corridorTracks = new TrackAllocator();
  const gutterTracks = new TrackAllocator();
  const stubTracks = new TrackAllocator();

  const laneCenterX = (laneIndex: number) => laneIndex * LANE_WIDTH + LANE_WIDTH / 2;

  // アンカーXは「コリドー(行間の帯) × X位置」単位で一意に割り当てる。
  // 同じ帯を縦に横切るスタブ同士(上のノードの出口と下のノードへの進入)が
  // 同じXを取ると重なるため、ノード単位ではなく帯単位で衝突を防ぐ。
  const anchorRegistry = new Set<string>();
  const anchorKey = (corridorIndex: number, x: number) => `${corridorIndex}:${Math.round(x)}`;
  const registerAnchor = (corridorIndex: number, x: number) => anchorRegistry.add(anchorKey(corridorIndex, x));

  const nextAnchorX = (placed: PlacedNode, corridorIndex: number) => {
    const leftX = laneCenterX(placed.laneIndex) - placed.width / 2;
    for (let index = 0; index < ANCHOR_PERCENTS.length; index += 1) {
      const x = leftX + placed.width * ANCHOR_PERCENTS[index];
      if (!anchorRegistry.has(anchorKey(corridorIndex, x))) {
        registerAnchor(corridorIndex, x);
        return { x, slot: anchorPercentToSlot(ANCHOR_PERCENTS[index]), index };
      }
    }
    const index = ANCHOR_PERCENTS.length - 1;
    return { x: leftX + placed.width * ANCHOR_PERCENTS[index], slot: anchorPercentToSlot(ANCHOR_PERCENTS[index]), index };
  };

  // 同じ行から同じガターへ出る水平ステブ同士の重なりをYオフセットで避ける
  const nextSideOffset = (gutterIndex: number, row: number) => {
    const track = Math.min(stubTracks.reserve(`${gutterIndex}:${row}`, 0, 1), SIDE_ANCHOR_OFFSETS.length - 1);
    return { offset: SIDE_ANCHOR_OFFSETS[track], track };
  };

  // decisionノードの分岐エッジを先に振り分ける(左右の頂点と真下を使い分ける)
  const decisionExitSideByEdgeId = planDecisionExits(model, placement);

  // decisionの真下出しはひし形頂点(レーン中央)固定なので、先に帯へ登録して
  // 他ノードの進入スタブが同じXを取らないようにする
  model.edges.forEach((edge) => {
    if (decisionExitSideByEdgeId.get(edge.id) !== "bottom") return;
    const source = placement.placedById.get(edge.from);
    if (source) registerAnchor(source.row, laneCenterX(source.laneIndex));
  });

  const routedEdges: RoutedEdge[] = [];

  model.edges.forEach((flowEdge) => {
    const source = placement.placedById.get(flowEdge.from);
    const target = placement.placedById.get(flowEdge.to);
    if (!source || !target || flowEdge.from === flowEdge.to) return;

    const isDecisionBranch = decisionExitSideByEdgeId.has(flowEdge.id);
    const decisionSide = decisionExitSideByEdgeId.get(flowEdge.id);
    const forward = target.row > source.row;

    let route: EdgeRoute;
    let sourceHandle: string;
    let targetHandle: string;
    let sourceAnchor: EdgeAnchorInfo;
    let targetAnchor: EdgeAnchorInfo;

    // 同一レーンでガター迂回する経路は、始点と終点のXが一致すると迂回形状を
    // Excelコネクタで表現できなくなるため、進入アンカーをずらして確保する
    const allocateEntry = (exitX: number) => {
      const detours =
        source.laneIndex === target.laneIndex &&
        !isColumnClear(placement, source.laneIndex, source.row, target.row);
      let entry = nextAnchorX(target, target.row - 1);
      for (let retry = 0; detours && entry.x === exitX && retry < 3; retry += 1) {
        entry = nextAnchorX(target, target.row - 1);
      }
      return entry;
    };

    if (forward && decisionSide === "bottom") {
      const exit = { x: laneCenterX(source.laneIndex), slot: 0, index: 0 };
      const entry = allocateEntry(exit.x);
      const built = buildBottomExitRoute(source, target, placement, corridorTracks, gutterTracks, {
        exit,
        entry,
      });
      route = built.route;
      sourceHandle = "source-bottom-0";
      targetHandle = `target-top-${built.entrySlot}`;
      sourceAnchor = { side: "bottom", slot: 0 };
      targetAnchor = { side: "top", slot: entry.index };
    } else if (forward && !decisionSide) {
      const exit = nextAnchorX(source, source.row);
      const entry = allocateEntry(exit.x);
      const built = buildBottomExitRoute(source, target, placement, corridorTracks, gutterTracks, {
        exit,
        entry,
      });
      route = built.route;
      sourceHandle = `source-bottom-${built.exitSlot}`;
      targetHandle = `target-top-${built.entrySlot}`;
      sourceAnchor = { side: "bottom", slot: exit.index };
      targetAnchor = { side: "top", slot: entry.index };
    } else {
      // 側面出し: decisionの左右分岐、または逆流(差戻し)エッジ
      const side: Side =
        decisionSide === "left" || decisionSide === "right"
          ? decisionSide
          : sideTowardTarget(source, target);
      const gutterIndex = side === "left" ? source.laneIndex : source.laneIndex + 1;
      const entry = nextAnchorX(target, target.row - 1);
      const stub = nextSideOffset(gutterIndex, source.row);
      const corridorIndex = target.row - 1;
      const gutterTrack = gutterTracks.reserve(
        `${gutterIndex}`,
        rowPos(source.row, ROW_MID),
        rowPos(corridorIndex, ROW_CORRIDOR),
      );
      const corridorB = reserveCorridorRun(
        corridorTracks,
        corridorIndex,
        gutterCenterX(gutterIndex),
        entry.x,
        gutterCenterX(gutterIndex),
      );
      route = {
        kind: "sideExit",
        side,
        exitY: stub.offset,
        entryX: entry.x,
        gutter: { gutter: gutterIndex, r1: rowPos(source.row, ROW_MID), r2: rowPos(corridorIndex, ROW_CORRIDOR), track: gutterTrack },
        corridorB,
      };
      sourceHandle = `source-${side}-0`;
      targetHandle = `target-top-${entry.slot}`;
      sourceAnchor = { side, slot: stub.track };
      targetAnchor = { side: "top", slot: entry.index };
    }

    routedEdges.push({
      edge: flowEdge,
      source,
      target,
      route,
      sourceHandle,
      targetHandle,
      sourceAnchor,
      targetAnchor,
      isDecisionBranch,
    });
  });

  return { routedEdges, corridorTracks, gutterTracks };
}

/**
 * コリドー上の水平区間を予約する。ガター側の端点は実際のトラックX確定前なので、
 * ガター全幅分の余白を持たせて予約し、確定後の座標ズレによる重なりを防ぐ。
 */
function reserveCorridorRun(
  allocator: TrackAllocator,
  corridor: number,
  x1: number,
  x2: number,
  gutterEndpointX?: number,
): CorridorRun {
  let lo = Math.min(x1, x2);
  let hi = Math.max(x1, x2);
  if (gutterEndpointX !== undefined) {
    lo = Math.min(lo, gutterEndpointX - LANE_SIDE_REGION);
    hi = Math.max(hi, gutterEndpointX + LANE_SIDE_REGION);
  }
  const track = allocator.reserve(`${corridor}`, lo, hi);
  return { corridor, x1, x2, track };
}

function gutterCenterX(gutterIndex: number) {
  return gutterIndex * LANE_WIDTH;
}

function sideTowardTarget(source: PlacedNode, target: PlacedNode): Side {
  if (target.laneIndex < source.laneIndex) return "left";
  if (target.laneIndex > source.laneIndex) return "right";
  return "left";
}

function buildBottomExitRoute(
  source: PlacedNode,
  target: PlacedNode,
  placement: Placement,
  corridorTracks: TrackAllocator,
  gutterTracks: TrackAllocator,
  anchors: { exit: { x: number; slot: number }; entry: { x: number; slot: number } },
): { route: EdgeRoute; exitSlot: number; entrySlot: number } {
  const { exit, entry } = anchors;
  const sameLane = source.laneIndex === target.laneIndex;
  const columnClear = sameLane && isColumnClear(placement, source.laneIndex, source.row, target.row);

  if (columnClear && exit.slot === 0 && entry.slot === 0) {
    return {
      route: { kind: "straight", exitX: gutterCenterX(source.laneIndex) + LANE_WIDTH / 2 },
      exitSlot: 0,
      entrySlot: 0,
    };
  }

  const corridorAIndex = source.row;
  const corridorBIndex = target.row - 1;

  if (corridorAIndex === corridorBIndex) {
    // 1行下へ: コリドーを1本経由するだけでよい
    const corridorA = reserveCorridorRun(corridorTracks, corridorAIndex, exit.x, entry.x);
    return {
      route: { kind: "bottomExit", exitX: exit.x, entryX: entry.x, corridorA },
      exitSlot: exit.slot,
      entrySlot: entry.slot,
    };
  }

  if (columnClear) {
    // 同一レーンで途中セルが空: 自列をまっすぐ降りる(スロットずれのみコリドーで吸収)
    const corridorA = reserveCorridorRun(corridorTracks, corridorAIndex, exit.x, entry.x);
    return {
      route: { kind: "bottomExit", exitX: exit.x, entryX: entry.x, corridorA },
      exitSlot: exit.slot,
      entrySlot: entry.slot,
    };
  }

  // 複数行を跨ぐ: ターゲットレーン側のガターを垂直移動に使う
  const gutterIndex = sameLane
    ? source.laneIndex + 1
    : source.laneIndex < target.laneIndex
      ? target.laneIndex
      : target.laneIndex + 1;
  const gx = gutterCenterX(gutterIndex);
  const corridorA = reserveCorridorRun(corridorTracks, corridorAIndex, exit.x, gx, gx);
  const gutterTrack = gutterTracks.reserve(
    `${gutterIndex}`,
    rowPos(corridorAIndex, ROW_CORRIDOR),
    rowPos(corridorBIndex, ROW_CORRIDOR),
  );
  const corridorB = reserveCorridorRun(corridorTracks, corridorBIndex, gx, entry.x, gx);

  return {
    route: {
      kind: "bottomExit",
      exitX: exit.x,
      entryX: entry.x,
      corridorA,
      gutter: {
        gutter: gutterIndex,
        r1: rowPos(corridorAIndex, ROW_CORRIDOR),
        r2: rowPos(corridorBIndex, ROW_CORRIDOR),
        track: gutterTrack,
      },
      corridorB,
    },
    exitSlot: exit.slot,
    entrySlot: entry.slot,
  };
}

function isColumnClear(placement: Placement, laneIndex: number, rowA: number, rowB: number) {
  const start = Math.min(rowA, rowB) + 1;
  const end = Math.max(rowA, rowB);
  for (let row = start; row < end; row += 1) {
    if (placement.occupiedCells.has(cellKey(laneIndex, row))) return false;
  }
  return true;
}

/**
 * decisionノードの分岐先を頂点(左右)と真下に振り分ける。
 * 左レーン行き→左頂点、右レーン行き→右頂点。同一レーンの分岐は最も近い前進先を
 * 真下に、それ以外は空いている側の頂点に割り当てる。
 * 同一レーンへの前進分岐がなく片側の頂点に2本以上集中する場合は、主要な1本
 * (normal優先)を真下に逃がし、1つの頂点から複数本出るのを避ける。
 */
function planDecisionExits(model: FlowModel, placement: Placement) {
  const exitByEdgeId = new Map<string, Side | "bottom">();
  const outgoingByDecision = new Map<string, FlowEdge[]>();

  model.edges.forEach((edge) => {
    const source = placement.placedById.get(edge.from);
    if (source?.node.type !== "decision") return;
    const outgoing = outgoingByDecision.get(edge.from) ?? [];
    outgoing.push(edge);
    outgoingByDecision.set(edge.from, outgoing);
  });

  outgoingByDecision.forEach((edges, decisionId) => {
    const source = placement.placedById.get(decisionId);
    if (!source) return;

    let leftCount = 0;
    let rightCount = 0;
    let bottomTaken = false;

    // 同一レーンの前進分岐のうち最も近い行のものを真下に割り当てる
    const sameLaneForward = edges
      .filter((edge) => {
        const target = placement.placedById.get(edge.to);
        return target && target.laneIndex === source.laneIndex && target.row > source.row;
      })
      .sort((a, b) => {
        const rowA = placement.placedById.get(a.to)?.row ?? 0;
        const rowB = placement.placedById.get(b.to)?.row ?? 0;
        return rowA - rowB;
      });
    let bottomEdgeId: string | undefined = sameLaneForward[0]?.id;

    if (!bottomEdgeId) {
      bottomEdgeId = pickBottomReliefEdgeId(edges, placement, source);
    }

    edges.forEach((edge) => {
      const target = placement.placedById.get(edge.to);
      if (!target) return;
      if (edge.id === bottomEdgeId && !bottomTaken) {
        exitByEdgeId.set(edge.id, "bottom");
        bottomTaken = true;
        return;
      }
      if (target.laneIndex < source.laneIndex) {
        exitByEdgeId.set(edge.id, "left");
        leftCount += 1;
        return;
      }
      if (target.laneIndex > source.laneIndex) {
        exitByEdgeId.set(edge.id, "right");
        rightCount += 1;
        return;
      }
      // 同一レーン(2本目以降 or 逆流): 混雑していない側の頂点へ
      const side: Side = leftCount <= rightCount ? "left" : "right";
      exitByEdgeId.set(edge.id, side);
      if (side === "left") leftCount += 1;
      else rightCount += 1;
    });
  });

  return exitByEdgeId;
}

/**
 * 左右いずれかの頂点に前進分岐が2本以上集中する場合、その中の主要な1本
 * (normal優先 → 近い行優先 → 定義順)を真下出しに割り当てる。
 */
function pickBottomReliefEdgeId(edges: FlowEdge[], placement: Placement, source: PlacedNode) {
  const groups: Record<Side, FlowEdge[]> = { left: [], right: [] };
  edges.forEach((edge) => {
    const target = placement.placedById.get(edge.to);
    if (!target || target.row <= source.row) return;
    if (target.laneIndex < source.laneIndex) groups.left.push(edge);
    else if (target.laneIndex > source.laneIndex) groups.right.push(edge);
  });

  const crowded = groups.left.length >= groups.right.length ? groups.left : groups.right;
  if (crowded.length < 2) return undefined;

  const edgeIndexById = new Map(edges.map((edge, index) => [edge.id, index]));
  const ranked = [...crowded].sort((a, b) => {
    const aExceptional = a.edge_type && a.edge_type !== "normal" ? 1 : 0;
    const bExceptional = b.edge_type && b.edge_type !== "normal" ? 1 : 0;
    if (aExceptional !== bExceptional) return aExceptional - bExceptional;
    const rowDiff = (placement.placedById.get(a.to)?.row ?? 0) - (placement.placedById.get(b.to)?.row ?? 0);
    if (rowDiff !== 0) return rowDiff;
    return (edgeIndexById.get(a.id) ?? 0) - (edgeIndexById.get(b.id) ?? 0);
  });

  return ranked[0].id;
}

// ---------------------------------------------------------------------------
// 3. ジオメトリの実体化
// ---------------------------------------------------------------------------

type Geometry = {
  rowTopY: number[];
  rowHeight: number[];
  corridorTopY: number[];
  corridorHeight: number[];
  boardHeight: number;
  corridorTrackY: (run: CorridorRun) => number;
  gutterTrackX: (run: GutterRun) => number;
  nodeRect: (placed: PlacedNode) => { x: number; y: number; width: number; height: number; cx: number; cy: number };
};

function resolveGeometry(placement: Placement, routing: Routing): Geometry {
  const { rowCount } = placement;

  const rowMaxHeight: number[] = Array.from({ length: rowCount }, () => 0);
  placement.placedById.forEach((placed) => {
    rowMaxHeight[placed.row] = Math.max(rowMaxHeight[placed.row], placed.height);
  });

  const corridorHeight: number[] = Array.from({ length: Math.max(rowCount, 1) }, (_, corridor) => {
    const tracks = routing.corridorTracks.trackCount(`${corridor}`);
    return Math.max(CORRIDOR_MIN_HEIGHT, (tracks + 1) * CORRIDOR_TRACK_SPACING);
  });

  const rowTopY: number[] = [];
  const corridorTopY: number[] = [];
  let cursorY = LANE_HEADER_HEIGHT + NODE_TOP_PADDING;
  for (let row = 0; row < rowCount; row += 1) {
    rowTopY.push(cursorY);
    cursorY += rowMaxHeight[row] || NODE_HEIGHT_BY_TYPE.process;
    corridorTopY.push(cursorY);
    cursorY += corridorHeight[row] ?? CORRIDOR_MIN_HEIGHT;
  }
  const boardHeight = cursorY - (corridorHeight[rowCount - 1] ?? 0) + BOARD_PADDING_BOTTOM;

  const corridorTrackY = (run: CorridorRun) => {
    if (run.corridor < 0) {
      // 行0より上へ戻る経路: ヘッダー直下の余白帯を使う
      return LANE_HEADER_HEIGHT + (NODE_TOP_PADDING * (run.track + 1)) / (routing.corridorTracks.trackCount(`${run.corridor}`) + 1);
    }
    const top = corridorTopY[run.corridor] ?? cursorY;
    const height = corridorHeight[run.corridor] ?? CORRIDOR_MIN_HEIGHT;
    const tracks = routing.corridorTracks.trackCount(`${run.corridor}`);
    return top + (height * (run.track + 1)) / (tracks + 1);
  };

  const gutterTrackX = (run: GutterRun) => {
    const center = run.gutter * LANE_WIDTH;
    const isLeftBoundary = run.gutter === 0;
    const isRightBoundary = run.gutter === placement.laneCount;
    const maxOffset = LANE_SIDE_REGION - GUTTER_EDGE_MARGIN;
    // 境界ガターは盤面内側のみ、内部ガターは境界線の左右交互に使う
    let offset: number;
    if (isLeftBoundary) {
      offset = GUTTER_EDGE_MARGIN + run.track * GUTTER_TRACK_SPACING;
    } else if (isRightBoundary) {
      offset = -(GUTTER_EDGE_MARGIN + run.track * GUTTER_TRACK_SPACING);
    } else {
      const magnitude = Math.ceil((run.track + 1) / 2) * GUTTER_TRACK_SPACING;
      offset = run.track % 2 === 0 ? magnitude - GUTTER_TRACK_SPACING / 2 : -(magnitude - GUTTER_TRACK_SPACING / 2);
    }
    const clamped = Math.max(-maxOffset * 2 + GUTTER_EDGE_MARGIN, Math.min(maxOffset * 2 - GUTTER_EDGE_MARGIN, offset));
    return center + clamped;
  };

  const nodeRect = (placed: PlacedNode) => {
    const laneX = placed.laneIndex * LANE_WIDTH;
    const rowTop = rowTopY[placed.row] ?? LANE_HEADER_HEIGHT + NODE_TOP_PADDING;
    const rowH = rowMaxHeight[placed.row] || placed.height;
    const x = laneX + (LANE_WIDTH - placed.width) / 2;
    const y = rowTop + (rowH - placed.height) / 2;
    return { x, y, width: placed.width, height: placed.height, cx: x + placed.width / 2, cy: y + placed.height / 2 };
  };

  return {
    rowTopY,
    rowHeight: rowMaxHeight,
    corridorTopY,
    corridorHeight,
    boardHeight,
    corridorTrackY,
    gutterTrackX,
    nodeRect,
  };
}

// ---------------------------------------------------------------------------
// 4. React Flow ノード/エッジへの変換
// ---------------------------------------------------------------------------

function emitReactFlow(
  model: FlowModel,
  placement: Placement,
  routing: Routing,
  geometry: Geometry,
): SwimlaneLayout {
  const laneById = new Map(model.lanes.map((lane) => [lane.id, lane]));
  const phaseById = new Map(model.phases.map((phase) => [phase.id, phase]));

  const laneNodes: Array<Node<LaneNodeData>> = model.lanes.map((lane, index) => ({
    id: `lane-${lane.id}`,
    type: "laneNode",
    position: { x: index * LANE_WIDTH, y: 0 },
    width: LANE_WIDTH,
    height: geometry.boardHeight,
    data: {
      kind: "lane",
      lane,
      laneIndex: index,
      height: geometry.boardHeight,
      width: LANE_WIDTH,
    },
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -10,
    style: { width: LANE_WIDTH, height: geometry.boardHeight },
  }));

  const flowNodes: Array<Node<FlowNodeData>> = model.nodes.map((flowNode) => {
    const placed = placement.placedById.get(flowNode.id);
    const rect = placed ? geometry.nodeRect(placed) : { x: 0, y: 0, width: 190, height: 86 };
    return {
      id: flowNode.id,
      type: reactFlowNodeType(flowNode.type),
      position: { x: rect.x, y: rect.y },
      width: rect.width,
      height: rect.height,
      draggable: false,
      data: {
        kind: "flow",
        node: flowNode,
        laneName: laneById.get(flowNode.lane_id)?.name ?? flowNode.lane_id,
        phaseName: phaseById.get(flowNode.phase_id)?.name ?? flowNode.phase_id,
      },
      zIndex: 10,
    };
  });

  const edges: Edge<FlowEdgeData>[] = routing.routedEdges.map((routed) => {
    const { points, labelPoint } = emitEdgeGeometry(routed, geometry);
    const flowEdge = routed.edge;
    const color = edgeColor(flowEdge.edge_type);
    return {
      id: flowEdge.id,
      source: flowEdge.from,
      target: flowEdge.to,
      sourceHandle: routed.sourceHandle,
      targetHandle: routed.targetHandle,
      type: "swimlaneRoutedEdge",
      label: flowEdge.label ?? flowEdge.condition?.text,
      data: {
        edge: flowEdge,
        routePath: points,
        labelPoint,
        sourceAnchor: routed.sourceAnchor,
        targetAnchor: routed.targetAnchor,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: {
        stroke: color,
        strokeWidth: flowEdge.edge_type === "rollback" || flowEdge.edge_type === "exception" ? 2.4 : 2,
        strokeDasharray: flowEdge.edge_type === "rollback" ? "7 5" : undefined,
      },
    };
  });

  return { nodes: [...laneNodes, ...flowNodes], edges };
}

function emitEdgeGeometry(routed: RoutedEdge, geometry: Geometry): { points: Point[]; labelPoint: Point } {
  const source = geometry.nodeRect(routed.source);
  const target = geometry.nodeRect(routed.target);
  const route = routed.route;

  if (route.kind === "straight") {
    const points = [
      { x: source.cx, y: source.y + source.height },
      { x: target.cx, y: target.y },
    ];
    return { points, labelPoint: nearSourceLabelPoint(points, routed) };
  }

  if (route.kind === "bottomExit") {
    const startY = source.y + source.height;
    const endY = target.y;
    const trackAY = geometry.corridorTrackY(route.corridorA);
    const points: Point[] = [{ x: route.exitX, y: startY }, { x: route.exitX, y: trackAY }];
    if (route.gutter && route.corridorB) {
      const gx = geometry.gutterTrackX(route.gutter);
      const trackBY = geometry.corridorTrackY(route.corridorB);
      points.push({ x: gx, y: trackAY }, { x: gx, y: trackBY }, { x: route.entryX, y: trackBY });
    } else {
      points.push({ x: route.entryX, y: trackAY });
    }
    points.push({ x: route.entryX, y: endY });
    const compacted = compactPoints(points);
    return { points: compacted, labelPoint: nearSourceLabelPoint(compacted, routed) };
  }

  // sideExit
  const exitY = source.cy + route.exitY;
  const exitX = route.side === "left" ? source.x : source.x + source.width;
  const gx = geometry.gutterTrackX(route.gutter);
  const points: Point[] = [{ x: exitX, y: exitY }, { x: gx, y: exitY }];
  if (route.corridorB) {
    const trackBY = geometry.corridorTrackY(route.corridorB);
    points.push({ x: gx, y: trackBY }, { x: route.entryX, y: trackBY });
  }
  points.push({ x: route.entryX, y: target.y });
  const compacted = compactPoints(points);
  return { points: compacted, labelPoint: nearSourceLabelPoint(compacted, routed) };
}

/**
 * ラベルは出発点に近い最初の十分長いセグメントに置く(分岐ラベルが判断ノードの
 * すぐ近くに来るようにする)。ラベルの無いエッジでも安全な座標を返す。
 */
function nearSourceLabelPoint(points: Point[], routed: RoutedEdge): Point {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };

  if (routed.isDecisionBranch) {
    const first = points[0];
    const second = points[1];
    const isHorizontal = first.y === second.y;
    if (isHorizontal) {
      // 頂点からの水平ステブ中央
      return { x: (first.x + second.x) / 2, y: first.y - 10 };
    }
    // 真下/下出し: 出口のすぐ下
    return { x: first.x, y: first.y + 16 };
  }

  // 最長セグメントの中点
  let bestIndex = 0;
  let bestLength = -1;
  for (let index = 0; index < points.length - 1; index += 1) {
    const length = Math.abs(points[index].x - points[index + 1].x) + Math.abs(points[index].y - points[index + 1].y);
    if (length > bestLength) {
      bestIndex = index;
      bestLength = length;
    }
  }
  const a = points[bestIndex];
  const b = points[bestIndex + 1];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function compactPoints(points: Point[]) {
  const deduped = points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
  return deduped.filter((point, index) => {
    const previous = deduped[index - 1];
    const next = deduped[index + 1];
    if (!previous || !next) return true;
    const vertical = previous.x === point.x && point.x === next.x;
    const horizontal = previous.y === point.y && point.y === next.y;
    return !vertical && !horizontal;
  });
}

function reactFlowNodeType(type: FlowNode["type"]) {
  if (type === "start") return "startNode";
  if (type === "end") return "endNode";
  if (type === "decision") return "decisionNode";
  return "processNode";
}

function edgeColor(edgeType: FlowEdge["edge_type"]) {
  if (edgeType === "rollback") return "#d94841";
  if (edgeType === "exception") return "#b26a00";
  if (edgeType === "escalation") return "#6f4bb2";
  return "#2f6f8f";
}
