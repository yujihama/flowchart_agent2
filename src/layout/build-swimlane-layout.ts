import type { Edge, Node } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import type { FlowEdge, FlowModel, FlowNode, Lane } from "../domain/flow-model";
import type { FlowEdgeData, FlowNodeData, LaneNodeData } from "./flow-reactflow-types";
import {
  BOARD_PADDING_BOTTOM,
  HANDLE_SLOT_COUNT,
  LANE_HEADER_HEIGHT,
  LANE_WIDTH,
  NODE_HEIGHT_BY_TYPE,
  NODE_TOP_PADDING,
  NODE_WIDTH_BY_TYPE,
  ROW_HEIGHT,
} from "./swimlane-constants";

export type SwimlaneLayout = {
  nodes: Array<Node<FlowNodeData | LaneNodeData>>;
  edges: Edge<FlowEdgeData>[];
};

type Point = { x: number; y: number };

type LayoutNodeMeta = {
  type: FlowNode["type"];
  laneIndex: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type GutterSide = "left" | "right";
type GutterTrackReservation = {
  startY: number;
  endY: number;
};
type GutterTrackReservations = Map<string, GutterTrackReservation[][]>;
type HorizontalSegmentRef = {
  edgeIndex: number;
  pointIndex: number;
  y: number;
  startX: number;
  endX: number;
};
type VerticalSegmentRef = {
  edgeIndex: number;
  pointIndex: number;
  x: number;
  startY: number;
  endY: number;
};
type EndpointVerticalSegmentRef = VerticalSegmentRef & {
  endpoint: "source" | "target";
};

const LANE_GUTTER_OFFSET = 64;
const ROW_GUTTER_OFFSET = 18;
const DECISION_BRANCH_TRACK_GAP = 18;
const DECISION_BRANCH_STEM_LENGTH = 32;
const DECISION_BRANCH_LINE_GAP = 18;
const DECISION_NODE_ROW_OFFSET = 32;
const GUTTER_TRACK_SPACING = 14;
const SEGMENT_TRACK_SPACING = 12;
const ENDPOINT_STUB_LENGTH = 12;
const MIN_OVERLAP_SEGMENT_LENGTH = 36;
const HANDLE_PERCENT_BY_SLOT = [0.5, 0.3, 0.7] as const;

export function buildSwimlaneLayout(model: FlowModel): SwimlaneLayout {
  const laneById = new Map(model.lanes.map((lane) => [lane.id, lane]));
  const phaseById = new Map(model.phases.map((phase) => [phase.id, phase]));
  const laneIndexById = new Map(model.lanes.map((lane, index) => [lane.id, index]));
  const depthByNodeId = calculateDepths(model);
  const { rowByNodeId, reservedRowsByLane } = assignRows(model, depthByNodeId);
  const reservedRows = Array.from(reservedRowsByLane.values()).flatMap((rows) => Array.from(rows));
  const maxRow = Math.max(0, ...Array.from(rowByNodeId.values()), ...reservedRows);
  const laneHeight = LANE_HEADER_HEIGHT + NODE_TOP_PADDING + maxRow * ROW_HEIGHT + BOARD_PADDING_BOTTOM;

  const laneNodes: Array<Node<LaneNodeData>> = model.lanes.map((lane, index) => ({
    id: `lane-${lane.id}`,
    type: "laneNode",
    position: {
      x: index * LANE_WIDTH,
      y: 0,
    },
    data: {
      kind: "lane",
      lane,
      laneIndex: index,
      height: laneHeight,
      width: LANE_WIDTH,
    },
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -10,
    style: {
      width: LANE_WIDTH,
      height: laneHeight,
    },
  }));

  const nodeMeta = new Map<string, LayoutNodeMeta>();
  const flowNodes: Array<Node<FlowNodeData>> = model.nodes.map((flowNode) => {
    const laneIndex = laneIndexById.get(flowNode.lane_id) ?? 0;
    const row = rowByNodeId.get(flowNode.id) ?? 0;

    const nodeWidth = NODE_WIDTH_BY_TYPE[flowNode.type];
    const nodeHeight = NODE_HEIGHT_BY_TYPE[flowNode.type];
    const yOffset = flowNode.type === "decision" ? DECISION_NODE_ROW_OFFSET : 0;
    const position = {
      x: laneIndex * LANE_WIDTH + (LANE_WIDTH - nodeWidth) / 2,
      y: LANE_HEADER_HEIGHT + NODE_TOP_PADDING + row * ROW_HEIGHT + yOffset,
    };
    nodeMeta.set(flowNode.id, {
      type: flowNode.type,
      laneIndex,
      row,
      x: position.x,
      y: position.y,
      width: nodeWidth,
      height: nodeHeight,
    });

    return {
      id: flowNode.id,
      type: reactFlowNodeType(flowNode.type),
      position,
      data: {
        kind: "flow",
        node: flowNode,
        laneName: laneById.get(flowNode.lane_id)?.name ?? flowNode.lane_id,
        phaseName: phaseById.get(flowNode.phase_id)?.name ?? flowNode.phase_id,
      },
      zIndex: 10,
    };
  });

  const occupiedCells = new Set(Array.from(nodeMeta.values(), (meta) => cellKey(meta.laneIndex, meta.row)));
  reservedRowsByLane.forEach((rows, laneId) => {
    const laneIndex = laneIndexById.get(laneId);
    if (laneIndex === undefined) return;
    rows.forEach((row) => occupiedCells.add(cellKey(laneIndex, row)));
  });
  const decisionBranchByEdgeId = buildDecisionBranchMap(model, nodeMeta);
  const targetTopReservedNodeIds = buildTopReservedTargetNodeIds(model, nodeMeta, decisionBranchByEdgeId);

  const handleUseCount = new Map<string, number>();
  const gutterTrackReservations: GutterTrackReservations = new Map();
  const edges: Edge<FlowEdgeData>[] = model.edges.map((flowEdge) => {
    const source = nodeMeta.get(flowEdge.from);
    const target = nodeMeta.get(flowEdge.to);
    const decisionBranch = decisionBranchByEdgeId.get(flowEdge.id);
    const isDirectDecisionTarget = source && target ? isDirectlyBelowDecisionTarget(source, target, nodeMeta) : false;
    const { sourceSide, targetSide } = chooseHandleSides(
      flowEdge,
      source,
      target,
      decisionBranch,
      targetTopReservedNodeIds.has(flowEdge.to),
      isDirectDecisionTarget,
    );
    const sourceHandle = decisionBranch
      ? { id: "source-bottom-0", slot: 0 }
      : allocateHandle(flowEdge.from, "source", sourceSide, handleUseCount);
    const targetHandle = allocateHandle(flowEdge.to, "target", targetSide, handleUseCount);
    const route = source && target
      ? routeEdge(
          flowEdge,
          source,
          target,
          sourceSide,
          targetSide,
          sourceHandle.slot,
          targetHandle.slot,
          occupiedCells,
          gutterTrackReservations,
          decisionBranch,
          isDirectDecisionTarget,
        )
      : undefined;

    return {
      id: flowEdge.id,
      source: flowEdge.from,
      target: flowEdge.to,
      sourceHandle: sourceHandle.id,
      targetHandle: targetHandle.id,
      type: "swimlaneRoutedEdge",
      label: flowEdge.label ?? flowEdge.condition?.text,
      data: {
        edge: flowEdge,
        routePath: route?.points,
        labelPoint: route?.labelPoint,
        skipHorizontalOverlapResolve: Boolean(decisionBranch),
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: edgeColor(flowEdge.edge_type),
      },
      style: {
        stroke: edgeColor(flowEdge.edge_type),
        strokeWidth: flowEdge.edge_type === "rollback" || flowEdge.edge_type === "exception" ? 2.6 : 2,
        strokeDasharray: flowEdge.edge_type === "rollback" ? "7 5" : undefined,
      },
      labelStyle: {
        fill: "#22313f",
        fontWeight: 700,
        fontSize: 12,
      },
      labelBgStyle: {
        fill: "#ffffff",
        fillOpacity: 0.88,
      },
      labelBgPadding: [8, 4],
      labelBgBorderRadius: 5,
    };
  });

  return { nodes: [...laneNodes, ...flowNodes], edges: resolveSegmentOverlaps(edges) };
}

function calculateDepths(model: FlowModel) {
  const indexByNodeId = new Map(model.nodes.map((node, index) => [node.id, index]));
  const depthByNodeId = new Map(model.nodes.map((node) => [node.id, 0]));

  for (let pass = 0; pass < model.nodes.length; pass += 1) {
    let changed = false;
    model.edges.forEach((edge) => {
      const sourceIndex = indexByNodeId.get(edge.from) ?? 0;
      const targetIndex = indexByNodeId.get(edge.to) ?? 0;
      const isBackReference = edge.edge_type === "rollback" && targetIndex <= sourceIndex;
      if (isBackReference) return;

      const sourceDepth = depthByNodeId.get(edge.from) ?? 0;
      const targetDepth = depthByNodeId.get(edge.to) ?? 0;
      if (sourceDepth + 1 > targetDepth) {
        depthByNodeId.set(edge.to, sourceDepth + 1);
        changed = true;
      }
    });
    if (!changed) break;
  }

  return depthByNodeId;
}

function assignRows(model: FlowModel, depthByNodeId: Map<string, number>) {
  const occupiedRowsByLane = new Map<string, Set<number>>();
  const reservedRowsByLane = new Map<string, Set<number>>();
  const rowByNodeId = new Map<string, number>();
  const nodeIndexById = new Map(model.nodes.map((node, index) => [node.id, index]));
  const branchingDecisionIds = findBranchingDecisionIds(model);
  const incomingNormalEdgesByTargetId = new Map<string, FlowEdge[]>();

  model.edges.forEach((edge) => {
    if (edge.edge_type && edge.edge_type !== "normal") return;
    const incoming = incomingNormalEdgesByTargetId.get(edge.to) ?? [];
    incoming.push(edge);
    incomingNormalEdgesByTargetId.set(edge.to, incoming);
  });

  const sortedNodes = [...model.nodes].sort((a, b) => {
    const depthDiff = (depthByNodeId.get(a.id) ?? 0) - (depthByNodeId.get(b.id) ?? 0);
    if (depthDiff !== 0) return depthDiff;
    return (nodeIndexById.get(a.id) ?? 0) - (nodeIndexById.get(b.id) ?? 0);
  });

  sortedNodes.forEach((node) => {
    const occupiedRows = occupiedRowsByLane.get(node.lane_id) ?? new Set<number>();
    let row = depthByNodeId.get(node.id) ?? 0;

    (incomingNormalEdgesByTargetId.get(node.id) ?? []).forEach((edge) => {
      const sourceRow = rowByNodeId.get(edge.from);
      if (sourceRow === undefined) return;
      row = Math.max(row, sourceRow + 1);
    });

    while (occupiedRows.has(row)) {
      row += 1;
    }
    occupiedRows.add(row);

    if (branchingDecisionIds.has(node.id)) {
      const reservedRow = row + 1;
      model.lanes.forEach((lane) => {
        const laneOccupiedRows = lane.id === node.lane_id ? occupiedRows : occupiedRowsByLane.get(lane.id) ?? new Set<number>();
        const reservedRows = reservedRowsByLane.get(lane.id) ?? new Set<number>();
        laneOccupiedRows.add(reservedRow);
        reservedRows.add(reservedRow);
        occupiedRowsByLane.set(lane.id, laneOccupiedRows);
        reservedRowsByLane.set(lane.id, reservedRows);
      });
    }

    occupiedRowsByLane.set(node.lane_id, occupiedRows);
    rowByNodeId.set(node.id, row);
  });

  return { rowByNodeId, reservedRowsByLane };
}

function findBranchingDecisionIds(model: FlowModel) {
  const nodeTypeById = new Map(model.nodes.map((node) => [node.id, node.type]));
  const outgoingCountByNodeId = new Map<string, number>();

  model.edges.forEach((edge) => {
    if (nodeTypeById.get(edge.from) !== "decision") return;
    outgoingCountByNodeId.set(edge.from, (outgoingCountByNodeId.get(edge.from) ?? 0) + 1);
  });

  return new Set(
    Array.from(outgoingCountByNodeId.entries())
      .filter(([, count]) => count > 1)
      .map(([nodeId]) => nodeId),
  );
}

type HandleSide = "top" | "right" | "bottom" | "left";
type HandleKind = "source" | "target";
type DecisionBranchDirection = "left" | "right";
type DecisionBranchInfo = {
  index: number;
  total: number;
  direction: DecisionBranchDirection;
  directionIndex: number;
  directionTotal: number;
};

function chooseHandleSides(
  edge: FlowEdge,
  source?: LayoutNodeMeta,
  target?: LayoutNodeMeta,
  decisionBranch?: DecisionBranchInfo,
  targetTopReserved = false,
  isDirectDecisionTarget = false,
): { sourceSide: HandleSide; targetSide: HandleSide } {
  if (!source || !target) {
    return { sourceSide: "bottom" as const, targetSide: "top" as const };
  }

  if (decisionBranch && decisionBranch.total > 1) {
    const isTargetInBranchRow = target.row <= source.row + 1;
    return {
      sourceSide: "bottom" as const,
      targetSide: isDirectDecisionTarget || (!targetTopReserved && !isTargetInBranchRow)
        ? "top"
        : decisionBranchSide(source, target, decisionBranch, edge.edge_type),
    };
  }

  if (edge.edge_type === "rollback") {
    if (target.laneIndex < source.laneIndex) {
      return { sourceSide: "left" as const, targetSide: "right" as const };
    }
    if (target.laneIndex > source.laneIndex) {
      return { sourceSide: "right" as const, targetSide: "left" as const };
    }
    return { sourceSide: "left" as const, targetSide: "left" as const };
  }

  const isNormal = !edge.edge_type || edge.edge_type === "normal";
  if (isNormal) {
    const isSameDepthHandoff = source.row === target.row && source.laneIndex !== target.laneIndex;
    if (isSameDepthHandoff) {
      return target.laneIndex > source.laneIndex
        ? { sourceSide: "right" as const, targetSide: "left" as const }
        : { sourceSide: "left" as const, targetSide: "right" as const };
    }
    return { sourceSide: "bottom" as const, targetSide: "top" as const };
  }

  return target.laneIndex > source.laneIndex
    ? { sourceSide: "right" as const, targetSide: "left" as const }
    : { sourceSide: "left" as const, targetSide: "right" as const };
}

function allocateHandle(nodeId: string, kind: HandleKind, side: HandleSide, handleUseCount: Map<string, number>) {
  const key = `${nodeId}:${side}`;
  const count = handleUseCount.get(key) ?? 0;
  handleUseCount.set(key, count + 1);
  const slot = count % HANDLE_SLOT_COUNT;
  return {
    id: `${kind}-${side}-${slot}`,
    slot,
  };
}

function routeEdge(
  edge: FlowEdge,
  source: LayoutNodeMeta,
  target: LayoutNodeMeta,
  sourceSide: HandleSide,
  targetSide: HandleSide,
  sourceSlot: number,
  targetSlot: number,
  occupiedCells: Set<string>,
  gutterTrackReservations: GutterTrackReservations,
  decisionBranch?: DecisionBranchInfo,
  isDirectDecisionTarget = false,
) {
  const sourcePoint = anchorPoint(source, sourceSide, sourceSlot);
  const targetPoint = anchorPoint(target, targetSide, targetSlot);

  if (decisionBranch && decisionBranch.total > 1) {
    const decisionRoute = routeDecisionBranch(
      source,
      target,
      sourcePoint,
      targetPoint,
      targetSide,
      decisionBranch,
      gutterTrackReservations,
      isDirectDecisionTarget,
      edge.edge_type,
    );
    return {
      points: decisionRoute.points,
      labelPoint: decisionRoute.labelPoint,
    };
  }

  const points =
    isVerticalHandoff(sourceSide, targetSide)
      ? routeBottomToTop(source, target, sourcePoint, targetPoint, occupiedCells, gutterTrackReservations)
      : routeSideToSide(
          edge,
          source,
          target,
          sourcePoint,
          targetPoint,
          sourceSide,
          targetSide,
          occupiedCells,
          gutterTrackReservations,
        );

  return {
    points,
    labelPoint: longestSegmentMidpoint(points),
  };
}

function isVerticalHandoff(sourceSide: HandleSide, targetSide: HandleSide) {
  return (sourceSide === "bottom" && targetSide === "top") || (sourceSide === "top" && targetSide === "bottom");
}

function buildDecisionBranchMap(model: FlowModel, nodeMeta: Map<string, LayoutNodeMeta>) {
  const outgoingByDecisionId = new Map<string, FlowEdge[]>();

  model.edges.forEach((edge) => {
    const source = nodeMeta.get(edge.from);
    if (source?.type !== "decision") return;
    const outgoing = outgoingByDecisionId.get(edge.from) ?? [];
    outgoing.push(edge);
    outgoingByDecisionId.set(edge.from, outgoing);
  });

  const branchByEdgeId = new Map<string, DecisionBranchInfo>();
  outgoingByDecisionId.forEach((edges) => {
    if (edges.length < 2) return;
    const source = nodeMeta.get(edges[0]?.from ?? "");
    const indexedEdges = edges.map((edge, index) => ({ edge, index }));
    const directionGroups = new Map<DecisionBranchDirection, Array<{ edge: FlowEdge; index: number }>>();

    indexedEdges.forEach((item) => {
      const target = nodeMeta.get(item.edge.to);
      const direction = source && target ? decisionBranchDirection(source, target, item.index) : "right";
      const group = directionGroups.get(direction) ?? [];
      group.push(item);
      directionGroups.set(direction, group);
    });

    edges.forEach((edge, index) => {
      const target = nodeMeta.get(edge.to);
      const direction = source && target ? decisionBranchDirection(source, target, index) : "right";
      const directionGroup = [...(directionGroups.get(direction) ?? [])].sort((a, b) => {
        const targetA = nodeMeta.get(a.edge.to);
        const targetB = nodeMeta.get(b.edge.to);
        const targetRowDiff = (targetA?.row ?? 0) - (targetB?.row ?? 0);
        if (targetRowDiff !== 0) return targetRowDiff;
        const targetYDiff = (targetA?.y ?? 0) - (targetB?.y ?? 0);
        if (targetYDiff !== 0) return targetYDiff;
        return a.index - b.index;
      });
      const directionIndex = directionGroup.findIndex((item) => item.edge.id === edge.id);
      branchByEdgeId.set(edge.id, {
        index,
        total: edges.length,
        direction,
        directionIndex: Math.max(0, directionIndex),
        directionTotal: Math.max(1, directionGroup.length),
      });
    });
  });

  return branchByEdgeId;
}

function buildTopReservedTargetNodeIds(
  model: FlowModel,
  nodeMeta: Map<string, LayoutNodeMeta>,
  decisionBranchByEdgeId: Map<string, DecisionBranchInfo>,
) {
  const reservedNodeIds = new Set<string>();

  model.edges.forEach((edge) => {
    if (decisionBranchByEdgeId.has(edge.id)) return;

    const source = nodeMeta.get(edge.from);
    const target = nodeMeta.get(edge.to);
    const { targetSide } = chooseHandleSides(edge, source, target);
    if (targetSide === "top") {
      reservedNodeIds.add(edge.to);
    }
  });

  return reservedNodeIds;
}

function routeDecisionBranch(
  source: LayoutNodeMeta,
  target: LayoutNodeMeta,
  sourcePoint: Point,
  targetPoint: Point,
  targetSide: HandleSide,
  branch: DecisionBranchInfo,
  gutterTrackReservations: GutterTrackReservations,
  isDirectDecisionTarget = false,
  edgeType?: FlowEdge["edge_type"],
) {
  const branchBaseY = sourcePoint.y + DECISION_BRANCH_STEM_LENGTH;
  const splitPoint = {
    x: sourcePoint.x,
    y: branchBaseY,
  };
  const branchY = decisionBranchLineY(branchBaseY, branch);

  if (targetSide === "top" && isDirectDecisionTarget) {
    const points = compactRoute([
      sourcePoint,
      splitPoint,
      { x: sourcePoint.x, y: targetPoint.y },
      targetPoint,
    ]);
    return {
      points,
      labelPoint: longestSegmentMidpoint(points),
    };
  }

  const trackX = decisionBranchGutterTrackX(source, target, branch, branchY, targetPoint.y, gutterTrackReservations, edgeType);
  if (targetSide === "left" || targetSide === "right") {
    const points = compactRoute([
      sourcePoint,
      splitPoint,
      { x: splitPoint.x, y: branchY },
      { x: trackX, y: branchY },
      { x: trackX, y: targetPoint.y },
      targetPoint,
    ]);
    return {
      points,
      labelPoint: decisionBranchLabelPoint(splitPoint, trackX, branchY, branch),
    };
  }

  const targetCorridorY = source.row < target.row ? rowTopCorridorY(target.row) : branchY;
  const points = compactRoute([
    sourcePoint,
    splitPoint,
    { x: splitPoint.x, y: branchY },
    { x: trackX, y: branchY },
    ...(targetCorridorY === branchY ? [] : [{ x: trackX, y: targetCorridorY }]),
    { x: targetPoint.x, y: targetCorridorY },
    targetPoint,
  ]);

  return {
    points,
    labelPoint: decisionBranchLabelPoint(splitPoint, trackX, branchY, branch),
  };
}

function decisionBranchTrackX(source: LayoutNodeMeta, target: LayoutNodeMeta, branch: DecisionBranchInfo) {
  if (target.laneIndex < source.laneIndex) return laneGutterX(source.laneIndex, "left");
  if (target.laneIndex > source.laneIndex) return laneGutterX(source.laneIndex, "right");

  const centerX = source.x + source.width / 2;
  const direction = branch.index % 2 === 0 ? -1 : 1;
  const distanceStep = Math.floor(branch.index / 2) + 1;
  const widestNodeHalfWidth = Math.max(source.width, target.width) / 2;
  return centerX + direction * (widestNodeHalfWidth + DECISION_BRANCH_TRACK_GAP * distanceStep);
}

function decisionBranchGutterTrackX(
  source: LayoutNodeMeta,
  target: LayoutNodeMeta,
  branch: DecisionBranchInfo,
  yA: number,
  yB: number,
  gutterTrackReservations: GutterTrackReservations,
  edgeType?: FlowEdge["edge_type"],
) {
  if (target.laneIndex < source.laneIndex) {
    return reserveLaneGutterX(source.laneIndex, "left", yA, yB, gutterTrackReservations);
  }
  if (target.laneIndex > source.laneIndex) {
    return reserveLaneGutterX(source.laneIndex, "right", yA, yB, gutterTrackReservations);
  }
  if (edgeType === "rollback") {
    return reserveLaneGutterX(source.laneIndex, "left", yA, yB, gutterTrackReservations);
  }
  return decisionBranchTrackX(source, target, branch);
}

function decisionBranchSide(
  source: LayoutNodeMeta,
  target: LayoutNodeMeta,
  branch: DecisionBranchInfo,
  edgeType?: FlowEdge["edge_type"],
): "left" | "right" {
  if (target.laneIndex < source.laneIndex) return "right";
  if (target.laneIndex > source.laneIndex) return "left";
  if (edgeType === "rollback") return "left";

  const trackX = decisionBranchTrackX(source, target, branch);
  const targetCenterX = target.x + target.width / 2;
  return trackX < targetCenterX ? "left" : "right";
}

function decisionBranchLineY(baseY: number, branch: DecisionBranchInfo) {
  if (branch.directionTotal <= 1) return baseY;
  return baseY + (branch.directionIndex - (branch.directionTotal - 1) / 2) * DECISION_BRANCH_LINE_GAP;
}

function decisionBranchDirection(source: LayoutNodeMeta, target: LayoutNodeMeta, branchIndex: number): DecisionBranchDirection {
  if (target.laneIndex < source.laneIndex) return "left";
  if (target.laneIndex > source.laneIndex) return "right";
  return branchIndex % 2 === 0 ? "left" : "right";
}

function decisionBranchLabelPoint(splitPoint: Point, trackX: number, branchY: number, branch: DecisionBranchInfo) {
  const directionSign = trackX < splitPoint.x ? -1 : 1;
  const segmentLength = Math.abs(trackX - splitPoint.x);
  const slotSize = segmentLength / (branch.directionTotal + 1);
  const labelX = splitPoint.x + directionSign * slotSize * (branch.directionIndex + 1);

  return {
    x: labelX,
    y: branchY,
  };
}

function isDirectlyBelowDecisionTarget(
  source: LayoutNodeMeta,
  target: LayoutNodeMeta,
  nodeMeta: Map<string, LayoutNodeMeta>,
) {
  const sourceCenterX = source.x + source.width / 2;
  const targetCenterX = target.x + target.width / 2;
  if (target.row <= source.row || Math.abs(sourceCenterX - targetCenterX) >= 1) {
    return false;
  }

  return !Array.from(nodeMeta.values()).some((node) => {
    if (node === source || node === target) return false;
    const nodeCenterX = node.x + node.width / 2;
    return Math.abs(nodeCenterX - sourceCenterX) < 1 && node.row > source.row && node.row < target.row;
  });
}

function routeBottomToTop(
  source: LayoutNodeMeta,
  target: LayoutNodeMeta,
  sourcePoint: Point,
  targetPoint: Point,
  occupiedCells: Set<string>,
  gutterTrackReservations: GutterTrackReservations,
) {
  const sourceCorridorY = source.row <= target.row ? rowBottomCorridorY(source.row) : rowTopCorridorY(source.row);
  const targetCorridorY = source.row <= target.row ? rowTopCorridorY(target.row) : rowBottomCorridorY(target.row);
  const targetLaneBlocked = hasOccupiedCellsInLaneBetween(occupiedCells, target.laneIndex, source.row, target.row);
  const sameLaneBlocked = source.laneIndex === target.laneIndex && targetLaneBlocked;

  if (source.laneIndex === target.laneIndex && !sameLaneBlocked) {
    return compactRoute([sourcePoint, { x: sourcePoint.x, y: targetPoint.y }, targetPoint]);
  }

  if (!targetLaneBlocked) {
    return compactRoute([
      sourcePoint,
      { x: sourcePoint.x, y: sourceCorridorY },
      { x: targetPoint.x, y: sourceCorridorY },
      { x: targetPoint.x, y: targetPoint.y },
      targetPoint,
    ]);
  }

  const gutterSide = target.laneIndex >= source.laneIndex ? "left" : "right";
  const gutterX = reserveLaneGutterX(target.laneIndex, gutterSide, sourceCorridorY, targetCorridorY, gutterTrackReservations);
  return compactRoute([
    sourcePoint,
    { x: sourcePoint.x, y: sourceCorridorY },
    { x: gutterX, y: sourceCorridorY },
    { x: gutterX, y: targetCorridorY },
    { x: targetPoint.x, y: targetCorridorY },
    { x: targetPoint.x, y: targetPoint.y },
    targetPoint,
  ]);
}

function routeSideToSide(
  edge: FlowEdge,
  source: LayoutNodeMeta,
  target: LayoutNodeMeta,
  sourcePoint: Point,
  targetPoint: Point,
  sourceSide: HandleSide,
  targetSide: HandleSide,
  occupiedCells: Set<string>,
  gutterTrackReservations: GutterTrackReservations,
) {
  const canUseDirectHandoff =
    source.row === target.row &&
    source.laneIndex !== target.laneIndex &&
    !hasOccupiedCellsAcrossLanes(occupiedCells, source.row, source.laneIndex, target.laneIndex);

  if (canUseDirectHandoff) {
    return directOrthogonalRoute(sourcePoint, targetPoint);
  }

  const sourceGutterSide = horizontalSide(sourceSide, target.laneIndex - source.laneIndex);
  const targetGutterSide = horizontalSide(targetSide, source.laneIndex - target.laneIndex);
  const corridorY =
    edge.edge_type === "rollback" || target.row <= source.row
      ? rowBottomCorridorY(Math.min(source.row, target.row))
      : rowBottomCorridorY(source.row);
  const shared = sharedGutterReservation(source, target, sourceGutterSide, targetGutterSide);
  const sharedGutterX = shared
    ? reserveLaneGutterX(
        shared.laneIndex,
        shared.side,
        Math.min(sourcePoint.y, targetPoint.y, corridorY),
        Math.max(sourcePoint.y, targetPoint.y, corridorY),
        gutterTrackReservations,
      )
    : undefined;
  const sourceGutterX =
    sharedGutterX ??
    reserveLaneGutterX(source.laneIndex, sourceGutterSide, sourcePoint.y, corridorY, gutterTrackReservations);
  const targetGutterX =
    sharedGutterX ??
    reserveLaneGutterX(target.laneIndex, targetGutterSide, corridorY, targetPoint.y, gutterTrackReservations);

  return compactRoute([
    sourcePoint,
    { x: sourceGutterX, y: sourcePoint.y },
    { x: sourceGutterX, y: corridorY },
    { x: targetGutterX, y: corridorY },
    { x: targetGutterX, y: targetPoint.y },
    targetPoint,
  ]);
}

function anchorPoint(node: LayoutNodeMeta, side: HandleSide, slot: number) {
  const percent = HANDLE_PERCENT_BY_SLOT[slot] ?? HANDLE_PERCENT_BY_SLOT[0];
  if (side === "top") return { x: node.x + node.width * percent, y: node.y };
  if (side === "bottom") return { x: node.x + node.width * percent, y: node.y + node.height };
  if (side === "left") return { x: node.x, y: node.y + node.height * percent };
  return { x: node.x + node.width, y: node.y + node.height * percent };
}

function horizontalSide(side: HandleSide, laneDirection: number): GutterSide {
  if (side === "left" || side === "right") return side;
  return laneDirection < 0 ? "left" : "right";
}

function sharedGutterReservation(
  source: LayoutNodeMeta,
  target: LayoutNodeMeta,
  sourceGutterSide: GutterSide,
  targetGutterSide: GutterSide,
): { laneIndex: number; side: GutterSide } | undefined {
  if (source.laneIndex === target.laneIndex && sourceGutterSide === targetGutterSide) {
    return { laneIndex: source.laneIndex, side: sourceGutterSide };
  }
  if (
    source.laneIndex + 1 === target.laneIndex &&
    sourceGutterSide === "right" &&
    targetGutterSide === "left"
  ) {
    return { laneIndex: source.laneIndex, side: "right" };
  }
  if (
    target.laneIndex + 1 === source.laneIndex &&
    sourceGutterSide === "left" &&
    targetGutterSide === "right"
  ) {
    return { laneIndex: target.laneIndex, side: "right" };
  }
  return undefined;
}

function laneGutterX(laneIndex: number, side: GutterSide, track = 0) {
  const laneX = laneIndex * LANE_WIDTH;
  const baseX = side === "left" ? laneX + LANE_GUTTER_OFFSET : laneX + LANE_WIDTH - LANE_GUTTER_OFFSET;
  const trackDirection = side === "left" ? -1 : 1;
  return baseX + trackDirection * track * GUTTER_TRACK_SPACING;
}

function reserveLaneGutterX(
  laneIndex: number,
  side: GutterSide,
  yA: number,
  yB: number,
  gutterTrackReservations: GutterTrackReservations,
) {
  const startY = Math.min(yA, yB);
  const endY = Math.max(yA, yB);
  const key = `${laneIndex}:${side}`;
  const tracks = gutterTrackReservations.get(key) ?? [];
  const trackIndex = findAvailableGutterTrack(tracks, startY, endY);
  const track = tracks[trackIndex] ?? [];
  track.push({ startY, endY });
  tracks[trackIndex] = track;
  gutterTrackReservations.set(key, tracks);
  return laneGutterX(laneIndex, side, trackIndex);
}

function findAvailableGutterTrack(tracks: GutterTrackReservation[][], startY: number, endY: number) {
  const paddedStartY = startY - 8;
  const paddedEndY = endY + 8;
  const trackIndex = tracks.findIndex((track) =>
    track.every((reservation) => !rangesOverlap(paddedStartY, paddedEndY, reservation.startY, reservation.endY)),
  );

  return trackIndex >= 0 ? trackIndex : tracks.length;
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number) {
  return startA < endB && endA > startB;
}

function resolveSegmentOverlaps(edges: Edge<FlowEdgeData>[]) {
  const mutableEdges = edges.map((edge) => ({
    ...edge,
    data: edge.data
      ? {
          ...edge.data,
          routePath: edge.data.routePath?.map((point) => ({ ...point })),
        }
      : edge.data,
  }));

  resolveHorizontalSegmentOverlaps(mutableEdges);
  resolveVerticalSegmentOverlaps(mutableEdges);
  resolveEndpointVerticalOverlaps(mutableEdges);

  return mutableEdges.map((edge) => {
    if (!edge.data?.routePath) return edge;
    const routePath = compactRoute(edge.data.routePath);
    return {
      ...edge,
      data: {
        ...edge.data,
        routePath,
        labelPoint: edge.data.labelPoint,
      },
    };
  });
}

function resolveHorizontalSegmentOverlaps(edges: Edge<FlowEdgeData>[]) {
  const mutableEdges = edges;
  const segmentRefs = collectHorizontalSegmentRefs(mutableEdges);
  const refsByY = new Map<number, HorizontalSegmentRef[]>();

  segmentRefs.forEach((segmentRef) => {
    const yKey = Math.round(segmentRef.y);
    const refs = refsByY.get(yKey) ?? [];
    refs.push(segmentRef);
    refsByY.set(yKey, refs);
  });

  refsByY.forEach((refs) => {
    const sortedRefs = [...refs].sort((a, b) => {
      const startDiff = a.startX - b.startX;
      if (startDiff !== 0) return startDiff;
      const lengthA = a.endX - a.startX;
      const lengthB = b.endX - b.startX;
      return lengthB - lengthA;
    });
    const trackIntervals: Array<Array<{ startX: number; endX: number }>> = [];

    sortedRefs.forEach((segmentRef) => {
      const trackIndex = findAvailableSegmentTrack(trackIntervals, segmentRef.startX, segmentRef.endX);
      const intervals = trackIntervals[trackIndex] ?? [];
      intervals.push({ startX: segmentRef.startX, endX: segmentRef.endX });
      trackIntervals[trackIndex] = intervals;

      if (trackIndex === 0) return;
      offsetHorizontalSegment(mutableEdges, segmentRef, segmentTrackOffset(trackIndex));
    });
  });
}

function resolveVerticalSegmentOverlaps(edges: Edge<FlowEdgeData>[]) {
  const segmentRefs = collectVerticalSegmentRefs(edges);
  const refClusters = clusterVerticalSegmentRefs(segmentRefs);

  refClusters.forEach(({ baseX, refs }) => {
    const sortedRefs = [...refs].sort((a, b) => {
      const startDiff = a.startY - b.startY;
      if (startDiff !== 0) return startDiff;
      const lengthA = a.endY - a.startY;
      const lengthB = b.endY - b.startY;
      return lengthB - lengthA;
    });
    const trackIntervals: Array<Array<{ startY: number; endY: number }>> = [];

    sortedRefs.forEach((segmentRef) => {
      const trackIndex = findAvailableVerticalSegmentTrack(trackIntervals, segmentRef.startY, segmentRef.endY);
      const intervals = trackIntervals[trackIndex] ?? [];
      intervals.push({ startY: segmentRef.startY, endY: segmentRef.endY });
      trackIntervals[trackIndex] = intervals;

      if (trackIndex === 0) return;
      offsetVerticalSegment(edges, segmentRef, baseX + segmentTrackOffset(trackIndex) - segmentRef.x);
    });
  });
}

function clusterVerticalSegmentRefs(segmentRefs: VerticalSegmentRef[]) {
  const sortedRefs = [...segmentRefs].sort((a, b) => a.x - b.x);
  const clusters: Array<{ baseX: number; refs: VerticalSegmentRef[] }> = [];

  sortedRefs.forEach((segmentRef) => {
    const cluster = clusters.find((item) => Math.abs(segmentRef.x - item.baseX) < SEGMENT_TRACK_SPACING);
    if (cluster) {
      cluster.refs.push(segmentRef);
      return;
    }

    clusters.push({
      baseX: segmentRef.x,
      refs: [segmentRef],
    });
  });

  return clusters;
}

function collectHorizontalSegmentRefs(edges: Edge<FlowEdgeData>[]) {
  const segmentRefs: HorizontalSegmentRef[] = [];

  edges.forEach((edge, edgeIndex) => {
    const points = edge.data?.routePath;
    if (!points || points.length < 2) return;
    let skippedDecisionBranchSegment = false;

    for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
      const start = points[pointIndex];
      const end = points[pointIndex + 1];
      if (start.y !== end.y) continue;
      if (edge.data?.skipHorizontalOverlapResolve && !skippedDecisionBranchSegment) {
        skippedDecisionBranchSegment = true;
        continue;
      }

      const startX = Math.min(start.x, end.x);
      const endX = Math.max(start.x, end.x);
      if (endX - startX < MIN_OVERLAP_SEGMENT_LENGTH) continue;

      segmentRefs.push({
        edgeIndex,
        pointIndex,
        y: start.y,
        startX,
        endX,
      });
    }
  });

  return segmentRefs;
}

