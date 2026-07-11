"""業務プロセスの説明文から flow_model.json を生成するエージェント。

LangChain の create_agent で実装。エージェントは以下のツールを持つ:
  - validate_flow_model_json: UIと同一ルールの検証(構文+整合性)を実行しレポートを返す
  - save_flow_model:          検証でエラーが無い場合のみファイルへ保存する

保存ツールが検証をゲートしているため、エラーが残っている限り保存できず、
エージェントは検証レポートを手がかりに自律的に修正と再検証を繰り返す。

使い方:
  python agent/flow_model_agent.py --input 業務説明.txt --output out/flow_model.json
  echo "経費精算のフロー..." | python agent/flow_model_agent.py --input - --output out/flow_model.json

--model は "プロバイダ:モデル名" 形式で指定する(必要な環境変数はプロバイダごとに異なる):
  anthropic:claude-sonnet-5        ANTHROPIC_API_KEY
  openai:gpt-4o                    OPENAI_API_KEY
  azure_openai:<デプロイ名>         AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT
                                   (任意: AZURE_OPENAI_API_VERSION)
  openrouter:<モデルID>             OPENROUTER_API_KEY (任意: OPENROUTER_BASE_URL)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from langchain.agents import create_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from flow_validator import (
    format_validation_report,
    parse_flow_model,
    validate_flow_model,
)

DEFAULT_MODEL = "anthropic:claude-sonnet-5"
OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"


class ModelConfigError(RuntimeError):
    """モデル指定・環境変数の不備を表す(スタックトレースなしで案内を出す)。"""


def resolve_model(spec: str | BaseChatModel) -> BaseChatModel:
    """"プロバイダ:モデル名" 形式の指定からチャットモデルを構築する。"""
    if isinstance(spec, BaseChatModel):
        return spec

    provider, _, model_name = spec.partition(":")
    provider = provider.strip().lower()
    model_name = model_name.strip()
    if not provider or not model_name:
        raise ModelConfigError(
            f"--model は 'プロバイダ:モデル名' 形式で指定してください(例: {DEFAULT_MODEL})。指定値: {spec!r}"
        )

    if provider == "anthropic":
        _require_env(provider, "ANTHROPIC_API_KEY")
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(model=model_name)

    if provider == "openai":
        _require_env(provider, "OPENAI_API_KEY")
        from langchain_openai import ChatOpenAI

        # GPT-5系の推論モデルはツール使用時に Responses API を要求する
        # (旧モデルも Responses API で問題なく動く)。
        # timeout/max_retries を明示し、無応答時の長時間ハングを防ぐ。
        return ChatOpenAI(model=model_name, use_responses_api=True, timeout=240, max_retries=1)

    if provider in ("azure_openai", "azureopenai", "azure"):
        _require_env("azure_openai", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT")
        from langchain_openai import AzureChatOpenAI

        return AzureChatOpenAI(
            azure_deployment=model_name,
            api_version=os.environ.get("AZURE_OPENAI_API_VERSION")
            or os.environ.get("OPENAI_API_VERSION")
            or "2024-10-21",
        )

    if provider == "openrouter":
        _require_env(provider, "OPENROUTER_API_KEY")
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=model_name,
            api_key=os.environ["OPENROUTER_API_KEY"],
            base_url=os.environ.get("OPENROUTER_BASE_URL", OPENROUTER_DEFAULT_BASE_URL),
            timeout=240,
            max_retries=1,
        )

    raise ModelConfigError(
        f"未対応のプロバイダです: {provider!r}(対応: anthropic / openai / azure_openai / openrouter)"
    )


def _require_env(provider: str, *names: str) -> None:
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise ModelConfigError(
            f"プロバイダ {provider} を使うには環境変数 {' と '.join(missing)} を設定してください"
        )

SYSTEM_PROMPT = """\
あなたは業務フローチャート生成基盤のためのデータ設計エージェントです。
ユーザーが与える業務プロセスの説明文(規程・手順書・口頭説明の要約など)から、
正本データ flow_model.json を生成します。

# flow_model.json スキーマ

