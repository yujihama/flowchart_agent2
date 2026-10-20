/**
 * docs/edge-routing-spec.md の各ルールをレイアウト出力に対して点検する。
 * 実行: npx tsx scripts/verify-edge-routing.ts [path/to/flow.json]
 * 終了コード: 違反(例外を除く)があれば 1
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Node } from "@xyflow/react";
import type { FlowModel } from "../src/domain/flow-model";
import { buildSwimlaneLayout } from "../src/layout/build-swimlane-layout";
import type { FlowEdgeData, FlowNodeData, LaneNodeData } from "../src/layout/flow-reactflow-types";

const here = dirname(fileURLToPath(import.meta.url));
const modelPath = process.argv[2] ?? resolve(here, "../src/data/sample-flow.json");
const model = JSON.parse(readFileSync(modelPath, "utf-8")) as FlowModel;

const { nodes, edges } = buildSwimlaneLayout(model);

type Pt = { x: number; y: number };
type Rect = { id: string; type: string; x: number; y: number; w: number; h: number; cx: number; cy: number };

const rects = new Map<string, Rect>(
  nodes
    .filter((node): node is Node<FlowNodeData> => node.data.kind === "flow")
    .map((node) => {
      const w = node.width ?? 0;
      const h = node.height ?? 0;
      return [
        node.id,
        {
          id: node.id,
          type: node.data.node.type,
          x: node.position.x,
          y: node.position.y,
          w,
          h,
          cx: node.position.x + w / 2,
          cy: node.position.y + h / 2,
        },
      ];
    }),
);

type CheckedEdge = {
  id: string;
  source: string;
  target: string;
  edgeType: string;
  path: Pt[];
};

const checked: CheckedEdge[] = edges
  .filter((edge) => (edge.data as FlowEdgeData | undefined)?.routePath?.length)
  .map((edge) => {
    const data = edge.data as FlowEdgeData;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      edgeType: data.edge.edge_type ?? "normal",
      path: data.routePath!,
    };
  });

const EPS = 1.0;
const violations: string[] = [];
const exceptions: string[] = [];

/** 同一レーン迂回(E1例外の対象)か: 始点終点が同レーンで経路がガター迂回している */
const laneIndexByNodeId = new Map(model.nodes.map((n) => [n.id, model.lanes.findIndex((l) => l.id === n.lane_id)]));
const isSameLaneDetour = (edge: CheckedEdge) =>
  laneIndexByNodeId.get(edge.source) === laneIndexByNodeId.get(edge.target) && edge.path.length >= 5;

// ---------------------------------------------------------------------------
// S1-1 直交性 / S3-2 曲がり数
// ---------------------------------------------------------------------------
checked.forEach((edge) => {
  for (let i = 0; i < edge.path.length - 1; i += 1) {
    const a = edge.path[i];
    const b = edge.path[i + 1];
    const dx = Math.abs(a.x - b.x) > EPS;
    const dy = Math.abs(a.y - b.y) > EPS;
    if (dx && dy) violations.push(`[S1-1] ${edge.id}: 斜めセグメント (${a.x},${a.y})-(${b.x},${b.y})`);
  }
  const bends = edge.path.length - 2;
  if (bends > 4) violations.push(`[S3-2] ${edge.id}: 曲がり${bends}回 (上限4)`);
});

// ---------------------------------------------------------------------------
// S1-2 端点がノード境界上
// ---------------------------------------------------------------------------
const onBoundary = (rect: Rect, p: Pt) => {
  const inX = p.x >= rect.x - EPS && p.x <= rect.x + rect.w + EPS;
  const inY = p.y >= rect.y - EPS && p.y <= rect.y + rect.h + EPS;
  const onV = (Math.abs(p.x - rect.x) <= EPS || Math.abs(p.x - rect.x - rect.w) <= EPS) && inY;
  const onH = (Math.abs(p.y - rect.y) <= EPS || Math.abs(p.y - rect.y - rect.h) <= EPS) && inX;
  return onV || onH;
};
checked.forEach((edge) => {
  const s = rects.get(edge.source);
  const t = rects.get(edge.target);
  if (!s || !t) return;
  if (!onBoundary(s, edge.path[0])) violations.push(`[S1-2] ${edge.id}: 始点がノード境界上にない`);
  if (!onBoundary(t, edge.path[edge.path.length - 1])) violations.push(`[S1-2] ${edge.id}: 終点がノード境界上にない`);
});

