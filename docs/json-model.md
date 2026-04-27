# JSON正本モデル

## ルート

```json
{
  "schema_version": "1.0",
  "flow_id": "purchase-approval-demo",
  "title": "購買申請承認フロー",
  "description": "任意の説明",
  "lanes": [],
  "phases": [],
  "nodes": [],
  "edges": [],
  "sources": []
}
```

## 重要ルール

- 正本JSONには座標や色などの描画情報を保存しません。
- `node.lane_id` は `lanes.id` を参照します。
- `node.phase_id` は `phases.id` を参照します。
- `edge.from` と `edge.to` は `nodes.id` を参照します。
- `source_refs` は `sources.id` を参照します。
- 判断点は `type: "decision"` のノードで表します。
- 判断結果や分岐条件は `edge.label` と `edge.condition.text` に置きます。
- 差戻しは `edge_type: "rollback"` を推奨します。

## 条件分岐例

```json
{
  "id": "E004",
  "from": "N004",
  "to": "N006",
  "label": "承認",
  "edge_type": "normal",
  "condition": {
    "type": "text",
    "text": "承認条件を満たす"
  }
}
```
