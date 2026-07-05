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
- 必須項目、ID重複、参照整合性、条件式、自己ループ、表示品質のバリデーション
- `decision` ノードと `edge.condition` による条件分岐表現
- レーンを横列、業務ステップを縦方向に配置するスイムレーン派生レイアウト(サイクルを含むグラフでも安定動作)
- フェーズ帯の可視化(交互の背景色・境界線・フェーズ名チップ。SVG/XLSX出力にも反映)
- React Flowによるノード/エッジ表示、選択、詳細パネル表示
- 選択したノード/エッジに関連する要素だけを強調するフォーカスモードと凡例パネル
- スクロール=パン(縦長フロー向け)、ミニマップ、全体フィット表示
- PNG / SVG / XLSX(図形オブジェクト付き)エクスポート
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
    build-swimlane-layout.ts
    swimlane-constants.ts
    flow-reactflow-types.ts
  export/
    flow-exporters.ts
  ui/
    FlowCanvas.tsx
    edges/
    nodes/
    panels/
  data/
    sample-flow.json
```

詳細は [docs/architecture.md](docs/architecture.md) と [docs/json-model.md](docs/json-model.md) を参照してください。