// ---------------------------------------------------------------------------
// S1-3 ノード回避
// ---------------------------------------------------------------------------
const segIntersectsRect = (a: Pt, b: Pt, rect: Rect) => {
  const pad = 2; // 矩形をわずかに縮めて境界接触を許す
  const rx1 = rect.x + pad;
  const ry1 = rect.y + pad;
  const rx2 = rect.x + rect.w - pad;
  const ry2 = rect.y + rect.h - pad;
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return x1 < rx2 && x2 > rx1 && y1 < ry2 && y2 > ry1;
};
checked.forEach((edge) => {
  rects.forEach((rect) => {
    if (rect.id === edge.source || rect.id === edge.target) return;
    for (let i = 0; i < edge.path.length - 1; i += 1) {
      if (segIntersectsRect(edge.path[i], edge.path[i + 1], rect)) {
        violations.push(`[S1-3] ${edge.id}: セグメント${i}がノード${rect.id}を横断`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// S2 接続位置
// ---------------------------------------------------------------------------
type SideKey = string; // `${nodeId}|${side}|${in/out}`
const sideOf = (rect: Rect, p: Pt): "top" | "bottom" | "left" | "right" => {
  const d = [
    { side: "top" as const, dist: Math.abs(p.y - rect.y) },
    { side: "bottom" as const, dist: Math.abs(p.y - rect.y - rect.h) },
    { side: "left" as const, dist: Math.abs(p.x - rect.x) },
    { side: "right" as const, dist: Math.abs(p.x - rect.x - rect.w) },
  ];
  return d.sort((a, b) => a.dist - b.dist)[0].side;
};
const bundles = new Map<SideKey, Map<number, CheckedEdge[]>>();
const addBundle = (key: SideKey, coord: number, edge: CheckedEdge) => {
  const byCoord = bundles.get(key) ?? new Map<number, CheckedEdge[]>();
  const rounded = Math.round(coord);
  const list = byCoord.get(rounded) ?? [];
  list.push(edge);
  byCoord.set(rounded, list);
  bundles.set(key, byCoord);
};
checked.forEach((edge) => {
  const s = rects.get(edge.source);
  const t = rects.get(edge.target);
  if (!s || !t) return;
  const sp = edge.path[0];
  const tp = edge.path[edge.path.length - 1];
  const sSide = sideOf(s, sp);
  const tSide = sideOf(t, tp);
  // 同じ辺の入出は物理的に位置を分け合うため、中央判定(S2-1)は入出合算で行う
  addBundle(`${edge.source}|${sSide}|out`, sSide === "left" || sSide === "right" ? sp.y : sp.x, edge);
  addBundle(`${edge.target}|${tSide}|in`, tSide === "left" || tSide === "right" ? tp.y : tp.x, edge);
  addBundle(`${edge.source}|${sSide}|all`, sSide === "left" || sSide === "right" ? sp.y : sp.x, edge);
  addBundle(`${edge.target}|${tSide}|all`, tSide === "left" || tSide === "right" ? tp.y : tp.x, edge);
});

/**
 * E2例外: その辺の中央の列を、他エッジの縦セグメントが隣接コリドー帯で使っており、
 * 中央に置くと線の重なり(交差の退化)になる場合。
 */
const centerBlockedByOther = (rect: Rect, side: string, members: CheckedEdge[]) => {
  const center = side === "left" || side === "right" ? rect.cy : rect.cx;
  if (side === "left" || side === "right") return false;
  const yLo = side === "top" ? rect.y - 200 : rect.y + rect.h;
  const yHi = side === "top" ? rect.y : rect.y + rect.h + 200;
  const memberIds = new Set(members.map((m) => m.id));
  return checked.some((edge) => {
    if (memberIds.has(edge.id)) return false;
    for (let i = 0; i < edge.path.length - 1; i += 1) {
      const a = edge.path[i];
      const b = edge.path[i + 1];
      if (Math.abs(a.x - b.x) > EPS) continue;
      if (Math.abs(a.x - center) > 2) continue;
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      if (hi > yLo && lo < yHi) return true;
    }
    return false;
  });
};

bundles.forEach((byCoord, key) => {
  const [nodeId, side, kind] = key.split("|");
  const rect = rects.get(nodeId)!;
  const center = side === "left" || side === "right" ? rect.cy : rect.cx;
  // S2-1: 単独接続は中央(同じ辺の入出は合算で判定)
  if (kind === "all" && byCoord.size === 1) {
    const [coord, members] = [...byCoord.entries()][0];
    if (Math.abs(coord - center) > EPS) {
      const detour = members.some(isSameLaneDetour);
      const msg = `[S2-1] ${nodeId} ${side}: 単独接続が中央にない (${coord} vs ${Math.round(center)}) edges=${members.map((m) => m.id).join(",")}`;
      if (detour) exceptions.push(`${msg} (E1: 同一レーン迂回)`);
      else if (centerBlockedByOther(rect, side, members)) exceptions.push(`${msg} (E2: 中央列を他エッジが使用)`);
      else violations.push(msg);
    }
  }
  // S2-2: decision・端点ノードの上辺進入・下辺退出は中央。側辺接続は不可
  const centerOnly = rect.type === "decision" || rect.type === "start" || rect.type === "end";
  if (centerOnly && ((side === "top" && key.endsWith("in")) || (side === "bottom" && key.endsWith("out")))) {
    byCoord.forEach((members, coord) => {
      if (Math.abs(coord - center) > EPS) {
        const detour = members.some(isSameLaneDetour);
        const msg = `[S2-2] ${nodeId} ${side}: 中央から外れた接続 (${coord} vs ${Math.round(center)}) edges=${members.map((m) => m.id).join(",")}`;
        if (detour) exceptions.push(`${msg} (E1: 同一レーン迂回)`);
        else if (centerBlockedByOther(rect, side, members)) exceptions.push(`${msg} (E2: 中央列を他エッジが使用)`);
        else violations.push(msg);
      }
    });
  }
  if (centerOnly && (side === "left" || side === "right") && key.endsWith("in")) {
    byCoord.forEach((members) => {
      violations.push(`[S2-2] ${nodeId} ${side}: 中央限定ノードへの側辺進入 edges=${members.map((m) => m.id).join(",")}`);
    });
  }
});

// ---------------------------------------------------------------------------
// S3-1 直進の直線化
// ---------------------------------------------------------------------------
const nodesByLane = new Map<number, Rect[]>();
rects.forEach((rect) => {
  const lane = laneIndexByNodeId.get(rect.id) ?? -1;
  const list = nodesByLane.get(lane) ?? [];
  list.push(rect);
  nodesByLane.set(lane, list);
});
checked.forEach((edge) => {
  const s = rects.get(edge.source);
  const t = rects.get(edge.target);
  if (!s || !t) return;
  const sameLane = laneIndexByNodeId.get(edge.source) === laneIndexByNodeId.get(edge.target);
  const forwardDown = t.y > s.y + s.h;
  if (!sameLane || !forwardDown) return;
  const blocked = (nodesByLane.get(laneIndexByNodeId.get(edge.source)!) ?? []).some(
    (rect) => rect.id !== s.id && rect.id !== t.id && rect.y > s.y && rect.y < t.y,
  );
  if (blocked) return;
  const exitSolo = (bundles.get(`${edge.source}|bottom|out`)?.size ?? 0) === 1;
  const entrySolo = (bundles.get(`${edge.target}|top|in`)?.size ?? 0) === 1;
  if (exitSolo && entrySolo && edge.path.length !== 2) {
    violations.push(`[S3-1] ${edge.id}: 障害物のない同一レーン直進が直線でない (${edge.path.length}点)`);
  }
});

// ---------------------------------------------------------------------------
// S4 交差・重なり
// ---------------------------------------------------------------------------
const isH = (a: Pt, b: Pt) => Math.abs(a.y - b.y) <= EPS;
const properCross = (a1: Pt, a2: Pt, b1: Pt, b2: Pt) => {
  if (isH(a1, a2) === isH(b1, b2)) return false;
  const [h1, h2, v1, v2] = isH(a1, a2) ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
  const [hx1, hx2] = [Math.min(h1.x, h2.x), Math.max(h1.x, h2.x)];
  const [vy1, vy2] = [Math.min(v1.y, v2.y), Math.max(v1.y, v2.y)];
  return h1.y > vy1 + EPS && h1.y < vy2 - EPS && v1.x > hx1 + EPS && v1.x < hx2 - EPS;
};
const crossCount = (a: CheckedEdge, b: CheckedEdge) => {
  let count = 0;
  for (let i = 0; i < a.path.length - 1; i += 1) {
    for (let j = 0; j < b.path.length - 1; j += 1) {
      if (properCross(a.path[i], a.path[i + 1], b.path[j], b.path[j + 1])) count += 1;
    }
  }
  return count;
};
let totalCrossings = 0;
for (let i = 0; i < checked.length; i += 1) {
  for (let j = i + 1; j < checked.length; j += 1) {
    const a = checked[i];
    const b = checked[j];
    const crossings = crossCount(a, b);
    totalCrossings += crossings;
    if (crossings === 0) continue;
    if (a.source === b.source) violations.push(`[S4-1] ${a.id} × ${b.id}: 同一始点(${a.source})のエッジが交差`);
    if (a.target === b.target) violations.push(`[S4-2] ${a.id} × ${b.id}: 同一終点(${a.target})のエッジが交差`);
  }
}

// S4-3 部分重なり(トランク共有以外)
const overlap1D = (a1: number, a2: number, b1: number, b2: number) => {
  const lo = Math.max(Math.min(a1, a2), Math.min(b1, b2));
  const hi = Math.min(Math.max(a1, a2), Math.max(b1, b2));
  return hi - lo > EPS * 2 ? [lo, hi] : undefined;
};
for (let i = 0; i < checked.length; i += 1) {
  for (let j = i + 1; j < checked.length; j += 1) {
    const a = checked[i];
    const b = checked[j];
    const sharedTrunk =
      a.target === b.target &&
      Math.abs(a.path[a.path.length - 1].x - b.path[b.path.length - 1].x) <= EPS &&
      Math.abs(a.path[a.path.length - 1].y - b.path[b.path.length - 1].y) <= EPS;
    for (let si = 0; si < a.path.length - 1; si += 1) {
      for (let sj = 0; sj < b.path.length - 1; sj += 1) {
        const a1 = a.path[si];
        const a2 = a.path[si + 1];
        const b1 = b.path[sj];
        const b2 = b.path[sj + 1];
        if (isH(a1, a2) !== isH(b1, b2)) continue;
        if (isH(a1, a2)) {
          if (Math.abs(a1.y - b1.y) > EPS) continue;
          if (overlap1D(a1.x, a2.x, b1.x, b2.x)) {
            if (sharedTrunk) exceptions.push(`[S4-3] ${a.id} ∥ ${b.id}: 水平重なり (合流トランク共有)`);
            else violations.push(`[S4-3] ${a.id} ∥ ${b.id}: 水平セグメント重なり y=${Math.round(a1.y)}`);
          }
        } else {
          if (Math.abs(a1.x - b1.x) > EPS) continue;
          if (overlap1D(a1.y, a2.y, b1.y, b2.y)) {
            if (sharedTrunk) exceptions.push(`[S4-3] ${a.id} ∥ ${b.id}: 垂直重なり (合流トランク共有)`);
            else violations.push(`[S4-3] ${a.id} ∥ ${b.id}: 垂直セグメント重なり x=${Math.round(a1.x)}`);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// S5-1 Excel形状クラス
// ---------------------------------------------------------------------------
const ALLOWED = new Set(["V", "H", "HV", "VH", "HVH", "VHV", "HVHV", "VHVHV"]);
checked.forEach((edge) => {
  const signature = edge.path
    .slice(0, -1)
    .map((p, i) => (Math.abs(edge.path[i + 1].x - p.x) <= EPS ? "V" : "H"))
    .join("");
  if (!ALLOWED.has(signature)) violations.push(`[S5-1] ${edge.id}: Excel非対応形状 ${signature}`);
});

// ---------------------------------------------------------------------------
// 報告
// ---------------------------------------------------------------------------
const unique = (list: string[]) => [...new Set(list)];
const v = unique(violations);
const e = unique(exceptions);
console.log(`エッジ数: ${checked.length}  総交差数(S4-4指標): ${totalCrossings}`);
console.log(`違反: ${v.length}件  例外適用: ${e.length}件`);
v.forEach((msg) => console.log(`  NG ${msg}`));
e.forEach((msg) => console.log(`  EX ${msg}`));
process.exit(v.length > 0 ? 1 : 0);