function collectVerticalSegmentRefs(edges: Edge<FlowEdgeData>[]) {
  const segmentRefs: VerticalSegmentRef[] = [];

  edges.forEach((edge, edgeIndex) => {
    const points = edge.data?.routePath;
    if (!points || points.length < 4) return;

    for (let pointIndex = 1; pointIndex < points.length - 2; pointIndex += 1) {
      const start = points[pointIndex];
      const end = points[pointIndex + 1];
      if (start.x !== end.x) continue;

      const startY = Math.min(start.y, end.y);
      const endY = Math.max(start.y, end.y);
      if (endY - startY < MIN_OVERLAP_SEGMENT_LENGTH) continue;

      segmentRefs.push({
        edgeIndex,
        pointIndex,
        x: start.x,
        startY,
        endY,
      });
    }
  });

  return segmentRefs;
}

function resolveEndpointVerticalOverlaps(edges: Edge<FlowEdgeData>[]) {
  const refs = collectEndpointVerticalSegmentRefs(edges);
  refs.forEach((ref, index) => {
    const overlappingRefs = refs.filter((other, otherIndex) =>
      otherIndex < index &&
      other.edgeIndex !== ref.edgeIndex &&
      other.x === ref.x &&
      rangesOverlap(ref.startY, ref.endY, other.startY, other.endY),
    );
    if (!overlappingRefs.length) return;

    const refLength = ref.endY - ref.startY;
    const otherLength = Math.max(...overlappingRefs.map((other) => other.endY - other.startY));
    const targetRef = ref.endpoint === "target" || refLength <= otherLength ? ref : overlappingRefs[0];
    shortenEndpointVerticalSegment(edges, targetRef);
  });
}

