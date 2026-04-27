import type { NodeProps } from "@xyflow/react";
import type { FlowNodeData } from "../../layout/flow-reactflow-types";
import { NodeHandles } from "./NodeHandles";

export function DecisionNode({ data, selected }: NodeProps) {
  const { node } = data as FlowNodeData;

  return (
    <div className={`decision-shell ${selected ? "is-selected" : ""}`}>
      <NodeHandles />
      <svg className="decision-diamond" viewBox="0 0 225 92" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="112.5,0 225,46 112.5,92 0,46" />
      </svg>
      <div className="decision-text">{node.label}</div>
    </div>
  );
}