ルート構造(すべてJSONで出力する。座標・色などの描画情報は含めない):
{
  "schema_version": "1.0",
  "flow_id": "英小文字とアンダースコアのスラッグ",
  "title": "フロー名",
  "description": "フローの説明(任意)",
  "lanes":  [{ "id": "L001", "name": "申請部門", "type": "department" }],
  "phases": [{ "id": "PH001", "name": "申請" }],
  "nodes":  [{ "id": "N001", "type": "start", "label": "開始", "lane_id": "L001",
               "phase_id": "PH001", "description": "任意", "source_refs": ["SRC001"] }],
  "edges":  [{ "id": "E001", "from": "N001", "to": "N002", "label": "任意",
               "edge_type": "normal", "condition": { "type": "text", "text": "任意" },
               "source_refs": ["SRC001"] }],
  "sources": [{ "id": "SRC001", "file_name": "根拠資料.pdf", "page": 1, "section": "任意" }]
}

許可される値:
- lane.type: department | role | system | external_party
- node.type: start | end | process | decision | document | system_process
- edge.edge_type: normal | rollback | exception | escalation
- condition は当面 { "type": "text", "text": "..." } 形式のみ使う

# 設計ルール

- ID規則: lanes=L001..、phases=PH001..、nodes=N001..、edges=E001..、sources=SRC001..(連番)
- node.lane_id / node.phase_id / edge.from / edge.to / source_refs は必ず定義済みIDを参照する
- start ノードを必ず1つ以上、end ノードも原則1つ以上置く
- 判断点は必ず type: "decision" のノードで表し、分岐条件はエッジ側の label と
  condition.text に置く。decision から出るエッジは2本以上とし、必ず label を付ける
  (同一 decision から出るエッジの label は重複させない)
- 差戻し・やり直しは edge_type: "rollback"、例外処理は "exception"、
  上位者への引き上げは "escalation" を使う
- node.label は40文字以内の簡潔な表示名にし、詳細は description に書く
- レーンは担当主体(部門・役割・システム・社外)ごとに分け、フェーズは業務の段階を表す
- 説明文に根拠資料への言及があれば sources に登録して source_refs で紐付ける。
  言及がなければ sources は空配列でよく、source_refs は付けない

# 作業手順(必ず守ること)

1. 説明文からレーン・フェーズ・ノード・エッジを設計し、flow_model.json 全体を組み立てる
2. submit_flow_model ツールでドラフト全文を提出し、検証レポートを受け取る
3. エラーが報告されたら、patch_flow_model ツールで**該当箇所だけを部分更新**する
   (全文の再生成より速く、無関係な箇所を壊さないため原則パッチを使う)。
   パッチ適用のたびに自動で再検証される。エラーが0件になるまで繰り返し、
   警告も可能な限り解消する。
   例外: パッチを2回適用してもエラー件数が減らない場合に限り、
   修正済みの全文を submit_flow_model で再提出して仕切り直してよい
4. エラーが無くなったら save_flow_model ツール(引数なし)で保存する
   (検証に合格していないと保存できない)
5. 最後に、設計の要点(レーン構成・分岐・差戻しの扱い)を簡潔に日本語で報告する