function collectEndpointVerticalSegmentRefs(edges: Edge<FlowEdgeData>[]) {
  const refs: EndpointVerticalSegmentRef[] = [];

  edges.forEach((edge, edgeIndex) => {
    if (edge.data?.skipHorizontalOverlapResolve) return;
    const points = edge.data?.routePath;
    if (!points || points.length < 3) return;

    const first = endpointVerticalSegmentRef(points, edgeIndex, 0, "source");
    if (first) refs.push(first);

    const lastPointIndex = points.length - 2;
    const last = endpointVerticalSegmentRef(points, edgeIndex, lastPointIndex, "target");
    if (last) refs.push(last);
  });

  return refs;
}

function endpointVerticalSegmentRef(
  points: Point[],
  edgeIndex: number,
  pointIndex: number,
  endpoint: "source" | "target",
): EndpointVerticalSegmentRef | undefined {
  const start = points[pointIndex];
  const end = points[pointIndex + 1];
  if (!start || !end || start.x !== end.x) return undefined;

  const startY = Math.min(start.y, end.y);
  const endY = Math.max(start.y, end.y);
  if (endY - startY <= ENDPOINT_STUB_LENGTH) return undefined;

  return {
    edgeIndex,
    pointIndex,
    endpoint,
    x: start.x,
    startY,
    endY,
  };
}

