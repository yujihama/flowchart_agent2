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

/** コリドー k は行 k と行 k+1 の間の水平帯。lo/hi は予約時の余白込み区間 */
type CorridorRun = { corridor: number; x1: number; x2: number; track: number; lo?: number; hi?: number };
/** ガター g はレーン g-1 と g の境界の垂直帯。r1/r2 は行位置(row*1000+offset)で表す。
 * offsetX は並べ替え後の境界中心からの実オフセット(設定時はtrackより優先) */
type GutterRun = { gutter: number; r1: number; r2: number; track: number; offsetX?: number };

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
      gutter: GutterRun;
      /** 上辺進入時のみ: 進入X座標と直前コリドー */
      entryX?: number;
      corridorB?: CorridorRun;
      /** 側辺進入時のみ: 進入する辺とノード中心からのYオフセット */
      entrySide?: Side;
      entryY?: number;
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

  /** 帯内で [a,b] 区間と重なる既存予約の数(混雑度の見積もりに使う) */
  overlapCount(band: string, a: number, b: number) {
    const lo = Math.min(a, b) - 4;
    const hi = Math.max(a, b) + 4;
    let count = 0;
    this.intervalsByBandTrack.forEach((intervals, key) => {
      if (!key.startsWith(`${band}#`)) return;
      intervals.forEach((interval) => {
        if (hi > interval.a && lo < interval.b) count += 1;
      });
    });
    return count;
  }
}

/** ジオメトリ確定に必要なのはトラック数だけなので、並べ替え後の値を差し替えられるようにする */
type TrackCounts = { trackCount(band: string): number };

type Routing = {
  routedEdges: RoutedEdge[];
  corridorTracks: TrackCounts;
  gutterTracks: TrackCounts;
};

type TopAnchor = { x: number; slot: number; index: number };

type BottomPlan =
  | { kind: "aligned" }
  | { kind: "direct" }
  | { kind: "viaGutter"; gutterIndex: number; sameLane: boolean };

/** 経路計画済みエッジ。1パス目(計画)の結果を保持し、2パス目(アンカー割当)と3パス目(構築)で使う */
type PlannedEdge = {
  flowEdge: FlowEdge;
  source: PlacedNode;
  target: PlacedNode;
  isDecisionBranch: boolean;
  shape:
    | { kind: "bottom"; plan: BottomPlan; gutter?: GutterRun; decisionBottom: boolean }
    | { kind: "sideTop"; side: Side; gutter: GutterRun; stubOffset: number; stubSlot: number }
    | {
        kind: "sideSide";
        side: Side;
        gutter: GutterRun;
        stubOffset: number;
        stubSlot: number;
        entrySide: Side;
        entryOffset: number;
        entrySlot: number;
      };
};

/**
 * ノードの一辺(上辺/下辺)に接続する1本分または合流1束分のアンカー要求。
 * role はコリドー帯内でそのXの上半分(up: 出口スタブ)と下半分(down: 進入降下)の
 * どちらを使うか。ownerTag は同一トランク(down: ターゲットID)や自身(up: エッジID)の
 * 再利用判定に使う。feedX/feedUp は反対端の接続位置と方向(帯の上から来るか)で、
 * 同じ辺に付く束同士の交差予測に使う。
 */
type AnchorRequest = {
  role: "up" | "down";
  ownerTag: string;
  /** 合流束の種別(エッジ種)。異種同士のアンカー共有は最終手段としてコストを上げる */
  mergeTag?: string;
  approachX: number;
  ideal: number;
  avoidX?: number;
  edgeIds: string[];
  /** 反対端の接続(合流束は複数)。交差予測に使う */
  feeds: Array<{ x: number; up: boolean }>;
};

/**
 * 「before[i] = iより先に置くべき要素」の制約下で全要素の順序を決める。
 * 強連結成分(循環)に縮約して成分間の制約は必ず守り、循環内のみ
 * 「未充足制約が最少」の貪欲で壊す制約を最小化する。
 */
function orderWithConstraints(
  count: number,
  before: Array<Set<number>>,
  orderKey: (i: number) => number,
  weight: (i: number, j: number) => number = () => 1,
): number[] {
  // Tarjan SCC
  const indexOf = new Array<number>(count).fill(-1);
  const lowOf = new Array<number>(count).fill(0);
  const onStack = new Array<boolean>(count).fill(false);
  const stack: number[] = [];
  const componentOf = new Array<number>(count).fill(-1);
  let nextIndex = 0;
  let componentCount = 0;
  const successors = (i: number) => {
    // before[j] ∋ i なら i→j (iが先)
    const out: number[] = [];
    for (let j = 0; j < count; j += 1) if (j !== i && before[j].has(i)) out.push(j);
    return out;
  };
  const visit = (root: number) => {
    const frames: Array<{ node: number; iter: number[]; at: number }> = [
      { node: root, iter: successors(root), at: 0 },
    ];
    indexOf[root] = lowOf[root] = nextIndex;
    nextIndex += 1;
    stack.push(root);
    onStack[root] = true;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.at < frame.iter.length) {
        const next = frame.iter[frame.at];
        frame.at += 1;
        if (indexOf[next] === -1) {
          indexOf[next] = lowOf[next] = nextIndex;
          nextIndex += 1;
          stack.push(next);
          onStack[next] = true;
          frames.push({ node: next, iter: successors(next), at: 0 });
        } else if (onStack[next]) {
          lowOf[frame.node] = Math.min(lowOf[frame.node], indexOf[next]);
        }
      } else {
        frames.pop();
        if (frames.length > 0) {
          const parent = frames[frames.length - 1];
          lowOf[parent.node] = Math.min(lowOf[parent.node], lowOf[frame.node]);
        }
        if (lowOf[frame.node] === indexOf[frame.node]) {
          for (;;) {
            const member = stack.pop()!;
            onStack[member] = false;
            componentOf[member] = componentCount;
            if (member === frame.node) break;
          }
          componentCount += 1;
        }
      }
    }
  };
  for (let i = 0; i < count; i += 1) if (indexOf[i] === -1) visit(i);

  // 成分DAGをトポ順に、成分内は未充足最少の貪欲で
  const membersByComponent = new Map<number, number[]>();
  for (let i = 0; i < count; i += 1) {
    const list = membersByComponent.get(componentOf[i]) ?? [];
    list.push(i);
    membersByComponent.set(componentOf[i], list);
  }
  const componentPending = new Set<number>(membersByComponent.keys());
  const result: number[] = [];
  while (componentPending.size > 0) {
    const ready = [...componentPending].filter((component) =>
      (membersByComponent.get(component) ?? []).every((i) =>
        [...before[i]].every((j) => componentOf[j] === component || !componentPending.has(componentOf[j])),
      ),
    );
    const pool = ready.length > 0 ? ready : [...componentPending];
    const pickComponent = pool.sort(
      (a, b) =>
        Math.min(...membersByComponent.get(a)!.map(orderKey)) - Math.min(...membersByComponent.get(b)!.map(orderKey)),
    )[0];
    componentPending.delete(pickComponent);
    const memberPending = new Set(membersByComponent.get(pickComponent)!);
    const memberOrder: number[] = [];
    while (memberPending.size > 0) {
      const unmet = (i: number) => [...before[i]].filter((j) => memberPending.has(j)).reduce((sum, j) => sum + weight(i, j), 0);
      const pick = [...memberPending].sort((a, b) => unmet(a) - unmet(b) || orderKey(a) - orderKey(b))[0];
      memberPending.delete(pick);
      memberOrder.push(pick);
    }
    // 循環内で壊れた制約を隣接交換で修復する(改善がなくなるまで)。重い制約
    // (同一始点・終点ペアの交差=仕様の必須ルール)を優先して守る
    const violatedCount = (order: number[]) => {
      const position = new Map(order.map((v, index) => [v, index]));
      let count = 0;
      order.forEach((i) => {
        before[i].forEach((j) => {
          if (position.get(j)! > position.get(i)!) count += weight(i, j);
        });
      });
      return count;
    };
    let improved = true;
    while (improved) {
      improved = false;
      for (let k = 0; k + 1 < memberOrder.length; k += 1) {
        const current = violatedCount(memberOrder);
        [memberOrder[k], memberOrder[k + 1]] = [memberOrder[k + 1], memberOrder[k]];
        if (violatedCount(memberOrder) < current) {
          improved = true;
        } else {
          [memberOrder[k], memberOrder[k + 1]] = [memberOrder[k + 1], memberOrder[k]];
        }
      }
    }
    result.push(...memberOrder);
  }
  return result;
}

