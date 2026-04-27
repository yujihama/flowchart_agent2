# 業務フローチャート生成基盤

JSON正本から業務フローを検証し、横方向にレーン、縦方向にステップが進むスイムレーン形式でReact Flow表示する初期実装です。

## セットアップ

PowerShellの実行ポリシーで `npm` が止まる環境では `npm.cmd` を使います。

```powershell
npm.cmd install
npm.cmd run dev
```

Python用の仮想環境は `.venv` に作成します。現時点の実装はフロントエンド中心のため、Python依存ライブラリは追加していません。

## 主要機能

- `lanes / phases / nodes / edges / sources` を持つJSON正本の型定義
- 必須項目、ID重複、参照整合性、表示品質のバリデーション
- `decision` ノードと `edge.condition` による条件分岐表現
- レーンを横列、業務ステップを縦方向に配置するスイムレーン派生レイアウト
- UI上で「ルール」レイアウトと「ELK」レイアウトを切り替え
- React Flowによるノード/エッジ表示、選択、詳細パネル表示
- 編集用JSONテキストエリアとサンプルフロー

## ディレクトリ

```text
src/
  domain/
    flow-model.ts
    validators.ts
  parsers/
    json-schema.ts
  layout/
    build-elk-swimlane-layout.ts
    build-swimlane-layout.ts
    build-elk-graph.ts
    run-elk-layout.ts
    map-elk-to-reactflow.ts
  ui/
    FlowCanvas.tsx
    nodes/
    panels/
  data/
    sample-flow.json
```

詳細は [docs/architecture.md](docs/architecture.md) と [docs/json-model.md](docs/json-model.md) を参照してください。