function shortenEndpointVerticalSegment(edges: Edge<FlowEdgeData>[], segmentRef: EndpointVerticalSegmentRef) {
  const edge = edges[segmentRef.edgeIndex];
  const points = edge.data?.routePath;
  if (!points) return;

  if (segmentRef.endpoint === "source") {
    shortenFirstVerticalEndpoint(points);
  } else {
    shortenLastVerticalEndpoint(points);
  }
}

function shortenFirstVerticalEndpoint(points: Point[]) {
  const start = points[0];
  const end = points[1];
  const next = points[2];
  if (!start || !end || !next) return;
  if (start.x !== end.x || next.y !== end.y) return;
  if (Math.abs(end.y - start.y) <= ENDPOINT_STUB_LENGTH) return;

  const direction = end.y >= start.y ? 1 : -1;
  const stubY = start.y + direction * ENDPOINT_STUB_LENGTH;
  points[1] = { ...end, y: stubY };
  points[2] = { ...next, y: stubY };
}

function shortenLastVerticalEndpoint(points: Point[]) {
  const endIndex = points.length - 1;
  const start = points[endIndex - 1];
  const end = points[endIndex];
  const previous = points[endIndex - 2];
  if (!previous || !start || !end) return;
  if (start.x !== end.x || previous.y !== start.y) return;
  if (Math.abs(end.y - start.y) <= ENDPOINT_STUB_LENGTH) return;

  const direction = end.y >= start.y ? 1 : -1;
  const stubY = end.y - direction * ENDPOINT_STUB_LENGTH;
  points[endIndex - 2] = { ...previous, y: stubY };
  points[endIndex - 1] = { ...start, y: stubY };
}