/** 上辺進入・下辺退出を中央に限定するノード種(ひし形の傾斜辺・端子の角丸部に接続点を置かない) */
function isCenterOnlyNode(type: FlowNode["type"]) {
  return type === "decision" || type === "start" || type === "end";
}

function routeEdges(model: FlowModel, placement: Placement): Routing {
  const corridorTracks = new TrackAllocator();
  const gutterTracks = new TrackAllocator();

  const laneCenterX = (laneIndex: number) => laneIndex * LANE_WIDTH + LANE_WIDTH / 2;

  const nodeLeftX = (placed: PlacedNode) => laneCenterX(placed.laneIndex) - placed.width / 2;
  const percentX = (placed: PlacedNode, percent: number) => nodeLeftX(placed) + placed.width * percent;

  // アンカーXは「コリドー(行間の帯) × X位置」単位で占有を管理する。
  // 帯の各Xは上半分(up: 上の行からの出口スタブ)と下半分(down: 下の行への進入降下)を
  // 別々のエッジが使える。同じXのup/downの上下関係は後段のコリドートラック
  // 並べ替えが保証する。downは同一ターゲットへの合流(トランク)なら共有できる。
  type Occupancy = { up?: string; down?: string };
  const occupancyByKey = new Map<string, Occupancy>();
  const occKey = (band: number, x: number) => `${band}:${Math.round(x)}`;
  const occupy = (band: number, x: number, role: "up" | "down", ownerTag: string) => {
    const occ = occupancyByKey.get(occKey(band, x)) ?? {};
    if (role === "up") occ.up = occ.up ?? ownerTag;
    else occ.down = occ.down ?? ownerTag;
    occupancyByKey.set(occKey(band, x), occ);
  };
  const isBlocked = (band: number, x: number, role: "up" | "down", ownerTag: string) => {
    const occ = occupancyByKey.get(occKey(band, x));
    if (!occ) return false;
    if (role === "down") return occ.down !== undefined && occ.down !== ownerTag;
    return occ.up !== undefined && occ.up !== ownerTag;
  };

  // 帯ごとの確定済みラン(交差予測のコスト評価に使う)
  type BandRun = { anchorX: number; anchorUp: boolean; feedX: number; feedUp: boolean; ownerTag: string };
  const bandRunsByBand = new Map<number, BandRun[]>();
  const recordBandRun = (band: number, run: BandRun) => {
    const list = bandRunsByBand.get(band) ?? [];
    list.push(run);
    bandRunsByBand.set(band, list);
  };

  // ANCHOR_PERCENTSをX昇順に並べた候補(indexは元配列の位置=Excel接続点の並びに対応)
  const percentCandidates = ANCHOR_PERCENTS.map((percent, index) => ({ percent, index })).sort(
    (a, b) => a.percent - b.percent,
  );
  const centerFirstPercents = [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78];

  /**
   * 同じ帯を使う2ラン(Z/U字形)の交差を予測する。各ランは「アンカー側の縦線」
   * (進入=down/出口=up)と「反対端の縦線」(feed)を持ち、上下トラック順の制約が
   * 循環する組合せはどのトラック順でも交差が避けられない。
   */
  type RunLike = { anchorX: number; anchorUp: boolean; feedX: number; feedUp: boolean };
  const predictPairCross = (a: RunLike, b: RunLike): boolean => {
    type Att = { x: number; up: boolean };
    const attsA: Att[] = [
      { x: a.anchorX, up: a.anchorUp },
      { x: a.feedX, up: a.feedUp },
    ];
    const attsB: Att[] = [
      { x: b.anchorX, up: b.anchorUp },
      { x: b.feedX, up: b.feedUp },
    ];
    const intervalA = [Math.min(a.anchorX, a.feedX), Math.max(a.anchorX, a.feedX)];
    const intervalB = [Math.min(b.anchorX, b.feedX), Math.max(b.anchorX, b.feedX)];
    const inside = (x: number, iv: number[]) => x > iv[0] + 1 && x < iv[1] - 1;
    let aAbove = false;
    let bAbove = false;
    attsA.forEach((att) => {
      if (inside(att.x, intervalB)) {
        if (att.up) aAbove = true;
        else bAbove = true;
      }
    });
    attsB.forEach((att) => {
      if (inside(att.x, intervalA)) {
        if (att.up) bAbove = true;
        else aAbove = true;
      }
    });
    attsA.forEach((attA) => {
      attsB.forEach((attB) => {
        if (Math.round(attA.x) !== Math.round(attB.x)) return;
        if (attA.up && !attB.up) aAbove = true;
        if (!attA.up && attB.up) bAbove = true;
      });
    });
    return aAbove && bAbove;
  };

  /**
   * ノードの一辺に接続するグループへアンカーXを一括で割り当てる。
   * 1グループだけなら辺の中央を最優先する。複数なら全ての割当を列挙し、
   * 「予測交差数 → 理想位置(到来方向)との距離 → 中央寄り」の優先で最良の
   * 組合せを選ぶ。帯内の占有(他エッジのup/down)と衝突する候補は使わない。
   */
  const assignAnchors = (placed: PlacedNode, band: number, groups: AnchorRequest[]): TopAnchor[] => {
    const candidates = percentCandidates.map((candidate) => ({ ...candidate, x: percentX(placed, candidate.percent) }));
    const asRunLikes = (group: AnchorRequest, x: number): RunLike[] =>
      group.feeds.map((feed) => ({
        anchorX: x,
        anchorUp: group.role === "up",
        feedX: feed.x,
        feedUp: feed.up,
      }));
    const blockedFor = (group: AnchorRequest, x: number) => {
      if (group.avoidX !== undefined && Math.round(x) === Math.round(group.avoidX)) return true;
      if (isBlocked(band, x, group.role, group.ownerTag)) return true;
      // 交差が不可避(循環)の相手と同じXを共有すると、交差の代わりに線の重なりに
      // なってしまうため、その場合のみXの共有を禁止する
      const runs = bandRunsByBand.get(band) ?? [];
      return runs.some((run) => {
        if (run.ownerTag === group.ownerTag || group.edgeIds.includes(run.ownerTag)) return false;
        if (Math.round(run.anchorX) !== Math.round(x) && Math.round(run.feedX) !== Math.round(x)) return false;
        return asRunLikes(group, x).some((mine) =>
          predictPairCross(mine, {
            anchorX: run.anchorX,
            anchorUp: run.anchorUp,
            feedX: run.feedX,
            feedUp: run.feedUp,
          }),
        );
      });
    };
    // 帯内で確定済みの他ランとの交差予測数(自トランク・自エッジの反対端は除く)
    const bandCrossCount = (group: AnchorRequest, x: number) => {
      const runs = bandRunsByBand.get(band) ?? [];
      let count = 0;
      runs.forEach((run) => {
        if (run.ownerTag === group.ownerTag || group.edgeIds.includes(run.ownerTag)) return;
        const mine = asRunLikes(group, x);
        if (
          mine.some((runLike) =>
            predictPairCross(runLike, { anchorX: run.anchorX, anchorUp: run.anchorUp, feedX: run.feedX, feedUp: run.feedUp }),
          )
        ) {
          count += 1;
        }
      });
      return count;
    };
    const finalize = (group: AnchorRequest, candidate: { percent: number; index: number; x: number }): TopAnchor => {
      occupy(band, candidate.x, group.role, group.ownerTag);
      group.feeds.forEach((feed) => {
        recordBandRun(band, {
          anchorX: candidate.x,
          anchorUp: group.role === "up",
          feedX: feed.x,
          feedUp: feed.up,
          ownerTag: group.ownerTag,
        });
      });
      return { x: candidate.x, slot: anchorPercentToSlot(ANCHOR_PERCENTS[candidate.index]), index: candidate.index };
    };

    if (groups.length === 1) {
      const group = groups[0];
      const ordered = centerFirstPercents.map((p) => candidates.find((candidate) => candidate.percent === p)!);
      const pool = ordered.filter(
        (candidate) => group.avoidX === undefined || Math.round(candidate.x) !== Math.round(group.avoidX),
      );
      const usable = pool.filter((candidate) => !blockedFor(group, candidate.x));
      // 交差予測が最少の候補を選び、同数なら中央寄り(pool順)を採る
      let chosen = usable[0] ?? pool[0];
      let chosenCross = chosen ? bandCrossCount(group, chosen.x) : 0;
      for (const candidate of usable) {
        const cross = bandCrossCount(group, candidate.x);
        if (cross < chosenCross) {
          chosen = candidate;
          chosenCross = cross;
        }
        if (cross === 0) break;
      }
      return [finalize(group, chosen)];
    }

    // 複数グループ: 全割当を列挙して「予測交差→理想距離→中央寄り」で最良を選ぶ
    const n = groups.length;
    const m = candidates.length;
    let bestCost = Number.POSITIVE_INFINITY;
    let bestPick: number[] | undefined;
    const pick: number[] = [];
    const used = new Set<number>();
    const search = (groupIndex: number, costSoFar: number) => {
      if (costSoFar >= bestCost) return;
      if (groupIndex === n) {
        bestCost = costSoFar;
        bestPick = [...pick];
        return;
      }
      const group = groups[groupIndex];
      for (let c = 0; c < m; c += 1) {
        // 同一ターゲットの束同士(ownerTagが同じ)は同じアンカーを共有できる(最終降下の
        // トランク共有)。交差するよりは共有の方が良いので小さなペナルティに留める
        const sharedWith = used.has(c)
          ? pick.map((p, gi) => (p === c ? gi : -1)).filter((gi) => gi >= 0)
          : [];
        const shareable = sharedWith.every((gi) => groups[gi].ownerTag === group.ownerTag);
        if (used.has(c) && !shareable) continue;
        const candidate = candidates[c];
        if (blockedFor(group, candidate.x)) continue;
        // 同種の合流は安価に、異種(色違い)の共有は交差回避の最終手段としてのみ許す
        const sharePenalty = sharedWith.reduce(
          (sum, gi) => sum + (groups[gi].mergeTag === group.mergeTag ? 5 : 250),
          0,
        );
        let cost =
          costSoFar +
          Math.abs(group.ideal - candidate.percent) +
          0.02 * Math.abs(candidate.percent - 0.5) +
          sharePenalty +
          1000 * bandCrossCount(group, candidate.x);
        for (let prev = 0; prev < groupIndex && cost < bestCost; prev += 1) {
          if (pick[prev] === c && groups[prev].ownerTag === group.ownerTag) continue; // 共有=合流なので交差なし
          const prevRuns = asRunLikes(groups[prev], candidates[pick[prev]].x);
          const mine = asRunLikes(group, candidate.x);
          if (prevRuns.some((a) => mine.some((b) => predictPairCross(a, b)))) {
            cost += 1000;
          }
        }
        if (cost >= bestCost) continue;
        used.add(c);
        pick.push(c);
        search(groupIndex + 1, cost);
        pick.pop();
        used.delete(c);
      }
    };
    if (n <= m) search(0, 0);
    if (bestPick) {
      return groups.map((group, index) => finalize(group, candidates[bestPick![index]]));
    }

    // フォールバック: 全列挙で成立しない場合は理想位置に近い順で確保し、最後は相乗り
    return groups.map((group) => {
      const ordered = [...candidates].sort(
        (a, b) => Math.abs(a.percent - group.ideal) - Math.abs(b.percent - group.ideal),
      );
      const pool = ordered.filter(
        (candidate) => group.avoidX === undefined || Math.round(candidate.x) !== Math.round(group.avoidX),
      );
      const chosen = pool.find((candidate) => !blockedFor(group, candidate.x)) ?? pool[0];
      return finalize(group, chosen);
    });
  };

  /** 到来Xからアンカーの理想位置(percent)を求める。decisionは頂点近くへ寄せる */
  const idealPercent = (placed: PlacedNode, approachX: number, narrow: boolean) => {
    const leftX = nodeLeftX(placed);
    let percent: number;
    if (approachX <= leftX) percent = 0.3;
    else if (approachX >= leftX + placed.width) percent = 0.7;
    else percent = Math.min(0.78, Math.max(0.22, (approachX - leftX) / placed.width));
    if (narrow) percent = Math.min(0.6, Math.max(0.4, percent));
    return percent;
  };

  /** k本のスタブに与える上→下順のYオフセット列(1本は中央、複数は11px間隔で中央対称) */
  const stubOffsetsFor = (count: number): number[] => {
    const offsets: number[] = [];
    const half = Math.floor(count / 2);
    if (count % 2 === 1) {
      for (let k = -half; k <= half; k += 1) offsets.push(k * 11);
    } else {
      for (let k = -half; k <= half; k += 1) if (k !== 0) offsets.push(k * 11);
    }
    return offsets;
  };
  /** YオフセットをExcel接続点(SIDE_ANCHOR_OFFSETS)の最寄りスロットへ写す */
  const slotForOffset = (offset: number) => {
    let best = 0;
    SIDE_ANCHOR_OFFSETS.forEach((value, index) => {
      if (Math.abs(value - offset) < Math.abs(SIDE_ANCHOR_OFFSETS[best] - offset)) best = index;
    });
    return best;
  };

  // 迂回に使う左右ガターは「自分の縦断区間と重なる既存予約の数」で選ぶ。
  // 同点は従来の既定方向を保つ。区間が重なる同士は同じ側だと交差しやすい。
  const gutterCost = (gutterIndex: number, r1: number, r2: number) =>
    gutterTracks.overlapCount(`${gutterIndex}`, r1, r2);
  const pickAdjacentGutter = (laneIndex: number, tieBreak: Side, r1: number, r2: number) => {
    const left = laneIndex;
    const right = laneIndex + 1;
    if (gutterCost(left, r1, r2) === gutterCost(right, r1, r2)) return tieBreak === "left" ? left : right;
    return gutterCost(left, r1, r2) < gutterCost(right, r1, r2) ? left : right;
  };

  // 同一レーンの逆流(差戻し)は行数を大きく跨ぐことが多く、前進エッジの水平線との
  // 交差を避けたい。盤面の近い端側へ逃がすのを基本とし、中央レーンのみ混雑度で選ぶ。
  const sameLaneBackwardSide = (laneIndex: number, r1: number, r2: number): Side => {
    const centerLane = (placement.laneCount - 1) / 2;
    if (laneIndex < centerLane) return "left";
    if (laneIndex > centerLane) return "right";
    return gutterCost(laneIndex, r1, r2) <= gutterCost(laneIndex + 1, r1, r2) ? "left" : "right";
  };

  const planBottomRoute = (source: PlacedNode, target: PlacedNode): BottomPlan => {
    const sameLane = source.laneIndex === target.laneIndex;
    if (sameLane && isColumnClear(placement, source.laneIndex, source.row, target.row)) return { kind: "aligned" };
    if (source.row === target.row - 1) return { kind: "direct" };
    const gutterIndex = sameLane
      ? pickAdjacentGutter(
          source.laneIndex,
          "right",
          rowPos(source.row, ROW_CORRIDOR),
          rowPos(target.row - 1, ROW_CORRIDOR),
        )
      : source.laneIndex < target.laneIndex
        ? target.laneIndex
        : target.laneIndex + 1;
    return { kind: "viaGutter", gutterIndex, sameLane };
  };

  // decisionノードの分岐エッジを先に振り分ける(左右の頂点と真下を使い分ける)
  const decisionExitSideByEdgeId = planDecisionExits(model, placement);

  // ---------- 1パス目: 経路計画(形状とガターの確定) ----------
  const planned: PlannedEdge[] = [];

  // 同一ターゲット・同一エッジ種のエッジが同じガターを使う場合はランを共有し、
  // 進入直前だけでなくガター縦断から1本に合流(トランク木)させる。
  // 同一レーン迂回(進入Xをずらすためトランクを共有できない)は対象外。
  const trunkGutterByKey = new Map<string, GutterRun>();
  const sharedTrunkGutter = (
    key: string,
    gutterIndex: number,
    r1: number,
    r2: number,
  ): GutterRun => {
    const existing = trunkGutterByKey.get(key);
    if (existing) {
      existing.r1 = Math.min(existing.r1, Math.min(r1, r2));
      existing.r2 = Math.max(existing.r2, Math.max(r1, r2));
      return existing;
    }
    const run: GutterRun = { gutter: gutterIndex, r1, r2, track: gutterTracks.reserve(`${gutterIndex}`, r1, r2) };
    trunkGutterByKey.set(key, run);
    return run;
  };

  model.edges.forEach((flowEdge) => {
    const source = placement.placedById.get(flowEdge.from);
    const target = placement.placedById.get(flowEdge.to);
    if (!source || !target || flowEdge.from === flowEdge.to) return;

    const isDecisionBranch = decisionExitSideByEdgeId.has(flowEdge.id);
    const decisionSide = decisionExitSideByEdgeId.get(flowEdge.id);
    const forward = target.row > source.row;

    if (forward && (decisionSide === "bottom" || !decisionSide)) {
      const plan = planBottomRoute(source, target);
      let gutter: GutterRun | undefined;
      if (plan.kind === "viaGutter") {
        const r1 = rowPos(source.row, ROW_CORRIDOR);
        const r2 = rowPos(target.row - 1, ROW_CORRIDOR);
        if (plan.sameLane) {
          gutter = { gutter: plan.gutterIndex, r1, r2, track: gutterTracks.reserve(`${plan.gutterIndex}`, r1, r2) };
        } else {
          const trunkKey = `${target.node.id}|${flowEdge.edge_type ?? "normal"}|${plan.gutterIndex}`;
          gutter = sharedTrunkGutter(trunkKey, plan.gutterIndex, r1, r2);
        }
      }
      planned.push({
        flowEdge,
        source,
        target,
        isDecisionBranch,
        shape: { kind: "bottom", plan, gutter, decisionBottom: decisionSide === "bottom" },
      });
      return;
    }

    // 側面出し: decisionの左右分岐、または逆流(差戻し)・同一行エッジ
    const side: Side =
      decisionSide === "left" || decisionSide === "right"
        ? decisionSide
        : target.laneIndex < source.laneIndex
          ? "left"
          : target.laneIndex > source.laneIndex
            ? "right"
            : sameLaneBackwardSide(source.laneIndex, rowPos(source.row, ROW_MID), rowPos(target.row, ROW_MID));
    const gutterIndex = side === "left" ? source.laneIndex : source.laneIndex + 1;

    // ガターがターゲットレーンに隣接し、かつレーンが異なる場合は側辺へ直接進入できる。
    // 同一レーンは始点終点のXが一致しExcelコネクタで表現できないため対象外。
    // decision(ひし形)と端点ノード(角丸端子)は輪郭が矩形でないため対象外。
    const entrySide: Side | undefined =
      gutterIndex === target.laneIndex ? "left" : gutterIndex === target.laneIndex + 1 ? "right" : undefined;
    const canSideEnter =
      entrySide !== undefined && source.laneIndex !== target.laneIndex && !isCenterOnlyNode(target.node.type);

    if (canSideEnter && entrySide !== undefined) {
      const r1 = rowPos(source.row, ROW_MID);
      const r2 = rowPos(target.row, ROW_MID);
      planned.push({
        flowEdge,
        source,
        target,
        isDecisionBranch,
        shape: {
          kind: "sideSide",
          side,
          gutter: { gutter: gutterIndex, r1, r2, track: gutterTracks.reserve(`${gutterIndex}`, r1, r2) },
          stubOffset: 0,
          stubSlot: 0,
          entrySide,
          entryOffset: 0,
          entrySlot: 0,
        },
      });
      return;
    }

    const r1 = rowPos(source.row, ROW_MID);
    const r2 = rowPos(target.row - 1, ROW_CORRIDOR);
    planned.push({
      flowEdge,
      source,
      target,
      isDecisionBranch,
      shape: {
        kind: "sideTop",
        side,
        gutter: sharedTrunkGutter(
          `${target.node.id}|${flowEdge.edge_type ?? "normal"}|${gutterIndex}`,
          gutterIndex,
          r1,
          r2,
        ),
        stubOffset: 0,
        stubSlot: 0,
      },
    });
  });

  // ---------- 2パス目a: 側辺進入の降格判定 ----------
  // 上から来る側辺進入は、ターゲット上辺の直前コリドーをガターで縦断する。
  // そのコリドーを横切って上辺へ入る他エッジがあると必ず交差するため、
  // その場合は側辺進入をやめて上辺進入(合流)へ降格する。
  const topApproachesByTarget = new Map<string, number[]>();
  const recordApproach = (targetId: string, x: number) => {
    const list = topApproachesByTarget.get(targetId) ?? [];
    list.push(x);
    topApproachesByTarget.set(targetId, list);
  };
  const planApproachX = (p: PlannedEdge) =>
    p.shape.kind === "bottom"
      ? p.shape.plan.kind === "viaGutter"
        ? gutterCenterX(p.shape.plan.gutterIndex)
        : laneCenterX(p.source.laneIndex)
      : gutterCenterX(p.shape.gutter.gutter);
  planned.forEach((p) => {
    if (p.shape.kind !== "sideSide") recordApproach(p.target.node.id, planApproachX(p));
  });
  for (let pass = 0; pass < 2; pass += 1) {
    planned.forEach((p) => {
      if (p.shape.kind !== "sideSide") return;
      if (p.source.row >= p.target.row) return; // 下から上がる進入はコリドーを縦断しない
      const gx = gutterCenterX(p.shape.gutter.gutter);
      const fromLeft = p.shape.entrySide === "left";
      const conflicts = (topApproachesByTarget.get(p.target.node.id) ?? []).some((ax) =>
        fromLeft ? ax <= gx : ax >= gx,
      );
      if (!conflicts) return;
      p.shape = {
        kind: "sideTop",
        side: p.shape.side,
        gutter: { ...p.shape.gutter, r2: rowPos(p.target.row - 1, ROW_CORRIDOR) },
        stubOffset: 0,
        stubSlot: 0,
      };
      recordApproach(p.target.node.id, gx);
    });
  }

  // ---------- 2パス目b: 側辺スタブのYオフセット割当 ----------
  // ノードの辺ごとに集約し、1本なら中央。複数は「上へ続くもの(近い順)→
  // 下へ続くもの(遠い順)」を上から並べる。ガターのトラック並べ替え
  // (遠いスパンほど外側)と合わせて、スタブ同士の交差を防ぐ並びになる。
  type StubRef = { p: PlannedEdge; kind: "exit" | "entry"; dir: "up" | "down"; dist: number; nodeHeight: number };
  const stubsByNodeSide = new Map<string, StubRef[]>();
  const addStub = (key: string, ref: StubRef) => {
    const list = stubsByNodeSide.get(key) ?? [];
    list.push(ref);
    stubsByNodeSide.set(key, list);
  };
  planned.forEach((p) => {
    const dist = Math.abs(p.target.row - p.source.row);
    if (p.shape.kind === "sideTop") {
      const dir: "up" | "down" = p.target.row - 1 >= p.source.row ? "down" : "up";
      addStub(`${p.source.node.id}|${p.shape.side}`, { p, kind: "exit", dir, dist, nodeHeight: p.source.height });
    } else if (p.shape.kind === "sideSide") {
      addStub(`${p.source.node.id}|${p.shape.side}`, {
        p,
        kind: "exit",
        dir: p.target.row < p.source.row ? "up" : "down",
        dist,
        nodeHeight: p.source.height,
      });
      addStub(`${p.target.node.id}|${p.shape.entrySide}`, {
        p,
        kind: "entry",
        dir: p.source.row < p.target.row ? "up" : "down",
        dist,
        nodeHeight: p.target.height,
      });
    }
  });
  stubsByNodeSide.forEach((members) => {
    const spanMin = (m: StubRef) => {
      const gutter = (m.p.shape as { gutter: GutterRun }).gutter;
      return Math.min(gutter.r1, gutter.r2);
    };
    const spanMax = (m: StubRef) => {
      const gutter = (m.p.shape as { gutter: GutterRun }).gutter;
      return Math.max(gutter.r1, gutter.r2);
    };
    const sorted = [...members].sort((a, b) => {
      if (a.dir !== b.dir) return a.dir === "up" ? -1 : 1;
      // 同方向のスタブは、縦線(共有トランク含む)が上に伸びるものほど上、
      // 下に伸びるものほど下に置くと、他方のスパン外に水平線が出てネストできる
      if (a.dir === "down") {
        if (spanMin(a) !== spanMin(b)) return spanMin(a) - spanMin(b);
        return a.dist - b.dist;
      }
      if (spanMax(a) !== spanMax(b)) return spanMax(a) - spanMax(b);
      return b.dist - a.dist;
    });
    const offsets = stubOffsetsFor(sorted.length);
    sorted.forEach((member, index) => {
      const limit = Math.max(0, member.nodeHeight / 2 - 12);
      const offset = Math.max(-limit, Math.min(limit, offsets[index]));
      const slot = slotForOffset(offset);
      if (member.kind === "exit") {
        const shape = member.p.shape as { stubOffset: number; stubSlot: number };
        shape.stubOffset = offset;
        shape.stubSlot = slot;
      } else {
        const shape = member.p.shape as { entryOffset: number; entrySlot: number };
        shape.entryOffset = offset;
        shape.entrySlot = slot;
      }
    });
  });

  // ---------- 2パス目c: アンカー割当 ----------
  const nodeSortKey = (placed: PlacedNode) => placed.row * 100000 + placed.laneIndex * 100;

  // decisionの真下出しはひし形頂点(レーン中央)固定なので先に占有する
  planned.forEach((p) => {
    if (p.shape.kind === "bottom" && p.shape.decisionBottom) {
      const center = laneCenterX(p.source.laneIndex);
      const towardX =
        p.shape.plan.kind === "viaGutter" ? gutterCenterX(p.shape.plan.gutterIndex) : laneCenterX(p.target.laneIndex);
      occupy(p.source.row, center, "up", `decision-bottom|${p.flowEdge.id}`);
      recordBandRun(p.source.row, {
        anchorX: center,
        anchorUp: true,
        feedX: towardX,
        feedUp: false,
        ownerTag: p.flowEdge.id,
      });
    }
  });

  // 下辺出口: ノードごとに集め、1本なら中央・複数なら行き先方向順に割り当てる。
  // 同一レーン迂回でdecisionへ入るエッジは進入が頂点(中央)を使うため、
  // 出口側が中央を譲る(S2-2をS2-1に優先)。
  const exitAnchorByEdgeId = new Map<string, TopAnchor>();
  const exitPlansByNode = new Map<string, PlannedEdge[]>();
  planned.forEach((p) => {
    if (p.shape.kind !== "bottom" || p.shape.decisionBottom) return;
    const list = exitPlansByNode.get(p.source.node.id) ?? [];
    list.push(p);
    exitPlansByNode.set(p.source.node.id, list);
  });
  [...exitPlansByNode.values()]
    .sort((a, b) => nodeSortKey(a[0].source) - nodeSortKey(b[0].source))
    .forEach((plans) => {
      const requests = plans
        .map((p) => {
          const plan = (p.shape as { plan: BottomPlan }).plan;
          const approachX =
            plan.kind === "viaGutter" ? gutterCenterX(plan.gutterIndex) : laneCenterX(p.target.laneIndex);
          const detourToCenterOnly =
            plan.kind === "viaGutter" && plan.sameLane && isCenterOnlyNode(p.target.node.type);
          return { p, approachX, detourToCenterOnly };
        })
        .sort((a, b) => a.approachX - b.approachX);
      const groups: AnchorRequest[] = requests.map((request) => ({
        role: "up" as const,
        ownerTag: request.p.flowEdge.id,
        approachX: request.approachX,
        ideal: idealPercent(request.p.source, request.approachX, false),
        avoidX: request.detourToCenterOnly ? laneCenterX(request.p.source.laneIndex) : undefined,
        edgeIds: [request.p.flowEdge.id],
        feeds: [{ x: request.approachX, up: false }],
      }));
      const anchors = assignAnchors(plans[0].source, plans[0].source.row, groups);
      requests.forEach((request, index) => exitAnchorByEdgeId.set(request.p.flowEdge.id, anchors[index]));
    });

  // 上辺進入: ターゲットごとに集約する。decisionへの進入は種類を問わず1束として
  // 頂点(中央)へ合流させる。その他は同一エッジ種で合流し、同じ側から複数束が
  // 来る場合は「近い束ほど手前(内側)・遠い束ほど外側」のネスト順で並べて
  // 交差を防ぐ(コリドートラックの並べ替えと対になる)。
  const entryAnchorByEdgeId = new Map<string, TopAnchor>();
  type EntryGroup = AnchorRequest & { alignedLock: boolean };
  const entryGroupsByTarget = new Map<string, Map<string, EntryGroup>>();
  planned.forEach((p) => {
    if (p.shape.kind === "sideSide") return;
    const target = p.target;
    const isCenterOnlyTarget = isCenterOnlyNode(target.node.type);
    let approachX: number;
    let avoidX: number | undefined;
    let aligned = false;
    let feedUp = true;
    if (p.shape.kind === "bottom") {
      const plan = p.shape.plan;
      const exitX = p.shape.decisionBottom
        ? laneCenterX(p.source.laneIndex)
        : exitAnchorByEdgeId.get(p.flowEdge.id)?.x;
      if (plan.kind === "viaGutter") {
        approachX = gutterCenterX(plan.gutterIndex);
        if (plan.sameLane && !isCenterOnlyTarget && exitX !== undefined) avoidX = exitX;
      } else {
        approachX = exitX ?? laneCenterX(p.source.laneIndex);
        aligned = true;
      }
    } else {
      approachX = gutterCenterX(p.shape.gutter.gutter);
      feedUp = p.source.row <= p.target.row - 1;
    }
    const edgeType = p.flowEdge.edge_type ?? "normal";
    const key = isCenterOnlyTarget ? "center-only" : avoidX !== undefined ? `detour|${p.flowEdge.id}` : `merge|${edgeType}`;
    const ideal = isCenterOnlyTarget ? 0.5 : idealPercent(target, approachX, false);
    const byKey = entryGroupsByTarget.get(target.node.id) ?? new Map<string, EntryGroup>();
    const existing = byKey.get(key);
    if (existing) {
      existing.edgeIds.push(p.flowEdge.id);
      existing.feeds.push({ x: approachX, up: feedUp });
      // 直進できるメンバーがいる合流束はその位置を理想とし、メインフローの直線を守る
      if (aligned && !existing.alignedLock) {
        existing.approachX = approachX;
        existing.ideal = ideal;
        existing.alignedLock = true;
      }
    } else {
      byKey.set(key, {
        role: "down",
        ownerTag: target.node.id,
        mergeTag: edgeType,
        approachX,
        ideal,
        avoidX,
        edgeIds: [p.flowEdge.id],
        feeds: [{ x: approachX, up: feedUp }],
        alignedLock: aligned,
      });
    }
    entryGroupsByTarget.set(target.node.id, byKey);
  });
  const plannedById = new Map(planned.map((p) => [p.flowEdge.id, p]));
  [...entryGroupsByTarget.entries()]
    .map(([targetId, byKey]) => ({ target: placement.placedById.get(targetId)!, groups: [...byKey.values()] }))
    .sort((a, b) => nodeSortKey(a.target) - nodeSortKey(b.target))
    .forEach(({ target, groups }) => {
      const sorted = [...groups].sort((a, b) => a.approachX - b.approachX);
      const anchors = assignAnchors(target, target.row - 1, sorted);
      sorted.forEach((group, index) => {
        group.edgeIds.forEach((edgeId) => entryAnchorByEdgeId.set(edgeId, anchors[index]));
      });
      // 直進(aligned)エッジの縦断列を占有し、途中コリドーで他エッジが同じXを取らないようにする
      sorted.forEach((group, index) => {
        const anchor = anchors[index];
        group.edgeIds.forEach((edgeId) => {
          const p = plannedById.get(edgeId);
          if (!p || p.shape.kind !== "bottom" || p.shape.plan.kind !== "aligned") return;
          occupy(p.source.row, anchor.x, "down", target.node.id);
          for (let band = p.source.row + 1; band <= p.target.row - 1; band += 1) {
            occupy(band, anchor.x, "up", `pass|${edgeId}`);
            occupy(band, anchor.x, "down", target.node.id);
          }
        });
      });
    });

  // ---------- 3パス目: 経路の構築(コリドー予約は定義順で決定論的に行う) ----------
  // トランク共有: 同一ターゲット・同一種でガターを共有するエッジは、ガターから
  // 進入アンカーへの直前コリドーも共有する(進入Xも合流済みで一致する)
  const trunkCorridorByGutter = new Map<GutterRun, CorridorRun>();
  const sharedTrunkCorridor = (gutter: GutterRun, corridor: number, x1: number, x2: number, gx: number) => {
    const existing = trunkCorridorByGutter.get(gutter);
    if (existing) return existing;
    const run = reserveCorridorRun(corridorTracks, corridor, x1, x2, gx);
    trunkCorridorByGutter.set(gutter, run);
    return run;
  };

  const routedEdges: RoutedEdge[] = planned.map((p) => {
    const { flowEdge, source, target, isDecisionBranch } = p;

    if (p.shape.kind === "bottom") {
      const exit = p.shape.decisionBottom
        ? { x: laneCenterX(source.laneIndex), slot: 0, index: 0 }
        : exitAnchorByEdgeId.get(flowEdge.id)!;
      const entry = entryAnchorByEdgeId.get(flowEdge.id)!;
      const sharedCorridorB =
        p.shape.plan.kind === "viaGutter" && !p.shape.plan.sameLane && p.shape.gutter
          ? sharedTrunkCorridor(
              p.shape.gutter,
              target.row - 1,
              gutterCenterX(p.shape.gutter.gutter),
              entry.x,
              gutterCenterX(p.shape.gutter.gutter),
            )
          : undefined;
      const route = buildBottomRoute(source, target, p.shape.plan, p.shape.gutter, corridorTracks, exit, entry, sharedCorridorB);
      return {
        edge: flowEdge,
        source,
        target,
        route,
        sourceHandle: `source-bottom-${exit.slot}`,
        targetHandle: `target-top-${entry.slot}`,
        sourceAnchor: { side: "bottom" as const, slot: exit.index },
        targetAnchor: { side: "top" as const, slot: entry.index },
        isDecisionBranch,
      };
    }

    if (p.shape.kind === "sideSide") {
      const shape = p.shape;
      return {
        edge: flowEdge,
        source,
        target,
        route: {
          kind: "sideExit" as const,
          side: shape.side,
          exitY: shape.stubOffset,
          gutter: shape.gutter,
          entrySide: shape.entrySide,
          entryY: shape.entryOffset,
        },
        sourceHandle: `source-${shape.side}-${Math.min(shape.stubSlot, 2)}`,
        targetHandle: `target-${shape.entrySide}-${Math.min(shape.entrySlot, 2)}`,
        sourceAnchor: { side: shape.side, slot: shape.stubSlot },
        targetAnchor: { side: shape.entrySide, slot: shape.entrySlot },
        isDecisionBranch,
      };
    }

    const shape = p.shape;
    const entry = entryAnchorByEdgeId.get(flowEdge.id)!;
    const corridorB = sharedTrunkCorridor(
      shape.gutter,
      target.row - 1,
      gutterCenterX(shape.gutter.gutter),
      entry.x,
      gutterCenterX(shape.gutter.gutter),
    );
    return {
      edge: flowEdge,
      source,
      target,
      route: {
        kind: "sideExit" as const,
        side: shape.side,
        exitY: shape.stubOffset,
        entryX: entry.x,
        gutter: shape.gutter,
        corridorB,
      },
      sourceHandle: `source-${shape.side}-${Math.min(shape.stubSlot, 2)}`,
      targetHandle: `target-top-${entry.slot}`,
      sourceAnchor: { side: shape.side, slot: shape.stubSlot },
      targetAnchor: { side: "top" as const, slot: entry.index },
      isDecisionBranch,
    };
  });

  // ---------- 3パス目b: ガターの並べ替え(交差回避の制約充足) ----------
  // 各ガターについて「東向きの水平接続がYを通るランは自分より西へ」「西向きの
  // 水平接続がYを通るランは自分より東へ」という制約を満たす西→東の順を求め、
  // Y区間の詰め合わせでスロットを割り当てて実オフセットを確定する。
  type GutterAttachment = { y: number; east: boolean };
  type GutterRunInfo = { run: GutterRun; atts: GutterAttachment[]; order: number; nodeIds: Set<string> };
  const gutterInfoByRun = new Map<GutterRun, GutterRunInfo>();
  const runsByGutter = new Map<string, GutterRunInfo[]>();
  let gutterOrder = 0;
  const addGutterAtt = (run: GutterRun | undefined, y: number, towardX: number, nodeIds: string[]) => {
    if (!run) return;
    let info = gutterInfoByRun.get(run);
    if (!info) {
      info = { run, atts: [], order: gutterOrder, nodeIds: new Set() };
      gutterOrder += 1;
      gutterInfoByRun.set(run, info);
      const list = runsByGutter.get(`${run.gutter}`) ?? [];
      list.push(info);
      runsByGutter.set(`${run.gutter}`, list);
    }
    nodeIds.forEach((id) => info!.nodeIds.add(id));
    info.atts.push({ y, east: towardX > gutterCenterX(run.gutter) });
  };
  routedEdges.forEach((routed) => {
    const route = routed.route;
    if (route.kind === "bottomExit" && route.gutter) {
      // 上端: corridorAで出口側から合流 / 下端: corridorBで進入側へ折れる
      addGutterAtt(route.gutter, rowPos(routed.source.row, ROW_CORRIDOR), route.exitX, [routed.edge.from, routed.edge.to]);
      addGutterAtt(route.gutter, rowPos(routed.target.row - 1, ROW_CORRIDOR), route.entryX, [routed.edge.from, routed.edge.to]);
    } else if (route.kind === "sideExit") {
      // ソース側スタブ(ソースノードの方向へ)
      const stubTowardX = route.side === "left" ? gutterCenterX(route.gutter.gutter) + LANE_WIDTH : gutterCenterX(route.gutter.gutter) - LANE_WIDTH;
      addGutterAtt(route.gutter, rowPos(routed.source.row, ROW_MID) + route.exitY, stubTowardX, [routed.edge.from, routed.edge.to]);
      if (route.entrySide !== undefined && route.entryY !== undefined) {
        const entryTowardX =
          route.entrySide === "left" ? gutterCenterX(route.gutter.gutter) + LANE_WIDTH : gutterCenterX(route.gutter.gutter) - LANE_WIDTH;
        addGutterAtt(route.gutter, rowPos(routed.target.row, ROW_MID) + route.entryY, entryTowardX, [routed.edge.from, routed.edge.to]);
      } else if (route.entryX !== undefined) {
        addGutterAtt(route.gutter, rowPos(routed.target.row - 1, ROW_CORRIDOR), route.entryX, [routed.edge.from, routed.edge.to]);
      }
    }
  });
  runsByGutter.forEach((infos, band) => {
    const gutterIndex = infos[0].run.gutter;
    const n = infos.length;
    // westOf[i] = iより西に置くべきラン
    const westOf: Array<Set<number>> = Array.from({ length: n }, () => new Set<number>());
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const lo = Math.min(infos[j].run.r1, infos[j].run.r2);
        const hi = Math.max(infos[j].run.r1, infos[j].run.r2);
        infos[i].atts.forEach((att) => {
          // 同じ高さで向かい合うスタブ: 西向きのランが西側にいないと水平線が重なる
          infos[j].atts.forEach((other) => {
            if (Math.abs(att.y - other.y) > 60) return;
            if (att.east && !other.east) westOf[i].add(j);
          });
          if (!(att.y > lo + 1 && att.y < hi - 1)) return;
          if (att.east) westOf[i].add(j);
          else westOf[j].add(i);
        });
      }
    }
    const shareNode = (a: Set<string>, b: Set<string>) => [...a].some((id) => b.has(id));
    const pickedOrder = orderWithConstraints(
      n,
      westOf,
      (i) => infos[i].order,
      (i, j) => (shareNode(infos[i].nodeIds, infos[j].nodeIds) ? 100 : 1),
    );
    // 西→東順にスロットへ詰める(同スロットはY区間が重ならない場合のみ)
    const slotOf = new Map<number, number>();
    const intervalsBySlot: Array<Array<{ lo: number; hi: number }>> = [];
    pickedOrder.forEach((i) => {
      const info = infos[i];
      const lo = Math.min(info.run.r1, info.run.r2) - 4;
      const hi = Math.max(info.run.r1, info.run.r2) + 4;
      let slot = 0;
      westOf[i].forEach((j) => {
        const west = slotOf.get(j);
        if (west !== undefined) slot = Math.max(slot, west + 1);
      });
      for (;;) {
        const occupied = intervalsBySlot[slot] ?? [];
        if (occupied.every((iv) => hi <= iv.lo || lo >= iv.hi)) break;
        slot += 1;
      }
      (intervalsBySlot[slot] = intervalsBySlot[slot] ?? []).push({ lo, hi });
      slotOf.set(i, slot);
    });
    const slotCount = intervalsBySlot.length;
    infos.forEach((info, i) => {
      const slot = slotOf.get(i) ?? 0;
      if (gutterIndex === 0) {
        info.run.offsetX = GUTTER_EDGE_MARGIN + slot * GUTTER_TRACK_SPACING;
      } else if (gutterIndex === placement.laneCount) {
        info.run.offsetX = -(GUTTER_EDGE_MARGIN + (slotCount - 1 - slot) * GUTTER_TRACK_SPACING);
      } else {
        info.run.offsetX = (slot - (slotCount - 1) / 2) * GUTTER_TRACK_SPACING;
      }
    });
  });
  const gutterX = (run: GutterRun) => gutterTrackXFor(run, placement.laneCount);

  // ---------- 3パス目c: コリドートラックの並べ替え(交差回避の制約充足) ----------
  // 各コリドーについて「down接続(帯の下へ降りる縦線)がXを通るランは上へ」
  // 「up接続(帯の上から降りてくる縦線)がXを通るランは下へ」「同一Xのup/downは
  // upが上」という制約を満たすトラック順を求め、その順で区間を詰め直す。
  // 接続点Xとラン区間はガターの実トラックX(並べ替え後)を使う。
  type CorridorAttachment = { x: number; dir: "up" | "down" };
  type CorridorRunInfo = {
    run: CorridorRun;
    atts: CorridorAttachment[];
    ex1: number;
    ex2: number;
    order: number;
    nodeIds: Set<string>;
  };
  const runsByCorridor = new Map<string, CorridorRunInfo[]>();
  let runOrder = 0;
  const corridorInfoByRun = new Map<CorridorRun, CorridorRunInfo>();
  const addRunInfo = (
    run: CorridorRun | undefined,
    ex1: number,
    ex2: number,
    atts: CorridorAttachment[],
    nodeIds: string[],
  ) => {
    if (!run) return;
    const existing = corridorInfoByRun.get(run);
    if (existing) {
      nodeIds.forEach((id) => existing.nodeIds.add(id));
      return;
    }
    const info: CorridorRunInfo = { run, atts, ex1, ex2, order: runOrder, nodeIds: new Set(nodeIds) };
    corridorInfoByRun.set(run, info);
    const list = runsByCorridor.get(`${run.corridor}`) ?? [];
    list.push(info);
    runOrder += 1;
    runsByCorridor.set(`${run.corridor}`, list);
  };
  routedEdges.forEach((routed) => {
    const route = routed.route;
    if (route.kind === "bottomExit") {
      const gx = route.gutter ? gutterX(route.gutter) : undefined;
      const downX = gx ?? route.entryX;
      addRunInfo(
        route.corridorA,
        route.exitX,
        downX,
        [
          { x: route.exitX, dir: "up" },
          { x: downX, dir: "down" },
        ],
        [routed.edge.from, routed.edge.to],
      );
      if (route.corridorB && gx !== undefined) {
        addRunInfo(
          route.corridorB,
          gx,
          route.entryX,
          [
            { x: gx, dir: "up" },
            { x: route.entryX, dir: "down" },
          ],
          [routed.edge.from, routed.edge.to],
        );
      }
    } else if (route.kind === "sideExit" && route.corridorB && route.entryX !== undefined) {
      const gx = gutterX(route.gutter);
      const gutterFromAbove = routed.source.row <= routed.target.row - 1;
      addRunInfo(
        route.corridorB,
        gx,
        route.entryX,
        [
          { x: gx, dir: gutterFromAbove ? "up" : "down" },
          { x: route.entryX, dir: "down" },
        ],
        [routed.edge.from, routed.edge.to],
      );
    }
  });
  const corridorCounts = new Map<string, number>();
  runsByCorridor.forEach((runs, band) => {
    const n = runs.length;
    const mustBeAbove: Array<Set<number>> = Array.from({ length: n }, () => new Set<number>());
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const lo = Math.min(runs[j].ex1, runs[j].ex2);
        const hi = Math.max(runs[j].ex1, runs[j].ex2);
        runs[i].atts.forEach((att) => {
          const inside = att.x > lo + 1 && att.x < hi - 1;
          if (inside) {
            if (att.dir === "down") mustBeAbove[i].add(j);
            else mustBeAbove[j].add(i);
          } else if (
            att.dir === "up" &&
            runs[j].atts.some((other) => other.dir === "down" && Math.round(other.x) === Math.round(att.x))
          ) {
            mustBeAbove[j].add(i);
          }
        });
      }
    }
    const shareNode = (a: Set<string>, b: Set<string>) => [...a].some((id) => b.has(id));
    const pickedOrder = orderWithConstraints(
      n,
      mustBeAbove,
      (i) => runs[i].order,
      (i, j) => (shareNode(runs[i].nodeIds, runs[j].nodeIds) ? 100 : 1),
    );
    const trackOf = new Map<number, number>();
    const intervalsByTrack: Array<Array<{ lo: number; hi: number }>> = [];
    pickedOrder.forEach((i) => {
      const info = runs[i];
      const lo = Math.min(info.ex1, info.ex2, info.run.lo ?? Number.POSITIVE_INFINITY) - 4;
      const hi = Math.max(info.ex1, info.ex2, info.run.hi ?? Number.NEGATIVE_INFINITY) + 4;
      let track = 0;
      mustBeAbove[i].forEach((j) => {
        const above = trackOf.get(j);
        if (above !== undefined) track = Math.max(track, above + 1);
      });
      for (;;) {
        const occupied = intervalsByTrack[track] ?? [];
        if (occupied.every((iv) => hi <= iv.lo || lo >= iv.hi)) break;
        track += 1;
      }
      (intervalsByTrack[track] = intervalsByTrack[track] ?? []).push({ lo, hi });
      trackOf.set(i, track);
      info.run.track = track;
    });
    corridorCounts.set(band, intervalsByTrack.length);
  });

  const corridorTrackCounts: TrackCounts = {
    trackCount: (band: string) => corridorCounts.get(band) ?? 0,
  };

  return { routedEdges, corridorTracks: corridorTrackCounts, gutterTracks: gutterTracks };
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
  return { corridor, x1, x2, track, lo: lo - 4, hi: hi + 4 };
}

