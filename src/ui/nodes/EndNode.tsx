import type { NodeProps } from "@xyflow/react";
import { CircleStop } from "lucide-react";
import type { FlowNodeData } from "../../layout/flow-reactflow-types";
import { NodeHandles } from "./NodeHandles";

export function EndNode({ data, selected }: NodeProps) {
  const { node } = data as FlowNodeData;

  return (
    <div className={`terminal-node terminal-node--end ${selected ? "is-selected" : ""}`}>
      <NodeHandles />
      <CircleStop size={16} aria-hidden="true" />
      <span>{node.label}</span>
    </div>
  );
}
