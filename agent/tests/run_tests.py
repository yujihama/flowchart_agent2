"""エージェントの自動テスト。

1. パリティテスト: Python版バリデータとアプリ本体(validators.ts)の判定が一致すること
2. ループ結合テスト: 台本化したフェイクLLMで「検証NG→自律修正→再検証OK→保存」の
   エージェントループが機能すること(APIキー不要)

実行: .venv/Scripts/python.exe agent/tests/run_tests.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
AGENT_DIR = TESTS_DIR.parent
REPO_ROOT = AGENT_DIR.parent
sys.path.insert(0, str(AGENT_DIR))

from flow_validator import parse_flow_model, validate_flow_model  # noqa: E402

PASSED = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"  ok: {name}")
    else:
        print(f"  NG: {name} {detail}")
        raise SystemExit(f"テスト失敗: {name}")


# ---------------------------------------------------------------------------
# 1. パリティテスト
# ---------------------------------------------------------------------------

def build_ts_validator() -> Path:
    out = Path(tempfile.gettempdir()) / "flowchart-validate-cli.mjs"
    subprocess.run(
        [
            "npx.cmd" if sys.platform == "win32" else "npx",
            "esbuild",
            str(TESTS_DIR / "validate_cli.ts"),
            "--bundle",
            "--format=esm",
            "--platform=node",
            f"--outfile={out}",
            "--log-level=error",
        ],
        cwd=REPO_ROOT,
        check=True,
    )
    return out


def ts_validate(cli: Path, model: dict) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(model, f, ensure_ascii=False)
        temp_path = f.name
    proc = subprocess.run(["node", cli, temp_path], capture_output=True, text=True, encoding="utf-8", check=True)
    Path(temp_path).unlink(missing_ok=True)
    return json.loads(proc.stdout)


def py_validate(model: dict) -> dict:
    result = validate_flow_model(model)
    return {
        "valid": result.valid,
        "issues": [{"level": i.level, "path": i.path, "message": i.message} for i in result.issues],
    }


BROKEN_FIXTURE = {
    "schema_version": "1.0",
    "flow_id": "broken_fixture",
    "title": "パリティテスト用の壊れたモデル",
    "lanes": [
        {"id": "L001", "name": "申請部門", "type": "department"},
        {"id": "L001", "name": "重複レーン", "type": "team"},
    ],
    "phases": [{"id": "PH001", "name": "申請"}],
    "nodes": [
        {"id": "N001", "type": "process", "label": "申請を起票する", "lane_id": "L001", "phase_id": "PH001"},
        {"id": "N002", "type": "decision", "label": "とてもとてもとてもとてもとてもとてもとてもとてもとても長いラベルのノードです", "lane_id": "L999", "phase_id": "PH001"},
        {"id": "N003", "type": "mystery", "label": "孤立ノード", "lane_id": "L001", "phase_id": "PH999", "source_refs": ["SRC999"]},
    ],
    "edges": [
        {"id": "E001", "from": "N001", "to": "N002", "edge_type": "normal"},
        {"id": "E001", "from": "N002", "to": "N404", "edge_type": "warp", "condition": {"type": "text", "text": " "}},
    ],
    "sources": [],
}


def test_parity() -> None:
    print("[1] バリデータのパリティテスト (Python vs validators.ts)")
    cli = build_ts_validator()
    sample = json.loads((REPO_ROOT / "src" / "data" / "sample-flow.json").read_text(encoding="utf-8"))

    for name, model in (("sample-flow.json", sample), ("broken fixture", BROKEN_FIXTURE)):
        ts = ts_validate(cli, model)
        py = py_validate(model)
        check(f"{name}: valid 判定一致 ({py['valid']})", ts["valid"] == py["valid"])
        ts_set = sorted((i["level"], i["path"], i["message"]) for i in ts["issues"])
        py_set = sorted((i["level"], i["path"], i["message"]) for i in py["issues"])
        check(
            f"{name}: 指摘内容一致 ({len(py_set)}件)",
            ts_set == py_set,
            detail=f"\n    ts={ts_set}\n    py={py_set}",
        )


# ---------------------------------------------------------------------------
# 2. エージェントループ結合テスト(フェイクLLM)
# ---------------------------------------------------------------------------

VALID_MODEL = {
    "schema_version": "1.0",
    "flow_id": "loop_test_flow",
    "title": "ループテスト用フロー",
    "lanes": [{"id": "L001", "name": "申請部門", "type": "department"}],
    "phases": [{"id": "PH001", "name": "申請"}],
    "nodes": [
        {"id": "N001", "type": "start", "label": "開始", "lane_id": "L001", "phase_id": "PH001"},
        {"id": "N002", "type": "process", "label": "申請する", "lane_id": "L001", "phase_id": "PH001"},
        {"id": "N003", "type": "end", "label": "終了", "lane_id": "L001", "phase_id": "PH001"},
    ],
    "edges": [
        {"id": "E001", "from": "N001", "to": "N002", "edge_type": "normal"},
        {"id": "E002", "from": "N002", "to": "N003", "edge_type": "normal"},
    ],
    "sources": [],
}

# start ノード無し + 存在しない参照 → 検証NGになるはずの初回生成物
INVALID_MODEL = {
    **VALID_MODEL,
    "nodes": VALID_MODEL["nodes"][1:],  # start を欠落させる
    "edges": VALID_MODEL["edges"] + [{"id": "E003", "from": "N404", "to": "N002"}],
}


def test_agent_loop() -> None:
    print("[2] エージェント自己修正ループ結合テスト (フェイクLLM)")
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    from flow_model_agent import run

    class ScriptedToolModel(GenericFakeChatModel):
        """台本通りに応答するフェイクLLM(ツールバインドは無視)。"""

        def bind_tools(self, tools, **kwargs):  # noqa: ANN001
            return self

    def tool_call(name: str, payload: dict, call_id: str) -> AIMessage:
        return AIMessage(
            content="",
            tool_calls=[{"name": name, "args": {"flow_model_json": json.dumps(payload, ensure_ascii=False)}, "id": call_id, "type": "tool_call"}],
        )

    script = iter(
        [
            tool_call("validate_flow_model_json", INVALID_MODEL, "call_1"),  # 初回: NGになる
            tool_call("validate_flow_model_json", VALID_MODEL, "call_2"),    # 修正後: OK
            tool_call("save_flow_model", VALID_MODEL, "call_3"),             # 保存
            AIMessage(content="flow_model.json を生成し保存しました。"),
        ]
    )
    model = ScriptedToolModel(messages=script)

    with tempfile.TemporaryDirectory() as tmp:
        output_path = Path(tmp) / "flow_model.json"
        state = run("テスト用の業務説明", output_path, model=model)

        check("保存フラグが立つ", state["saved"] is True)
        check("出力ファイルが存在する", output_path.exists())
        saved, syntax_issue = parse_flow_model(output_path.read_text(encoding="utf-8"))
        check("保存されたJSONが構文的に正しい", syntax_issue is None)
        check("保存されたJSONが検証に合格する", validate_flow_model(saved).valid)

    # 保存ツール単体: エラーが残るJSONは保存を拒否すること
    from flow_model_agent import build_tools

    with tempfile.TemporaryDirectory() as tmp:
        output_path = Path(tmp) / "flow_model.json"
        gate_state: dict = {"saved": False}
        validate_tool, save_tool = build_tools(output_path, gate_state)
        refuse = save_tool.invoke({"flow_model_json": json.dumps(INVALID_MODEL, ensure_ascii=False)})
        check("検証NGのJSONは保存拒否", "保存できません" in refuse and not output_path.exists())
        report = validate_tool.invoke({"flow_model_json": "{ broken json"})
        check("構文エラーが位置情報付きで報告される", report.startswith("NG:") and "行" in report)


# ---------------------------------------------------------------------------
# 3. モデルプロバイダ解決テスト
# ---------------------------------------------------------------------------

def test_model_resolution() -> None:
    print("[3] モデルプロバイダ解決テスト (anthropic / openai / azure_openai / openrouter)")
    import os
    from contextlib import contextmanager

    from flow_model_agent import (
        OPENROUTER_DEFAULT_BASE_URL,
        ModelConfigError,
        resolve_model,
    )

    @contextmanager
    def temp_env(**values):
        saved = {key: os.environ.get(key) for key in values}
        os.environ.update({key: value for key, value in values.items() if value is not None})
        for key, value in values.items():
            if value is None:
                os.environ.pop(key, None)
        try:
            yield
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    with temp_env(ANTHROPIC_API_KEY="test-key"):
        model = resolve_model("anthropic:claude-sonnet-5")
        check("anthropic: ChatAnthropic を構築", type(model).__name__ == "ChatAnthropic")

    with temp_env(OPENAI_API_KEY="test-key"):
        model = resolve_model("openai:gpt-4o")
        check("openai: ChatOpenAI を構築", type(model).__name__ == "ChatOpenAI")

    with temp_env(AZURE_OPENAI_API_KEY="test-key", AZURE_OPENAI_ENDPOINT="https://example.openai.azure.com", AZURE_OPENAI_API_VERSION="2024-10-21"):
        model = resolve_model("azure_openai:my-gpt4o-deployment")
        check("azure_openai: AzureChatOpenAI を構築", type(model).__name__ == "AzureChatOpenAI")
        check("azure_openai: デプロイ名が渡る", model.deployment_name == "my-gpt4o-deployment")
        model_alias = resolve_model("azureopenai:my-gpt4o-deployment")
        check("azureopenai 表記も受理", type(model_alias).__name__ == "AzureChatOpenAI")

    with temp_env(OPENROUTER_API_KEY="test-key"):
        model = resolve_model("openrouter:deepseek/deepseek-chat")
        check("openrouter: ChatOpenAI を構築", type(model).__name__ == "ChatOpenAI")
        check("openrouter: base_url が設定される", str(model.openai_api_base) == OPENROUTER_DEFAULT_BASE_URL)

    with temp_env(OPENROUTER_API_KEY=None):
        try:
            resolve_model("openrouter:deepseek/deepseek-chat")
            check("環境変数不足で ModelConfigError", False)
        except ModelConfigError as error:
            check("環境変数不足で ModelConfigError", "OPENROUTER_API_KEY" in str(error))

    try:
        resolve_model("gemini:some-model")
        check("未対応プロバイダで ModelConfigError", False)
    except ModelConfigError:
        check("未対応プロバイダで ModelConfigError", True)

    try:
        resolve_model("claude-sonnet-5")
        check("プロバイダ無し指定で ModelConfigError", False)
    except ModelConfigError:
        check("プロバイダ無し指定で ModelConfigError", True)


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    test_parity()
    test_agent_loop()
    test_model_resolution()
    print(f"\nすべてのテストに合格しました ({PASSED} checks)")