function gutterCenterX(gutterIndex: number) {
  return gutterIndex * LANE_WIDTH;
}

/** ガターランの実X座標。並べ替え(offsetX)が確定していればそれを、なければ既定則を使う */
function gutterTrackXFor(run: GutterRun, laneCount: number) {
  const center = run.gutter * LANE_WIDTH;
  const maxOffset = LANE_SIDE_REGION - GUTTER_EDGE_MARGIN;
  let offset: number;
  if (run.offsetX !== undefined) {
    offset = run.offsetX;
  } else if (run.gutter === 0) {
    offset = GUTTER_EDGE_MARGIN + run.track * GUTTER_TRACK_SPACING;
  } else if (run.gutter === laneCount) {
    offset = -(GUTTER_EDGE_MARGIN + run.track * GUTTER_TRACK_SPACING);
  } else {
    const magnitude = Math.ceil((run.track + 1) / 2) * GUTTER_TRACK_SPACING;
    offset = run.track % 2 === 0 ? magnitude - GUTTER_TRACK_SPACING / 2 : -(magnitude - GUTTER_TRACK_SPACING / 2);
  }
  const clamped = Math.max(-maxOffset * 2 + GUTTER_EDGE_MARGIN, Math.min(maxOffset * 2 - GUTTER_EDGE_MARGIN, offset));
  return center + clamped;
}

