import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileInput, RefreshCcw } from "lucide-react";
import sampleFlow from "./data/sample-flow.json";
import type { FlowModel } from "./domain/flow-model";
import { parseFlowModelJson } from "./parsers/json-schema";
import { FlowCanvas } from "./ui/FlowCanvas";

const sampleJson = JSON.stringify(sampleFlow, null, 2);

export function App() {
  const [rawJson, setRawJson] = useState(sampleJson);
  const [activeModel, setActiveModel] = useState<FlowModel>(sampleFlow as FlowModel);
  const parsed = useMemo(() => parseFlowModelJson(rawJson), [rawJson]);

  const applyJson = () => {
    if (parsed.ok && parsed.validation.valid) {
      setActiveModel(parsed.model);
    }
  };

  return (
    <main className="app-shell">
      <aside className="editor-panel">
        <section className="editor-section">
          <div className="section-header">
            <h2>JSON</h2>
            <button type="button" className="icon-button" onClick={() => setRawJson(sampleJson)} title="サンプルに戻す">
              <RefreshCcw size={16} aria-hidden="true" />
            </button>
          </div>
          <textarea
            value={rawJson}
            onChange={(event) => setRawJson(event.target.value)}
            spellCheck={false}
            aria-label="flow_model.json"
          />
          <button type="button" className="primary-button" onClick={applyJson} disabled={!parsed.ok || !parsed.validation.valid}>
            <FileInput size={16} aria-hidden="true" />
            検証して描画
          </button>
        </section>

        <section className="editor-section validation-section">
          <h2>バリデーション</h2>
          {!parsed.ok ? (
            <div className="issue issue--error">
              <AlertTriangle size={16} aria-hidden="true" />
              {parsed.message}
            </div>
          ) : parsed.validation.issues.length === 0 ? (
            <div className="issue issue--ok">
              <CheckCircle2 size={16} aria-hidden="true" />
              エラーと警告はありません
            </div>
          ) : (
            <ul className="issue-list">
              {parsed.validation.issues.map((issue) => (
                <li className={`issue issue--${issue.level}`} key={`${issue.path}-${issue.message}`}>
                  <AlertTriangle size={15} aria-hidden="true" />
                  <span>
                    <strong>{issue.path}</strong>
                    {issue.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      <FlowCanvas model={activeModel} />
    </main>
  );
}
