import type { NodeProps } from "@xyflow/react";
import { Play } from "lucide-react";
import type { FlowNodeData } from "../../layout/flow-reactflow-types";
import { NodeHandles } from "./NodeHandles";

export function StartNode({ data, selected }: NodeProps) {
  const { node } = data as FlowNodeData;

  return (
    <div className={`terminal-node terminal-node--start ${selected ? "is-selected" : ""}`}>
      <NodeHandles />
      <Play size={16} aria-hidden="true" />
      <span>{node.label}</span>
    </div>
  );
}
