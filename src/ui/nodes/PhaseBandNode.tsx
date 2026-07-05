import type { NodeProps } from "@xyflow/react";
import type { PhaseBandData } from "../../layout/flow-reactflow-types";

export function PhaseBandNode({ data }: NodeProps) {
  const { phase, bandIndex, width, height, showBoundary } = data as PhaseBandData;

  return (
    <div
      className={[
        "phase-band",
        bandIndex % 2 === 1 ? "phase-band--alt" : "",
        showBoundary ? "phase-band--boundary" : "",
      ].join(" ")}
      style={{ width, height }}
    >
      <span className="phase-band__chip">{phase.name}</span>
    </div>
  );
}