function findAvailableSegmentTrack(trackIntervals: Array<Array<{ startX: number; endX: number }>>, startX: number, endX: number) {
  const paddedStartX = startX - 8;
  const paddedEndX = endX + 8;
  const trackIndex = trackIntervals.findIndex((intervals) =>
    intervals.every((interval) => !rangesOverlap(paddedStartX, paddedEndX, interval.startX, interval.endX)),
  );

  return trackIndex >= 0 ? trackIndex : trackIntervals.length;
}

function findAvailableVerticalSegmentTrack(
  trackIntervals: Array<Array<{ startY: number; endY: number }>>,
  startY: number,
  endY: number,
) {
  const paddedStartY = startY - 8;
  const paddedEndY = endY + 8;
  const trackIndex = trackIntervals.findIndex((intervals) =>
    intervals.every((interval) => !rangesOverlap(paddedStartY, paddedEndY, interval.startY, interval.endY)),
  );

  return trackIndex >= 0 ? trackIndex : trackIntervals.length;
}

function segmentTrackOffset(trackIndex: number) {
  const magnitude = Math.ceil(trackIndex / 2) * SEGMENT_TRACK_SPACING;
  return trackIndex % 2 === 1 ? -magnitude : magnitude;
}

function offsetHorizontalSegment(edges: Edge<FlowEdgeData>[], segmentRef: HorizontalSegmentRef, offsetY: number) {
  const edge = edges[segmentRef.edgeIndex];
  const points = edge.data?.routePath;
  if (!points) return;

  const pointIndex = findHorizontalSegmentIndex(points, segmentRef);
  if (pointIndex < 0) return;

  const isFirstSegment = pointIndex === 0;
  const isLastSegment = pointIndex === points.length - 2;
  const start = points[pointIndex];
  const end = points[pointIndex + 1];
  const nextY = start.y + offsetY;

  if (isFirstSegment || isLastSegment) {
    const direction = end.x >= start.x ? 1 : -1;
    if (isFirstSegment) {
      const stubX = start.x + direction * ENDPOINT_STUB_LENGTH;
      points.splice(pointIndex, 2, start, { x: stubX, y: start.y }, { x: stubX, y: nextY }, { x: end.x, y: nextY }, end);
    } else {
      const stubX = end.x - direction * ENDPOINT_STUB_LENGTH;
      points.splice(pointIndex, 2, start, { x: start.x, y: nextY }, { x: stubX, y: nextY }, { x: stubX, y: end.y }, end);
    }
  } else {
    points[pointIndex] = { ...start, y: nextY };
    points[pointIndex + 1] = { ...end, y: nextY };
  }

  const labelPoint = edge.data?.labelPoint;
  const startX = Math.min(start.x, end.x);
  const endX = Math.max(start.x, end.x);
  if (edge.data && labelPoint && Math.abs(labelPoint.y - start.y) < 1 && labelPoint.x >= startX - 1 && labelPoint.x <= endX + 1) {
    edge.data = {
      ...edge.data,
      labelPoint: {
        x: labelPoint.x,
        y: labelPoint.y + offsetY,
      },
    };
  }
}

