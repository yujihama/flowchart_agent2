import { BaseEdge, Position, useReactFlow, type Edge, type EdgeProps } from "@xyflow/react";
import type { FlowEdgeData } from "../../layout/flow-reactflow-types";

type SwimlaneEdge = Edge<FlowEdgeData>;

export function SwimlaneRoutedEdge({
  id,
  source,
  target,
  sourceHandleId,
  targetHandleId,
  data,
  label,
  markerEnd,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
}: EdgeProps<SwimlaneEdge>) {
  const { getInternalNode } = useReactFlow();
  const sNode = getInternalNode(source);
  const tNode = getInternalNode(target);
  const sourceSlot = parseSlot(sourceHandleId);
  const targetSlot = parseSlot(targetHandleId);
  const sourceAnchor = snapToBBoxEdge(sNode, sourcePosition, sourceSlot, sourceX, sourceY);
  const targetAnchor = snapToBBoxEdge(tNode, targetPosition, targetSlot, targetX, targetY);
  const points = reconcileEndpointPoints(
    data?.routePath?.length ? data.routePath : [sourceAnchor, targetAnchor],
    sourceAnchor,
    targetAnchor,
  );
  const path = pointsToSvgPath(points);
  const labelPoint = data?.labelPoint ?? longestSegmentMidpoint(points);

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={18} />
      {label ? (
        <text className="routed-edge-label" x={labelPoint.x} y={labelPoint.y} textAnchor="middle" dominantBaseline="central">
          {label}
        </text>
      ) : null}
    </>
  );
}

const SLOT_PERCENTS: Record<number, number> = { 0: 0.5, 1: 0.3, 2: 0.7 };
const ENDPOINT_OVERLAP = 2;

function parseSlot(handleId: string | null | undefined): number {
  if (!handleId) return 0;
  const m = handleId.match(/-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function snapToBBoxEdge(
  node: ReturnType<ReturnType<typeof useReactFlow>["getInternalNode"]>,
  position: Position,
  slot: number,
  fallbackX: number,
  fallbackY: number,
) {
  if (!node) return { x: fallbackX, y: fallbackY };
  const nx = node.internals?.positionAbsolute?.x ?? node.position?.x ?? 0;
  const ny = node.internals?.positionAbsolute?.y ?? node.position?.y ?? 0;
  const w = node.measured?.width ?? node.width ?? 0;
  const h = node.measured?.height ?? node.height ?? 0;
  if (!w || !h) return { x: fallbackX, y: fallbackY };
  const percent = SLOT_PERCENTS[slot] ?? 0.5;
  if (position === Position.Top) return { x: nx + w * percent, y: ny + ENDPOINT_OVERLAP };
  if (position === Position.Bottom) return { x: nx + w * percent, y: ny + h - ENDPOINT_OVERLAP };
  if (position === Position.Left) return { x: nx + ENDPOINT_OVERLAP, y: ny + h * percent };
  if (position === Position.Right) return { x: nx + w - ENDPOINT_OVERLAP, y: ny + h * percent };
  return { x: fallbackX, y: fallbackY };
}

function reconcileEndpointPoints(
  routePoints: Array<{ x: number; y: number }>,
  actualSource: { x: number; y: number },
  actualTarget: { x: number; y: number },
) {
  const points = routePoints.map((point) => ({ ...point }));
  if (points.length < 2) return [actualSource, actualTarget];
  if (points.length === 2) return orthogonalizePoints([actualSource, actualTarget]);

  const first = points[0];
  const second = points[1];
  const last = points[points.length - 1];
  const beforeLast = points[points.length - 2];

  points[0] = actualSource;
  if (first.x === second.x) {
    points[1] = { ...second, x: actualSource.x };
  } else if (first.y === second.y) {
    points[1] = { ...second, y: actualSource.y };
  }

  points[points.length - 1] = actualTarget;
  if (beforeLast.x === last.x) {
    points[points.length - 2] = { ...beforeLast, x: actualTarget.x };
  } else if (beforeLast.y === last.y) {
    points[points.length - 2] = { ...beforeLast, y: actualTarget.y };
  }

  return orthogonalizePoints(points);
}

function pointsToSvgPath(points: Array<{ x: number; y: number }>) {
  return compactPoints(points)
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

function longestSegmentMidpoint(points: Array<{ x: number; y: number }>) {
  const compacted = compactPoints(points);
  let bestIndex = 0;
  let bestLength = -1;

  for (let index = 0; index < compacted.length - 1; index += 1) {
    const current = compacted[index];
    const next = compacted[index + 1];
    const length = Math.abs(current.x - next.x) + Math.abs(current.y - next.y);
    if (length > bestLength) {
      bestIndex = index;
      bestLength = length;
    }
  }

  const current = compacted[bestIndex];
  const next = compacted[bestIndex + 1] ?? current;
  return {
    x: (current.x + next.x) / 2,
    y: (current.y + next.y) / 2,
  };
}

function orthogonalizePoints(points: Array<{ x: number; y: number }>) {
  const compacted = compactPoints(points);
  if (compacted.length < 2) return compacted;

  const orthogonal = [compacted[0]];
  for (let index = 1; index < compacted.length; index += 1) {
    const previous = orthogonal[orthogonal.length - 1];
    const current = compacted[index];
    if (previous.x !== current.x && previous.y !== current.y) {
      const midX = (previous.x + current.x) / 2;
      orthogonal.push({ x: midX, y: previous.y }, { x: midX, y: current.y });
    }
    orthogonal.push(current);
  }

  return compactCollinearPoints(compactPoints(orthogonal));
}

function compactPoints(points: Array<{ x: number; y: number }>) {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
}

function compactCollinearPoints(points: Array<{ x: number; y: number }>) {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    const next = points[index + 1];
    if (!previous || !next) return true;
    const isVertical = previous.x === point.x && point.x === next.x;
    const isHorizontal = previous.y === point.y && point.y === next.y;
    return !isVertical && !isHorizontal;
  });
}