/**
 * 下辺出し経路を計画(plan)と確定済みアンカーから構築する。
 * aligned: 同一レーンで途中セルが空。出口と進入のXが揃えば純粋な直線、
 *          揃わなければコリドー1本でスロットずれを吸収する。
 * direct:  1行下へ。コリドー1本経由。
 * viaGutter: 複数行を跨ぐ。計画済みガターで垂直移動する。
 */
function buildBottomRoute(
  source: PlacedNode,
  target: PlacedNode,
  plan: BottomPlan,
  gutter: GutterRun | undefined,
  corridorTracks: TrackAllocator,
  exit: { x: number },
  entry: { x: number },
  prebuiltCorridorB?: CorridorRun,
): EdgeRoute {
  if (plan.kind === "aligned" && exit.x === entry.x) {
    return { kind: "straight", exitX: exit.x };
  }

  const corridorAIndex = source.row;
  const corridorBIndex = target.row - 1;

  if (plan.kind !== "viaGutter" || gutter === undefined || corridorAIndex === corridorBIndex) {
    const corridorA = reserveCorridorRun(corridorTracks, corridorAIndex, exit.x, entry.x);
    return { kind: "bottomExit", exitX: exit.x, entryX: entry.x, corridorA };
  }

  const gx = gutterCenterX(plan.gutterIndex);
  const corridorA = reserveCorridorRun(corridorTracks, corridorAIndex, exit.x, gx, gx);
  const corridorB = prebuiltCorridorB ?? reserveCorridorRun(corridorTracks, corridorBIndex, gx, entry.x, gx);

  return {
    kind: "bottomExit",
    exitX: exit.x,
    entryX: entry.x,
    corridorA,
    gutter,
    corridorB,
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

  const laneCenter = (laneIndex: number) => laneIndex * LANE_WIDTH + LANE_WIDTH / 2;
  // 真下逃がし候補のスイープ(真下出口→行き先方向の水平区間)が、同じ側の兄弟分岐の
  // 「ガター給電」と「進入位置」の両方を含む場合、上下順で交差を解消できないため
  // その候補は使えない
  const reliefIsValid = (candidate: FlowEdge, siblings: FlowEdge[], source: PlacedNode) => {
    const candidateTarget = placement.placedById.get(candidate.to);
    if (!candidateTarget) return false;
    const gutterFor = (target: PlacedNode) =>
      source.laneIndex === target.laneIndex
        ? source.laneIndex + 1
        : source.laneIndex < target.laneIndex
          ? target.laneIndex
          : target.laneIndex + 1;
    const sweepEnd =
      candidateTarget.row - source.row === 1 ? laneCenter(candidateTarget.laneIndex) : gutterFor(candidateTarget) * LANE_WIDTH;
    const lo = Math.min(laneCenter(source.laneIndex), sweepEnd);
    const hi = Math.max(laneCenter(source.laneIndex), sweepEnd);
    return siblings.every((sibling) => {
      if (sibling.id === candidate.id) return true;
      const target = placement.placedById.get(sibling.to);
      if (!target || target.row <= source.row) return true;
      const side = target.laneIndex <= source.laneIndex ? source.laneIndex : source.laneIndex + 1;
      const feedX = side * LANE_WIDTH;
      const entryX = laneCenter(target.laneIndex);
      const feedInside = feedX > lo + 1 && feedX < hi - 1;
      const entryInside = entryX > lo + 1 && entryX < hi - 1;
      // 2行以上跨ぐ兄弟の縦断はスイープ帯を貫通するため、給電列を含むだけで交差する
      const passesThrough = target.row - source.row >= 2;
      return !(feedInside && (entryInside || passesThrough));
    });
  };

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
    let bottomEdgeId: string | undefined = sameLaneForward.find((edge) => reliefIsValid(edge, edges, source))?.id;

    if (!bottomEdgeId) {
      bottomEdgeId = pickBottomReliefEdgeId(edges, placement, source, (edge) => reliefIsValid(edge, edges, source));
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
 * 左右いずれかの頂点に前進分岐が2本以上集中する場合、その中の1本を真下出しに逃がす。
 * 最も遠い行へ向かう分岐を選ぶ: 真下出しは「コリドー→ターゲット側ガター」の
 * 外回り経路になるため、遠い分岐を外側・近い分岐(頂点出し)を内側とする
 * ネスト構造となり、兄弟分岐同士の交差を避けられる。
 */
function pickBottomReliefEdgeId(
  edges: FlowEdge[],
  placement: Placement,
  source: PlacedNode,
  isValid: (edge: FlowEdge) => boolean,
) {
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
    const rowDiff = (placement.placedById.get(b.to)?.row ?? 0) - (placement.placedById.get(a.to)?.row ?? 0);
    if (rowDiff !== 0) return rowDiff;
    // 行が同じなら横方向に近い分岐を真下に(真下スイープが頂点分岐のガターを包含しない側)
    const lateral = (edge: FlowEdge) => Math.abs((placement.placedById.get(edge.to)?.laneIndex ?? 0) - source.laneIndex);
    if (lateral(a) !== lateral(b)) return lateral(a) - lateral(b);
    return (edgeIndexById.get(a.id) ?? 0) - (edgeIndexById.get(b.id) ?? 0);
  });

  return ranked.find((edge) => isValid(edge))?.id;
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

  const gutterTrackX = (run: GutterRun) => gutterTrackXFor(run, placement.laneCount);

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
      // 矢印は線幅に依存させず固定サイズで統一する(rollback等の太線でも同じ大きさ)
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 24, height: 24, markerUnits: "userSpaceOnUse" },
      style: {
        stroke: color,
        strokeWidth: flowEdge.edge_type === "rollback" || flowEdge.edge_type === "exception" ? 2.4 : 2,
        strokeDasharray: flowEdge.edge_type === "rollback" ? "7 5" : undefined,
      },
    };
  });

  refineLabelPoints(
    edges,
    flowNodes.map((node) => ({
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? 0,
      height: node.height ?? 0,
    })),
  );

  return { nodes: [...laneNodes, ...flowNodes], edges };
}

