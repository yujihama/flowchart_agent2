import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from "@xyflow/react";
import { Download } from "lucide-react";
import type { FlowEdge, FlowModel, FlowNode } from "../domain/flow-model";
import {
  createFlowExportBlob,
  createFlowExportFilename,
  FLOW_EXPORT_FORMATS,
  type FlowExportFormatId,
} from "../export/flow-exporters";
import { buildSwimlaneLayout } from "../layout/build-swimlane-layout";
import type { FlowEdgeData, FlowNodeData, LaneNodeData } from "../layout/flow-reactflow-types";
import { ProcessNode } from "./nodes/ProcessNode";
import { DecisionNode } from "./nodes/DecisionNode";
import { StartNode } from "./nodes/StartNode";
import { EndNode } from "./nodes/EndNode";
import { NodeDetailPanel } from "./panels/NodeDetailPanel";
import { LaneNode } from "./nodes/LaneNode";
import { SwimlaneRoutedEdge } from "./edges/SwimlaneRoutedEdge";

const nodeTypes = {
  processNode: ProcessNode,
  decisionNode: DecisionNode,
  startNode: StartNode,
  endNode: EndNode,
  laneNode: LaneNode,
};

const edgeTypes = {
  swimlaneRoutedEdge: SwimlaneRoutedEdge,
};

type Selection =
  | { type: "node"; item: FlowNode }
  | { type: "edge"; item: FlowEdge }
  | null;

type PreparedExport = {
  formatId: FlowExportFormatId;
  download: string;
  url: string;
};

export function FlowCanvas({ model }: { model: FlowModel }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowNodeData | LaneNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<FlowEdgeData>>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [layoutState, setLayoutState] = useState<"idle" | "running" | "failed">("idle");
  const [exportState, setExportState] = useState<"preparing" | "ready" | "failed">("preparing");
  const [preparedExports, setPreparedExports] = useState<PreparedExport[]>([]);

  useEffect(() => {
    setLayoutState("running");
    try {
      const mapped = buildSwimlaneLayout(model);
      setNodes(mapped.nodes);
      setEdges(mapped.edges);
      setSelection(null);
      setLayoutState("idle");
    } catch {
      setLayoutState("failed");
    }
  }, [model, setEdges, setNodes]);

  const minimapNodeColor = useCallback((node: Node<FlowNodeData | LaneNodeData>) => {
    if (node.data.kind === "lane") return "#e6edf2";
    const type = node.data.node.type;
    if (type === "decision") return "#f3b544";
    if (type === "start") return "#2f8f6f";
    if (type === "end") return "#7a4f9a";
    if (type === "system_process") return "#2f6f8f";
    return "#8aa0ad";
  }, []);

  const canvasMeta = useMemo(
    () => `${model.nodes.length} nodes / ${model.edges.length} edges / ${model.lanes.length} lanes`,
    [model],
  );

  useEffect(() => {
    let canceled = false;
    const createdUrls: string[] = [];

    setPreparedExports([]);
    if (layoutState !== "idle" || nodes.length === 0) {
      setExportState("preparing");
      return () => {
        createdUrls.forEach((url) => URL.revokeObjectURL(url));
      };
    }

    setExportState("preparing");
    Promise.all(
      FLOW_EXPORT_FORMATS.map(async (format) => {
        const blob = await createFlowExportBlob(format.id, { model, nodes, edges });
        const url = URL.createObjectURL(blob);
        createdUrls.push(url);
        if (canceled) {
          URL.revokeObjectURL(url);
        }
        return {
          formatId: format.id,
          download: createFlowExportFilename(format.id, model),
          url,
        };
      }),
    )
      .then((items) => {
        if (canceled) {
          items.forEach((item) => URL.revokeObjectURL(item.url));
          return;
        }
        setPreparedExports(items);
        setExportState("ready");
      })
      .catch((error) => {
        console.error("Flow export preparation failed", error);
        createdUrls.forEach((url) => URL.revokeObjectURL(url));
        if (!canceled) {
          setPreparedExports([]);
          setExportState("failed");
        }
      });

    return () => {
      canceled = true;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [edges, layoutState, model, nodes]);

  const getPreparedExport = useCallback(
    (formatId: FlowExportFormatId) => preparedExports.find((item) => item.formatId === formatId),
    [preparedExports],
  );

  const handleUnavailableDownload = useCallback(
    (event: { preventDefault: () => void }) => {
      if (exportState !== "ready") {
        event.preventDefault();
      }
    },
    [exportState],
  );

  const exportStatusLabel = useMemo(() => {
    if (exportState === "failed") return "出力準備失敗";
    if (exportState === "ready") return "出力準備完了";
    return "出力準備中";
  }, [exportState]);

  return (
    <ReactFlowProvider>
      <section className="canvas-shell">
        <header className="canvas-header">
          <div>
            <h1>{model.title}</h1>
            <p>{model.description || "説明は未設定です"}</p>
          </div>
          <div className="canvas-tools">
            <div className="canvas-meta">
              <span>{model.flow_id}</span>
              <span>{canvasMeta}</span>
              <span className={`layout-pill layout-pill--${layoutState}`}>
                {layoutState === "running" ? "swimlane layout" : layoutState === "failed" ? "layout failed" : "ready"}
              </span>
            </div>
            <div className="download-actions" aria-label="フロー図の出力">
              {FLOW_EXPORT_FORMATS.map((format) => {
                const prepared = getPreparedExport(format.id);
                const isReady = exportState === "ready" && Boolean(prepared);
                return (
                  <a
                    className={`download-button ${isReady ? "" : "download-button--disabled"}`}
                    key={format.id}
                    href={prepared?.url ?? "#"}
                    download={prepared?.download}
                    aria-disabled={!isReady}
                    onClick={handleUnavailableDownload}
                    title={isReady ? `${format.label}で出力` : exportStatusLabel}
                  >
                    <Download size={15} aria-hidden="true" />
                    {format.label}
                  </a>
                );
              })}
            </div>
          </div>
        </header>

        <div className="canvas-body">
          <div className="flow-stage">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_, node) => {
                if (node.data.kind === "flow") setSelection({ type: "node", item: node.data.node });
              }}
              onEdgeClick={(_, edge) => edge.data && setSelection({ type: "edge", item: edge.data.edge })}
              onPaneClick={() => setSelection(null)}
              fitView
              fitViewOptions={{ padding: 0.08 }}
              minZoom={0.05}
              maxZoom={2.5}
              nodesDraggable={false}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={22} size={1} color="#d5dee4" />
              <Controls showInteractive={false} />
              <MiniMap nodeColor={minimapNodeColor} pannable zoomable />
            </ReactFlow>
          </div>
          <NodeDetailPanel model={model} selection={selection} />
        </div>
      </section>
    </ReactFlowProvider>
  );
}
