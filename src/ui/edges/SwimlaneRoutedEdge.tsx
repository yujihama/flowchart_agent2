import { BaseEdge, type Edge, type EdgeProps } from "@xyflow/react";
import type { FlowEdgeData } from "../../layout/flow-reactflow-types";

type SwimlaneEdge = Edge<FlowEdgeData>;

const CORNER_RADIUS = 8;

/**
 * レイアウトエンジンが計算した折れ線(routePath)をそのまま描画する。
 * React Flow側の計測値からの再計算は一切行わない(描画の安定性のため)。
 */
export function SwimlaneRoutedEdge({
  id,
  data,
  label,
  markerEnd,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
}: EdgeProps<SwimlaneEdge>) {
  const points = data?.routePath?.length
    ? data.routePath
    : [
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY },
      ];
  const path = pointsToRoundedPath(points, CORNER_RADIUS);
  const labelPoint = data?.labelPoint ?? midpoint(points);

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={16} />
      {label ? (
        <text
          className="routed-edge-label"
          x={labelPoint.x}
          y={labelPoint.y}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {label}
        </text>
      ) : null}
    </>
  );
}

type Point = { x: number; y: number };

function midpoint(points: Point[]): Point {
  const first = points[0] ?? { x: 0, y: 0 };
  const last = points[points.length - 1] ?? first;
  return { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
}

/** 直交折れ線を、曲がり角に丸みを付けたSVGパスへ変換する */
function pointsToRoundedPath(points: Point[], radius: number) {
  if (points.length < 2) return "";
  const parts: string[] = [`M ${points[0].x} ${points[0].y}`];

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];

    const inLength = Math.abs(corner.x - previous.x) + Math.abs(corner.y - previous.y);
    const outLength = Math.abs(next.x - corner.x) + Math.abs(next.y - corner.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);

    if (r < 1) {
      parts.push(`L ${corner.x} ${corner.y}`);
      continue;
    }

    const inDx = Math.sign(corner.x - previous.x);
    const inDy = Math.sign(corner.y - previous.y);
    const outDx = Math.sign(next.x - corner.x);
    const outDy = Math.sign(next.y - corner.y);

    parts.push(
      `L ${corner.x - inDx * r} ${corner.y - inDy * r}`,
      `Q ${corner.x} ${corner.y} ${corner.x + outDx * r} ${corner.y + outDy * r}`,
    );
  }

  const last = points[points.length - 1];
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}