/**
 * ラベル位置の調整。既定位置(分岐は頂点近く、その他は最長セグメント中点)を起点に、
 * 他エッジの線・ノード・配置済みラベルと重ならない自経路上の候補を探して選ぶ。
 * 全レンダラ(画面/SVG/Excel)が同じ labelPoint を使うため、ここで一度だけ調整する。
 */
function refineLabelPoints(
  edges: Edge<FlowEdgeData>[],
  nodeRects: Array<{ x: number; y: number; width: number; height: number }>,
): void {
  type Rect = { x1: number; y1: number; x2: number; y2: number };
  const labelRect = (point: Point, text: string): Rect => {
    let units = 0;
    for (const ch of text) units += (ch.codePointAt(0) ?? 0) > 0xff ? 1 : 0.55;
    const width = Math.max(24, units * 13 + 10);
    const height = 18;
    return { x1: point.x - width / 2, y1: point.y - height / 2, x2: point.x + width / 2, y2: point.y + height / 2 };
  };
  const segIntersectsRect = (a: Point, b: Point, rect: Rect) => {
    const loX = Math.min(a.x, b.x);
    const hiX = Math.max(a.x, b.x);
    const loY = Math.min(a.y, b.y);
    const hiY = Math.max(a.y, b.y);
    return loX < rect.x2 && hiX > rect.x1 && loY < rect.y2 && hiY > rect.y1;
  };
  const rectsOverlap = (a: Rect, b: Rect) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

  const placedRects: Rect[] = [];
  edges.forEach((edge) => {
    const data = edge.data;
    const text = edge.label ? String(edge.label) : "";
    if (!data?.routePath?.length || !text) return;
    const points = data.routePath;
    const defaultPoint = data.labelPoint ?? { x: points[0].x, y: points[0].y };

    const candidates: Point[] = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      [0.5, 0.3, 0.7, 0.15, 0.85].forEach((t) => {
        if (length * Math.min(t, 1 - t) < 16) return; // 端(コーナー・ノード際)に寄りすぎる候補は除外
        candidates.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      });
    }

    const costOf = (point: Point) => {
      const rect = labelRect(point, text);
      let total = 0;
      edges.forEach((other) => {
        if (other.id === edge.id) return;
        const path = other.data?.routePath;
        if (!path) return;
        for (let index = 0; index < path.length - 1; index += 1) {
          if (segIntersectsRect(path[index], path[index + 1], rect)) total += 30;
        }
      });
      nodeRects.forEach((node) => {
        if (rectsOverlap(rect, { x1: node.x, y1: node.y, x2: node.x + node.width, y2: node.y + node.height })) {
          total += 60;
        }
      });
      placedRects.forEach((placed) => {
        if (rectsOverlap(rect, placed)) total += 40;
      });
      total += 0.01 * (Math.abs(point.x - defaultPoint.x) + Math.abs(point.y - defaultPoint.y));
      return total;
    };

    let best = defaultPoint;
    let bestCost = costOf(defaultPoint);
    candidates.forEach((candidate) => {
      const candidateCost = costOf(candidate);
      if (candidateCost < bestCost - 1e-9) {
        best = candidate;
        bestCost = candidateCost;
      }
    });
    data.labelPoint = best;
    placedRects.push(labelRect(best, text));
  });
}