ツールに渡すJSONは必ず完全なJSON文字列のみとし、コードフェンスや説明文を混ぜないこと。
"""


PATCH_COLLECTIONS = ("lanes", "phases", "nodes", "edges", "sources")
META_FIELDS = {"schema_version", "flow_id", "title", "description"}


def apply_patch_operation(draft: dict, operation: dict) -> str | None:
    """ドラフトへ1つのパッチ操作を適用する。失敗時はエラーメッセージを返す。"""
    kind = operation.get("op")

    if kind == "set_meta":
        fields = operation.get("fields")
        if not isinstance(fields, dict):
            return "set_meta: fields はオブジェクトで指定してください"
        unknown = set(fields) - META_FIELDS
        if unknown:
            return f"set_meta: 更新できないフィールドです: {sorted(unknown)}"
        draft.update(fields)
        return None

    collection = operation.get("collection")
    if collection not in PATCH_COLLECTIONS:
        return f"未知の collection です: {collection}(指定可能: {'/'.join(PATCH_COLLECTIONS)})"
    items = draft.setdefault(collection, [])
    if not isinstance(items, list):
        return f"{collection} が配列ではありません"

    if kind == "upsert":
        item = operation.get("item")
        if not isinstance(item, dict) or not item.get("id"):
            return "upsert: item に id を持つオブジェクトを指定してください"
        for index, existing in enumerate(items):
            if isinstance(existing, dict) and existing.get("id") == item["id"]:
                items[index] = item
                return None
        items.append(item)
        return None

    if kind == "remove":
        target_id = operation.get("id")
        remaining = [x for x in items if not (isinstance(x, dict) and x.get("id") == target_id)]
        if len(remaining) == len(items):
            return f"remove: {collection} に id {target_id} が見つかりません"
        items[:] = remaining
        return None

    return f"未知の op です: {kind}(指定可能: upsert / remove / set_meta)"


def build_tools(output_path: Path, state: dict):
    """出力先とドラフトを閉じ込めたツール群を生成する(保存先はエージェントに選ばせない)。"""

    def record_verdict(report: str) -> None:
        state["validate_calls"] = state.get("validate_calls", 0) + 1
        state.setdefault("verdicts", []).append("OK" if report.startswith("OK") else "NG")

    @tool
    def submit_flow_model(flow_model_json: str) -> str:
        """flow_model.json のドラフト全文を提出し、検証レポートを受け取る。

        最初に1回だけ使う。以降のエラー修正は patch_flow_model で部分更新すること。
        """
        model, syntax_issue = parse_flow_model(flow_model_json)
        if syntax_issue is not None:
            report = f"NG: {syntax_issue.message}"
            record_verdict(report)
            return report
        state["draft"] = model
        result = validate_flow_model(model)
        state["last_error_count"] = len(result.errors)
        report = format_validation_report(result)
        record_verdict(report)
        return report + "\n(修正は patch_flow_model による部分更新で行ってください)"

    @tool
    def patch_flow_model(patch_operations_json: str) -> str:
        """提出済みドラフトへ部分更新を適用し、自動で再検証する。全文の再生成は不要。

        patch_operations_json は操作のJSON配列:
          {"op": "upsert", "collection": "lanes|phases|nodes|edges|sources", "item": {...}}
            … 同じ id があれば置換、なければ追加
          {"op": "remove", "collection": "...", "id": "E012"}
          {"op": "set_meta", "fields": {"title": "...", "description": "..."}}
        """
        draft = state.get("draft")
        if draft is None or not isinstance(draft, dict):
            return "ドラフトがありません。先に submit_flow_model で全文を提出してください。"
        try:
            operations = json.loads(patch_operations_json)
        except json.JSONDecodeError as error:
            return f"パッチのJSON構文エラー: {error.msg} (行{error.lineno} 列{error.colno})"
        if isinstance(operations, dict):
            operations = [operations]
        if not isinstance(operations, list):
            return "パッチは操作オブジェクトのJSON配列で指定してください。"

        failures = []
        applied = 0
        for index, operation in enumerate(operations):
            if not isinstance(operation, dict):
                failures.append(f"[{index}] 操作がオブジェクトではありません")
                continue
            error = apply_patch_operation(draft, operation)
            if error:
                failures.append(f"[{index}] {error}")
            else:
                applied += 1
        state["patch_ops"] = state.get("patch_ops", 0) + applied

        result = validate_flow_model(draft)
        report = format_validation_report(result)
        record_verdict(report)
        previous_errors = state.get("last_error_count")
        state["last_error_count"] = len(result.errors)
        progress = ""
        if previous_errors is not None:
            if len(result.errors) < previous_errors:
                progress = f"(エラー {previous_errors}件 → {len(result.errors)}件に減少)"
            elif len(result.errors) > previous_errors:
                progress = f"(エラー {previous_errors}件 → {len(result.errors)}件に増加。直前のパッチを見直すこと)"
            elif result.errors:
                progress = f"(エラー件数が {previous_errors}件のまま変化なし)"
        header = f"パッチ適用: {applied}件成功" + (f" / {len(failures)}件失敗: {'; '.join(failures)}" if failures else "") + progress
        return f"{header}\n{report}"

    @tool
    def save_flow_model() -> str:
        """検証エラーが0件のドラフトをファイルへ保存する。

        エラーが1件でも残っている場合は保存されず、レポートが返る。
        """
        draft = state.get("draft")
        if draft is None:
            return "ドラフトがありません。先に submit_flow_model で全文を提出してください。"
        result = validate_flow_model(draft)
        if not result.valid:
            return "保存できません。patch_flow_model でエラーを修正してください。\n" + format_validation_report(result)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(draft, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        state["saved"] = True
        state["warnings"] = len(result.warnings)
        return f"保存しました: {output_path} (エラー0件 / 警告{len(result.warnings)}件)"

    return [submit_flow_model, patch_flow_model, save_flow_model]


def build_agent(model, output_path: Path, state: dict):
    return create_agent(
        model=model,
        tools=build_tools(output_path, state),
        system_prompt=SYSTEM_PROMPT,
    )


def run(description: str, output_path: Path, model=DEFAULT_MODEL, recursion_limit: int = 60) -> dict:
    """エージェントを実行し、最終状態({saved, warnings, final_message})を返す。"""
    state: dict = {"saved": False}
    agent = build_agent(resolve_model(model), output_path, state)
    result = agent.invoke(
        {"messages": [HumanMessage(content=f"次の業務プロセスの説明から flow_model.json を生成してください。\n\n{description}")]},
        config={"recursion_limit": recursion_limit},
    )
    final = result["messages"][-1]
    state["final_message"] = getattr(final, "content", "")

    # 安全網: 検証エラー0件のドラフトを持ったまま保存せずに終了した場合は自動保存する
    if not state.get("saved"):
        draft = state.get("draft")
        if isinstance(draft, dict):
            validation = validate_flow_model(draft)
            if validation.valid:
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_text(json.dumps(draft, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                state["saved"] = True
                state["autosaved"] = True
                state["warnings"] = len(validation.warnings)
    return state


def main() -> int:
    parser = argparse.ArgumentParser(description="業務説明文から flow_model.json を生成するエージェント")
    parser.add_argument(
        "--input",
        required=True,
        nargs="+",
        help="業務ドキュメントのファイルパス(複数指定可。'-' 単独で標準入力)",
    )
    parser.add_argument("--output", required=True, help="生成する flow_model.json の出力パス")
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=(
            f"使用モデル 'プロバイダ:モデル名'(既定: {DEFAULT_MODEL})。"
            "対応プロバイダ: anthropic / openai / azure_openai / openrouter"
        ),
    )
    parser.add_argument("--recursion-limit", type=int, default=60, help="エージェントループの上限ステップ数")
    args = parser.parse_args()

    if args.input == ["-"]:
        description = sys.stdin.read()
    else:
        sections = []
        for input_path in args.input:
            path = Path(input_path)
            sections.append(f"===== ドキュメント: {path.name} =====\n\n{path.read_text(encoding='utf-8')}")
        description = "\n\n".join(sections)
    if not description.strip():
        print("入力の業務説明文が空です", file=sys.stderr)
        return 2

    output_path = Path(args.output)
    try:
        state = run(description, output_path, model=args.model, recursion_limit=args.recursion_limit)
    except ModelConfigError as error:
        print(f"[NG] {error}", file=sys.stderr)
        return 2

    print(state.get("final_message", ""))
    verdicts = state.get("verdicts", [])
    print(f"\n[検証ループ] {len(verdicts)}回実行: {' -> '.join(verdicts) if verdicts else '(なし)'} / パッチ適用 {state.get('patch_ops', 0)}件")
    if not state["saved"]:
        print("\n[NG] 検証に合格するJSONを保存できませんでした。", file=sys.stderr)
        return 1
    autosaved = "(エージェントが保存を省略したため自動保存)" if state.get("autosaved") else ""
    print(f"\n[OK] {output_path} を保存しました(警告 {state.get('warnings', 0)}件){autosaved}")
    return 0


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