function findHorizontalSegmentIndex(points: Point[], segmentRef: HorizontalSegmentRef) {
  const currentStart = points[segmentRef.pointIndex];
  const currentEnd = points[segmentRef.pointIndex + 1];
  if (isSameSegment(currentStart, currentEnd, segmentRef)) return segmentRef.pointIndex;

  return points.findIndex((point, index) => isSameSegment(point, points[index + 1], segmentRef));
}

function isSameSegment(start: Point | undefined, end: Point | undefined, segmentRef: HorizontalSegmentRef) {
  if (!start || !end) return false;
  return (
    start.y === segmentRef.y &&
    end.y === segmentRef.y &&
    Math.min(start.x, end.x) === segmentRef.startX &&
    Math.max(start.x, end.x) === segmentRef.endX
  );
}

function offsetVerticalSegment(edges: Edge<FlowEdgeData>[], segmentRef: VerticalSegmentRef, offsetX: number) {
  const edge = edges[segmentRef.edgeIndex];
  const points = edge.data?.routePath;
  if (!points) return;

  const pointIndex = findVerticalSegmentIndex(points, segmentRef);
  if (pointIndex < 0) return;

  const isFirstSegment = pointIndex === 0;
  const isLastSegment = pointIndex === points.length - 2;
  const start = points[pointIndex];
  const end = points[pointIndex + 1];
  const nextX = start.x + offsetX;

  if (isFirstSegment || isLastSegment) {
    const direction = end.y >= start.y ? 1 : -1;
    if (isFirstSegment) {
      const stubY = start.y + direction * ENDPOINT_STUB_LENGTH;
      const next = points[pointIndex + 2];
      if (next && next.y === end.y) {
        points[pointIndex + 1] = { ...end, y: stubY };
        points[pointIndex + 2] = { ...next, y: stubY };
      } else {
        points[pointIndex + 1] = { ...end, y: stubY };
      }
    } else {
      const stubY = end.y - direction * ENDPOINT_STUB_LENGTH;
      const previous = points[pointIndex - 1];
      if (previous && previous.y === start.y) {
        points[pointIndex - 1] = { ...previous, y: stubY };
        points[pointIndex] = { ...start, y: stubY };
      } else {
        points[pointIndex] = { ...start, y: stubY };
      }
    }
  } else {
    points[pointIndex] = { ...start, x: nextX };
    points[pointIndex + 1] = { ...end, x: nextX };
  }

  const labelPoint = edge.data?.labelPoint;
  const startY = Math.min(start.y, end.y);
  const endY = Math.max(start.y, end.y);
  if (edge.data && labelPoint && Math.abs(labelPoint.x - start.x) < 1 && labelPoint.y >= startY - 1 && labelPoint.y <= endY + 1) {
    edge.data = {
      ...edge.data,
      labelPoint: {
        x: labelPoint.x + offsetX,
        y: labelPoint.y,
      },
    };
  }
}