function emitEdgeGeometry(routed: RoutedEdge, geometry: Geometry): { points: Point[]; labelPoint: Point } {
  const source = geometry.nodeRect(routed.source);
  const target = geometry.nodeRect(routed.target);
  const route = routed.route;

  if (route.kind === "straight") {
    const points = [
      { x: route.exitX, y: source.y + source.height },
      { x: route.exitX, y: target.y },
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

  if (route.entrySide !== undefined && route.entryY !== undefined) {
    // 側辺進入: ガターをターゲット行まで走り、水平スタブで側辺に入る
    const entryY = target.cy + route.entryY;
    const entryX = route.entrySide === "left" ? target.x : target.x + target.width;
    const points: Point[] = [
      { x: exitX, y: exitY },
      { x: gx, y: exitY },
      { x: gx, y: entryY },
      { x: entryX, y: entryY },
    ];
    const compacted = compactPoints(points);
    return { points: compacted, labelPoint: nearSourceLabelPoint(compacted, routed) };
  }

  const entryX = route.entryX ?? target.cx;
  const points: Point[] = [{ x: exitX, y: exitY }, { x: gx, y: exitY }];
  if (route.corridorB) {
    const trackBY = geometry.corridorTrackY(route.corridorB);
    points.push({ x: gx, y: trackBY }, { x: entryX, y: trackBY });
  }
  points.push({ x: entryX, y: target.y });
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
