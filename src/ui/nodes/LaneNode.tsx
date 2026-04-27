import type { NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import { LANE_PALETTE } from "../../layout/swimlane-constants";
import type { LaneNodeData } from "../../layout/flow-reactflow-types";

export function LaneNode({ data }: NodeProps) {
  const { lane, height, laneIndex, width } = data as LaneNodeData;
  const color = LANE_PALETTE[laneIndex % LANE_PALETTE.length];

  return (
    <div
      className={`lane-node lane-node--${lane.type}`}
      style={
        {
          height,
          width,
          "--lane-fill": color.fill,
          "--lane-header": color.header,
          "--lane-accent": color.accent,
          "--lane-chip": color.chip,
        } as CSSProperties
      }
    >
      <div className="lane-header">
        <span className="lane-id">{lane.id}</span>
        <strong>{lane.name}</strong>
        <small>{lane.type}</small>
      </div>
    </div>
  );
}
