import type { FlowEdge, FlowModel, FlowNode, SourceRef } from "../../domain/flow-model";

type Selection =
  | { type: "node"; item: FlowNode }
  | { type: "edge"; item: FlowEdge }
  | null;

type NodeDetailPanelProps = {
  model: FlowModel;
  selection: Selection;
};

export function NodeDetailPanel({ model, selection }: NodeDetailPanelProps) {
  if (!selection) {
    return (
      <aside className="detail-panel">
        <div className="panel-title">詳細</div>
        <p className="muted">ノードまたはエッジを選択すると、意味モデル上の情報を確認できます。</p>
      </aside>
    );
  }

  const sourceRefs = selection.item.source_refs ?? [];
  const sources = sourceRefs
    .map((ref) => model.sources?.find((source) => source.id === ref))
    .filter((source): source is SourceRef => Boolean(source));

  if (selection.type === "node") {
    const node = selection.item;
    const lane = model.lanes.find((item) => item.id === node.lane_id);
    const phase = model.phases.find((item) => item.id === node.phase_id);
    return (
      <aside className="detail-panel">
        <div className="panel-title">ノード詳細</div>
        <dl className="detail-list">
          <dt>ID</dt>
          <dd>{node.id}</dd>
          <dt>種別</dt>
          <dd>{node.type}</dd>
          <dt>ラベル</dt>
          <dd>{node.label}</dd>
          <dt>説明</dt>
          <dd>{node.description || "未設定"}</dd>
          <dt>レーン</dt>
          <dd>{lane?.name ?? node.lane_id}</dd>
          <dt>フェーズ</dt>
          <dd>{phase?.name ?? node.phase_id}</dd>
        </dl>
        <SourcePanel sources={sources} />
      </aside>
    );
  }

  const edge = selection.item;
  return (
    <aside className="detail-panel">
      <div className="panel-title">エッジ詳細</div>
      <dl className="detail-list">
        <dt>ID</dt>
        <dd>{edge.id}</dd>
        <dt>遷移</dt>
        <dd>
          {edge.from} → {edge.to}
        </dd>
        <dt>ラベル</dt>
        <dd>{edge.label || "未設定"}</dd>
        <dt>種別</dt>
        <dd>{edge.edge_type || "normal"}</dd>
        <dt>条件</dt>
        <dd>{edge.condition?.text || "未設定"}</dd>
      </dl>
      <SourcePanel sources={sources} />
    </aside>
  );
}

function SourcePanel({ sources }: { sources: SourceRef[] }) {
  return (
    <div className="source-panel">
      <div className="subhead">根拠資料</div>
      {sources.length === 0 ? (
        <p className="muted">根拠資料は未設定です。</p>
      ) : (
        <ul>
          {sources.map((source) => (
            <li key={source.id}>
              <strong>{source.file_name}</strong>
              <span>
                {source.page ? `p.${source.page}` : ""}
                {source.section ? ` ${source.section}` : ""}
              </span>
              {source.quote ? <blockquote>{source.quote}</blockquote> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
