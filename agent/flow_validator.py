"""flow_model.json の検証ロジック。

src/domain/validators.ts の忠実な移植。UI側と同じ判定・同じメッセージを返すことで、
エージェントが修正した JSON がそのままアプリで受理されることを保証する。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

NODE_TYPES = {"start", "end", "process", "decision", "document", "system_process"}
LANE_TYPES = {"department", "role", "system", "external_party"}
EDGE_TYPES = {"normal", "rollback", "exception", "escalation"}


@dataclass
class ValidationIssue:
    level: str  # "error" | "warning"
    path: str
    message: str


@dataclass
class ValidationResult:
    valid: bool
    errors: list[ValidationIssue]
    warnings: list[ValidationIssue]
    issues: list[ValidationIssue]


def parse_flow_model(raw_json: str) -> tuple[Any, ValidationIssue | None]:
    """JSON構文チェック。失敗時は位置情報付きの issue を返す。"""
    try:
        return json.loads(raw_json), None
    except json.JSONDecodeError as error:
        issue = ValidationIssue(
            level="error",
            path="$",
            message=f"JSONの構文エラー: {error.msg} (行{error.lineno} 列{error.colno})",
        )
        return None, issue


def validate_flow_model(model: Any) -> ValidationResult:
    issues: list[ValidationIssue] = []

    def add(level: str, path: str, message: str) -> None:
        issues.append(ValidationIssue(level, path, message))

    if not isinstance(model, dict):
        add("error", "$", "ルートはJSONオブジェクトである必要があります")
        return _build_result(issues)

    if not _non_empty_str(model.get("schema_version")):
        add("error", "schema_version", "schema_version は必須です")
    if not _non_empty_str(model.get("flow_id")):
        add("error", "flow_id", "flow_id は必須です")
    if not _non_empty_str(model.get("title")):
        add("error", "title", "title は必須です")

    for key in ("lanes", "phases", "nodes", "edges"):
        if not isinstance(model.get(key), list):
            add("error", key, f"{key} は配列である必要があります")

    lanes = _as_list(model.get("lanes"))
    phases = _as_list(model.get("phases"))
    nodes = _as_list(model.get("nodes"))
    edges = _as_list(model.get("edges"))
    sources = _as_list(model.get("sources"))

    for collection, path in ((lanes, "lanes"), (phases, "phases"), (nodes, "nodes"), (edges, "edges"), (sources, "sources")):
        _check_object_items(collection, path, add)
        _check_duplicates(collection, path, add)

    lane_ids = {_get(item, "id") for item in lanes}
    phase_ids = {_get(item, "id") for item in phases}
    node_ids = {_get(item, "id") for item in nodes}
    source_ids = {_get(item, "id") for item in sources}

    for index, lane in enumerate(lanes):
        if not _non_empty_str(_get(lane, "id")):
            add("error", f"lanes[{index}].id", "レーンIDは必須です")
        if not _non_empty_str(_get(lane, "name")):
            add("error", f"lanes[{index}].name", "レーン名は必須です")
        if _get(lane, "type") not in LANE_TYPES:
            add("error", f"lanes[{index}].type", f"未知のレーン種別です: {_get(lane, 'type')}")

    for index, phase in enumerate(phases):
        if not _non_empty_str(_get(phase, "id")):
            add("error", f"phases[{index}].id", "フェーズIDは必須です")
        if not _non_empty_str(_get(phase, "name")):
            add("error", f"phases[{index}].name", "フェーズ名は必須です")

    for index, node in enumerate(nodes):
        _validate_node(node, index, lane_ids, phase_ids, source_ids, add)

    for index, edge in enumerate(edges):
        _validate_edge(edge, index, node_ids, source_ids, add)

    start_count = sum(1 for node in nodes if _get(node, "type") == "start")
    end_count = sum(1 for node in nodes if _get(node, "type") == "end")
    if start_count == 0:
        add("error", "nodes", "start ノードが少なくとも1つ必要です")
    if end_count == 0:
        add("warning", "nodes", "end ノードを少なくとも1つ置くことを推奨します")

    outgoing_by_node: dict[Any, list[Any]] = {}
    for edge in edges:
        outgoing_by_node.setdefault(_get(edge, "from"), []).append(edge)
    connected_node_ids = {_get(edge, "from") for edge in edges} | {_get(edge, "to") for edge in edges}

    for node in nodes:
        node_id = _get(node, "id")
        outgoing = outgoing_by_node.get(node_id, [])
        if _get(node, "type") == "decision":
            if len(outgoing) < 2:
                add("warning", f"nodes.{node_id}", "decision ノードから出るエッジは2本以上を推奨します")
            labels = []
            for edge in outgoing:
                label = _get(edge, "label")
                trimmed = label.strip() if isinstance(label, str) else ""
                if not trimmed:
                    add("warning", f"edges.{_get(edge, 'id')}.label", "decision ノードの出力エッジには label を付けることを推奨します")
                else:
                    labels.append(trimmed)
            for label in _find_duplicates(labels):
                add("warning", f"nodes.{node_id}", f"同一 decision から重複した edge label が出ています: {label}")

        if node_id not in connected_node_ids and len(nodes) > 1:
            add("warning", f"nodes.{node_id}", "孤立ノードです")
        label = _get(node, "label")
        if isinstance(label, str) and len(label) > 40:
            add("warning", f"nodes.{node_id}.label", "node.label は40文字以内を推奨します")

    return _build_result(issues)


def format_validation_report(result: ValidationResult) -> str:
    """エージェントへ返す検証レポート(人間可読)。"""
    if result.valid and not result.warnings:
        return "OK: エラーと警告はありません。"
    lines: list[str] = []
    if result.valid:
        lines.append(f"OK: エラーはありません(警告 {len(result.warnings)}件)。")
    else:
        lines.append(f"NG: エラー {len(result.errors)}件 / 警告 {len(result.warnings)}件。すべてのエラーを修正してください。")
    for issue in result.errors:
        lines.append(f"- [error] {issue.path}: {issue.message}")
    for issue in result.warnings:
        lines.append(f"- [warning] {issue.path}: {issue.message}")
    return "\n".join(lines)


def _validate_node(node: Any, index: int, lane_ids: set, phase_ids: set, source_ids: set, add) -> None:
    if not _non_empty_str(_get(node, "id")):
        add("error", f"nodes[{index}].id", "ノードIDは必須です")
    if _get(node, "type") not in NODE_TYPES:
        add("error", f"nodes[{index}].type", f"未知のノード種別です: {_get(node, 'type')}")
    if not _non_empty_str(_get(node, "label")):
        add("error", f"nodes[{index}].label", "ノード label は必須です")
    if _get(node, "lane_id") not in lane_ids:
        add("error", f"nodes[{index}].lane_id", f"存在しない lane_id です: {_get(node, 'lane_id')}")
    if _get(node, "phase_id") not in phase_ids:
        add("error", f"nodes[{index}].phase_id", f"存在しない phase_id です: {_get(node, 'phase_id')}")
    _check_source_refs(_get(node, "source_refs"), source_ids, f"nodes[{index}].source_refs", add)


def _validate_edge(edge: Any, index: int, node_ids: set, source_ids: set, add) -> None:
    if not _non_empty_str(_get(edge, "id")):
        add("error", f"edges[{index}].id", "エッジIDは必須です")
    if _get(edge, "from") not in node_ids:
        add("error", f"edges[{index}].from", f"存在しない from ノードです: {_get(edge, 'from')}")
    if _get(edge, "to") not in node_ids:
        add("error", f"edges[{index}].to", f"存在しない to ノードです: {_get(edge, 'to')}")
    edge_type = _get(edge, "edge_type")
    if edge_type and edge_type not in EDGE_TYPES:
        add("error", f"edges[{index}].edge_type", f"未知の edge_type です: {edge_type}")
    condition = _get(edge, "condition")
    if condition is not None and not _non_empty_str(_get(condition, "text")):
        add("warning", f"edges[{index}].condition.text", "condition.text は UI 表示向けに設定することを推奨します")
    _check_source_refs(_get(edge, "source_refs"), source_ids, f"edges[{index}].source_refs", add)


def _check_object_items(items: list, path: str, add) -> None:
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            add("error", f"{path}[{index}]", "オブジェクトである必要があります")


def _check_duplicates(items: list, path: str, add) -> None:
    ids = [_get(item, "id") for item in items if _get(item, "id") is not None]
    for duplicated in _find_duplicates(ids):
        add("error", path, f"IDが重複しています: {duplicated}")


def _check_source_refs(refs: Any, source_ids: set, path: str, add) -> None:
    if not refs:
        return
    if not isinstance(refs, list):
        add("error", path, "source_refs は配列である必要があります")
        return
    for ref in refs:
        if ref not in source_ids:
            add("error", path, f"存在しない source_refs です: {ref}")


def _find_duplicates(values: list) -> list:
    seen: set = set()
    duplicated: list = []
    for value in values:
        if value in seen and value not in duplicated:
            duplicated.append(value)
        seen.add(value)
    return duplicated


def _build_result(issues: list[ValidationIssue]) -> ValidationResult:
    errors = [issue for issue in issues if issue.level == "error"]
    warnings = [issue for issue in issues if issue.level == "warning"]
    return ValidationResult(valid=len(errors) == 0, errors=errors, warnings=warnings, issues=issues)


def _non_empty_str(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _as_list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _get(item: Any, key: str) -> Any:
    return item.get(key) if isinstance(item, dict) else None
