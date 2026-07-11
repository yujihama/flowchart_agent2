# flow_model.json 生成エージェント

業務プロセスの説明文(規程・手順書の要約など)から、フローチャート生成基盤の正本データ
`flow_model.json` を生成するエージェント。LangChain の `create_agent` で実装。

> 本ツールの正本インプットは YAML ではなく **JSON**(`flow_model.json`)のため、
> このエージェントは JSON を生成する。

## 仕組み

```
業務説明文 ──> create_agent(LLM) ──┬─> validate_flow_model_json ツール
                                   │     (UIと同一ルールの構文+整合性チェック)
                                   │       └─ NG → レポートを見て自律修正 → 再検証(ループ)
                                   └─> save_flow_model ツール
                                         (検証エラー0件のときだけ保存できる)
```

- 検証ロジック([flow_validator.py](flow_validator.py))はアプリ本体の
  `src/domain/validators.ts` の忠実な移植。**指摘内容(level/path/message)まで一致**
  することをテストで担保している
- 保存ツールが検証をゲートしているため、エラーが残る限り保存自体が不可能。
  エージェントはエラーが0件になるまで修正と再検証を繰り返す
- JSON構文エラーは行・列付きで報告され、同様に自律修正の対象になる

## セットアップ

```powershell
.venv\Scripts\python.exe -m pip install -r agent\requirements.txt
```

## 使い方

```powershell
.venv\Scripts\python.exe agent\flow_model_agent.py `
  --input agent\examples\expense_reimbursement.txt `
  --output out\flow_model.json `
  --model anthropic:claude-sonnet-5
```

- `--input -` で標準入力から説明文を渡せる
- 生成された JSON はアプリの左ペインに貼り付けて「検証して描画」でそのまま描画できる

### 対応プロバイダ(`--model プロバイダ:モデル名`)

| プロバイダ | 指定例 | 必要な環境変数 |
|---|---|---|
| Anthropic(既定) | `anthropic:claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai:gpt-4o` | `OPENAI_API_KEY` |
| Azure OpenAI | `azure_openai:<デプロイ名>` | `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT`(任意: `AZURE_OPENAI_API_VERSION`、既定 2024-10-21) |
| OpenRouter | `openrouter:deepseek/deepseek-chat` など | `OPENROUTER_API_KEY`(任意: `OPENROUTER_BASE_URL`) |

- Azure OpenAI はモデル名の位置に**デプロイ名**を指定する
- 環境変数が不足している場合はスタックトレースではなく設定案内を表示して終了する(exit 2)

## テスト(APIキー不要)

```powershell
.venv\Scripts\python.exe agent\tests\run_tests.py
```

1. **パリティテスト** — Python版バリデータと `validators.ts` の判定・指摘内容の完全一致
   (esbuild + node でアプリ本体の検証器を実行して突き合わせる)
2. **ループ結合テスト** — 台本化したフェイクLLMで「検証NG → 自律修正 → 再検証OK → 保存」
   のループと保存ゲートの動作を確認