function findVerticalSegmentIndex(points: Point[], segmentRef: VerticalSegmentRef) {
  const currentStart = points[segmentRef.pointIndex];
  const currentEnd = points[segmentRef.pointIndex + 1];
  if (isSameVerticalSegment(currentStart, currentEnd, segmentRef)) return segmentRef.pointIndex;

  return points.findIndex((point, index) => isSameVerticalSegment(point, points[index + 1], segmentRef));
}

function isSameVerticalSegment(start: Point | undefined, end: Point | undefined, segmentRef: VerticalSegmentRef) {
  if (!start || !end) return false;
  return (
    start.x === segmentRef.x &&
    end.x === segmentRef.x &&
    Math.min(start.y, end.y) === segmentRef.startY &&
    Math.max(start.y, end.y) === segmentRef.endY
  );
}

function rowTopY(row: number) {
  return LANE_HEADER_HEIGHT + NODE_TOP_PADDING + row * ROW_HEIGHT;
}

function rowTopCorridorY(row: number) {
  return Math.max(LANE_HEADER_HEIGHT + ROW_GUTTER_OFFSET, rowTopY(row) - ROW_GUTTER_OFFSET);
}

function rowBottomCorridorY(row: number) {
  return rowTopY(row) + ROW_HEIGHT - ROW_GUTTER_OFFSET;
}

