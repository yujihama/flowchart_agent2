"""比較実験: 単純なLLM実行(1回呼び出し) vs エージェント(検証+自律修正ループ)。

ベースラインにはエージェントと同一のスキーマ知識・設計ルールを与え、
出力の抽出もコードフェンス除去など寛容に行う(ベースラインに有利な条件)。
差分は「検証ツールと自律修正ループの有無」のみ。

実行: OPENAI_API_KEY を設定のうえ
  python agent/experiments/compare_baseline.py --output results.json
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
import traceback
from pathlib import Path

EXPERIMENTS_DIR = Path(__file__).resolve().parent
AGENT_DIR = EXPERIMENTS_DIR.parent
REPO_ROOT = AGENT_DIR.parent
sys.path.insert(0, str(AGENT_DIR))

from flow_model_agent import SYSTEM_PROMPT, resolve_model, run as run_agent  # noqa: E402
from flow_validator import parse_flow_model, validate_flow_model  # noqa: E402

DOCS = [
    AGENT_DIR / "examples" / "order_to_cash" / "01_juchu_kanri_kitei.txt",
    AGENT_DIR / "examples" / "order_to_cash" / "02_shukka_butsuryu_tejunsho.txt",
    AGENT_DIR / "examples" / "order_to_cash" / "03_seikyu_kaishu_kitei.txt",
    AGENT_DIR / "examples" / "order_to_cash" / "04_henpin_claim_tejunsho.txt",
]

# エージェントのプロンプトからツール手順の節を除き、単発出力の指示に置き換える
BASELINE_SYSTEM_PROMPT = (
    SYSTEM_PROMPT.split("# 作業手順")[0]
    + """# 出力指示

説明文からレーン・フェーズ・ノード・エッジを設計し、flow_model.json の完全なJSONを
出力してください。JSON以外の説明文は出力しないでください。
"""
)


def build_description() -> str:
    sections = [f"===== ドキュメント: {p.name} =====\n\n{p.read_text(encoding='utf-8')}" for p in DOCS]
    return "次の業務プロセスの説明から flow_model.json を生成してください。\n\n" + "\n\n".join(sections)


def extract_json(text: str) -> str | None:
    """寛容なJSON抽出: コードフェンスや前後の説明文を除去する。"""
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    return text[start : end + 1]


def evaluate_json(raw_json: str | None) -> dict:
    if raw_json is None:
        return {"parse_ok": False, "valid": False, "errors": None, "warnings": None,
                "error_examples": ["JSONを抽出できず(出力に{...}が無い)"], "nodes": None, "edges": None}
    model, syntax_issue = parse_flow_model(raw_json)
    if syntax_issue is not None:
        return {"parse_ok": False, "valid": False, "errors": None, "warnings": None,
                "error_examples": [syntax_issue.message], "nodes": None, "edges": None}
    result = validate_flow_model(model)
    return {
        "parse_ok": True,
        "valid": result.valid,
        "errors": len(result.errors),
        "warnings": len(result.warnings),
        "error_examples": [f"{i.path}: {i.message}" for i in result.errors[:5]],
        "nodes": len(model.get("nodes", [])) if isinstance(model, dict) else None,
        "edges": len(model.get("edges", [])) if isinstance(model, dict) else None,
    }


def run_baseline(model_spec: str, description: str) -> dict:
    started = time.time()
    chat = resolve_model(model_spec)
    response = chat.invoke([
        {"role": "system", "content": BASELINE_SYSTEM_PROMPT},
        {"role": "user", "content": description},
    ])
    content = response.content
    if isinstance(content, list):  # Responses API はブロックのリストを返すことがある
        content = "".join(block.get("text", "") for block in content if isinstance(block, dict))
    record = evaluate_json(extract_json(content))
    record["seconds"] = round(time.time() - started, 1)
    return record


def run_agent_trial(model_spec: str, description: str) -> dict:
    started = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "flow_model.json"
        state = run_agent(description, output, model=model_spec)
        record = evaluate_json(output.read_text(encoding="utf-8") if output.exists() else None)
        record["seconds"] = round(time.time() - started, 1)
        record["saved"] = state.get("saved", False)
        record["validate_loop"] = state.get("verdicts", [])
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="結果JSONの出力パス")
    parser.add_argument("--models", nargs="+", default=["openai:gpt-5.6-terra", "openai:gpt-4.1-mini"])
    parser.add_argument("--baseline-trials", type=int, default=3)
    parser.add_argument("--agent-trials", type=int, default=1)
    args = parser.parse_args()

    description = build_description()
    results: list[dict] = []

    def log(message: str) -> None:
        print(message, flush=True)

    for model_spec in args.models:
        for trial in range(1, args.baseline_trials + 1):
            log(f"[baseline] {model_spec} trial {trial} ...")
            try:
                record = run_baseline(model_spec, description)
            except Exception as error:  # noqa: BLE001
                record = {"parse_ok": False, "valid": False, "error_examples": [f"実行例外: {error}"]}
                traceback.print_exc()
            record.update({"condition": "baseline", "model": model_spec, "trial": trial})
            results.append(record)
            log(f"  -> valid={record.get('valid')} errors={record.get('errors')} warnings={record.get('warnings')} ({record.get('seconds')}s)")

        for trial in range(1, args.agent_trials + 1):
            log(f"[agent] {model_spec} trial {trial} ...")
            try:
                record = run_agent_trial(model_spec, description)
            except Exception as error:  # noqa: BLE001
                record = {"parse_ok": False, "valid": False, "error_examples": [f"実行例外: {error}"]}
                traceback.print_exc()
            record.update({"condition": "agent", "model": model_spec, "trial": trial})
            results.append(record)
            log(f"  -> valid={record.get('valid')} loop={record.get('validate_loop')} ({record.get('seconds')}s)")

    Path(args.output).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"saved: {args.output}")

    # サマリ表示
    log("\n=== サマリ (valid = 検証エラー0で描画可能) ===")
    for model_spec in args.models:
        for condition in ("baseline", "agent"):
            rows = [r for r in results if r["model"] == model_spec and r["condition"] == condition]
            ok = sum(1 for r in rows if r.get("valid"))
            log(f"{condition:8s} {model_spec:26s} {ok}/{len(rows)} 成功")
    return 0


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
