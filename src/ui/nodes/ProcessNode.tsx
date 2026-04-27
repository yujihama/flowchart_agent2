import type { NodeProps } from "@xyflow/react";
import { FileText, MonitorCog, SquareActivity } from "lucide-react";
import type { FlowNodeData } from "../../layout/flow-reactflow-types";
import { NodeHandles } from "./NodeHandles";

export function ProcessNode({ data, selected }: NodeProps) {
  const { node, laneName, phaseName } = data as FlowNodeData;
  const Icon = node.type === "document" ? FileText : node.type === "system_process" ? MonitorCog : SquareActivity;

  return (
    <div className={`flow-node process-node process-node--${node.type} ${selected ? "is-selected" : ""}`}>
      <NodeHandles />
      <div className="node-kicker">
        <Icon size={14} aria-hidden="true" />
        {laneName} / {phaseName}
      </div>
      <div className="node-label">{node.label}</div>
      {node.description ? <div className="node-description">{node.description}</div> : null}
    </div>
  );
}