function rowCenterY(row: number) {
  return rowTopY(row) + ROW_HEIGHT / 2;
}

function hasOccupiedCellsInLaneBetween(occupiedCells: Set<string>, laneIndex: number, rowA: number, rowB: number) {
  const start = Math.min(rowA, rowB) + 1;
  const end = Math.max(rowA, rowB);
  for (let row = start; row < end; row += 1) {
    if (occupiedCells.has(cellKey(laneIndex, row))) return true;
  }
  return false;
}

function hasOccupiedCellsAcrossLanes(occupiedCells: Set<string>, row: number, laneA: number, laneB: number) {
  const start = Math.min(laneA, laneB) + 1;
  const end = Math.max(laneA, laneB);
  for (let laneIndex = start; laneIndex < end; laneIndex += 1) {
    if (occupiedCells.has(cellKey(laneIndex, row))) return true;
  }
  return false;
}

function cellKey(laneIndex: number, row: number) {
  return `${laneIndex}:${row}`;
}

function directOrthogonalRoute(sourcePoint: Point, targetPoint: Point) {
  if (sourcePoint.x === targetPoint.x || sourcePoint.y === targetPoint.y) {
    return compactRoute([sourcePoint, targetPoint]);
  }

  const midX = (sourcePoint.x + targetPoint.x) / 2;
  return compactRoute([
    sourcePoint,
    { x: midX, y: sourcePoint.y },
    { x: midX, y: targetPoint.y },
    targetPoint,
  ]);
}

function compactRoute(points: Point[]) {
  const withoutDuplicates = points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });

  return withoutDuplicates.filter((point, index) => {
    const previous = withoutDuplicates[index - 1];
    const next = withoutDuplicates[index + 1];
    if (!previous || !next) return true;
    const isVertical = previous.x === point.x && point.x === next.x;
    const isHorizontal = previous.y === point.y && point.y === next.y;
    return !isVertical && !isHorizontal;
  });
}

function longestSegmentMidpoint(points: Point[]) {
  let bestIndex = 0;
  let bestLength = -1;

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const length = Math.abs(current.x - next.x) + Math.abs(current.y - next.y);
    if (length > bestLength) {
      bestIndex = index;
      bestLength = length;
    }
  }

  const current = points[bestIndex];
  const next = points[bestIndex + 1] ?? current;
  return {
    x: (current.x + next.x) / 2,
    y: (current.y + next.y) / 2,
  };
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
