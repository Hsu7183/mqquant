from __future__ import annotations

import json
import sqlite3
import shutil
import subprocess
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any

from src.research.memory_db import (
    get_module_learning_summary,
    get_param_learning_summary,
    get_recent_runs,
    get_session_summary,
    get_strategy_group_summary,
    get_top_runs,
    list_sessions,
)
from src.research.paths import research_db_path, session_dir
from src.research.stop_controller import request_stop, session_status_path, touch_session_heartbeat
from src.research.types import ResearchConfig
from src.research.modular_0313plus import describe_0313plus_template_choices


def make_session_id(prefix: str = "mq02") -> str:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{prefix}_{stamp}"


def build_research_config(
    *,
    session_id: str,
    settings: dict[str, Any],
    paths: dict[str, str],
) -> ResearchConfig:
    max_rounds = settings.get("max_rounds")
    max_rounds_value = int(max_rounds) if max_rounds else None
    return ResearchConfig(
        session_id=session_id,
        model=str(settings["model"]),
        base_xs_path=str(paths["base_xs_path"]),
        minute_path=str(paths["minute_path"]),
        daily_path=str(paths["daily_path"]),
        param_preset_path=str(paths["param_preset_path"]),
        batch_size=int(settings["batch_size"]),
        allow_param_mutation=bool(settings["allow_param_mutation"]),
        allow_template_mutation=bool(settings["allow_template_mutation"]),
        top_n=int(settings["top_n"]),
        capital=int(settings["capital"]),
        slip_per_side=float(settings["slip_per_side"]),
        min_trades=int(settings["min_trades"]),
        min_total_return=float(settings["min_total_return"]),
        max_mdd_pct=float(settings["max_mdd_pct"]),
        exploration_mode=str(settings["exploration_mode"]),
        runtime_script_name="0313plus",
        seed_source="current_xs_defaults",
        seed_label="mqquant-02",
        max_rounds=max_rounds_value,
    )


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _creation_flags() -> int:
    flags = 0
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        flags |= int(subprocess.CREATE_NO_WINDOW)
    if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        flags |= int(subprocess.CREATE_NEW_PROCESS_GROUP)
    return flags


def _sqlite_row_dicts(query: str, params: tuple[Any, ...]) -> list[dict[str, Any]]:
    db_path = research_db_path()
    if not db_path.exists():
        return []
    with sqlite3.connect(str(db_path)) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(query, params).fetchall()
    return [dict(row) for row in rows]


def _template_choices_payload(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    text = str(value or "").strip()
    if not text:
        return {}
    try:
        payload = json.loads(text)
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _params_payload(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    text = str(value or "").strip()
    if not text:
        return {}
    try:
        payload = json.loads(text)
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _attach_strategy_metadata(row: dict[str, Any]) -> dict[str, Any]:
    template_choices = _template_choices_payload(row.get("template_choices_json"))
    params = _params_payload(row.get("params_json"))
    strategy_group_label = ""
    if template_choices:
        try:
            strategy_group_label = describe_0313plus_template_choices(template_choices)
        except Exception:
            strategy_group_label = ""
    return {
        **row,
        "template_choices": template_choices,
        "params": params,
        "strategy_group_code": template_choices.get("strategy_group_code"),
        "strategy_group_label": template_choices.get("strategy_group_label") or strategy_group_label,
    }


def _raw_sqlite_list_sessions(limit: int) -> list[dict[str, Any]]:
    return _sqlite_row_dicts(
        """
        SELECT
            s.session_id,
            s.status,
            s.model,
            s.base_xs_path,
            s.created_at,
            s.updated_at,
            COUNT(r.run_id) AS run_count,
            MAX(r.composite_score) AS best_score
        FROM sessions s
        LEFT JOIN runs r ON r.session_id = s.session_id
        GROUP BY
            s.session_id, s.status, s.model, s.base_xs_path, s.created_at, s.updated_at
        ORDER BY s.created_at DESC
        LIMIT ?
        """,
        (int(limit),),
    )


def _raw_sqlite_top_runs(session_id: str, limit: int) -> list[dict[str, Any]]:
    rows = _sqlite_row_dicts(
        """
        SELECT
            r.run_id,
            r.strategy_id,
            r.total_return,
            r.mdd_pct,
            r.n_trades,
            r.year_avg_return,
            r.year_return_std,
            r.loss_years,
            r.composite_score,
            r.fail_reason,
            r.created_at,
            s.params_json,
            s.ai_summary,
            s.template_choices_json,
            s.xs_path,
            s.params_txt_path
        FROM runs r
        JOIN strategies s ON s.strategy_id = r.strategy_id
        WHERE r.session_id = ?
        ORDER BY r.composite_score DESC, r.mdd_pct ASC, r.total_return DESC
        LIMIT ?
        """,
        (session_id, int(limit)),
    )
    return [_attach_strategy_metadata(row) for row in rows]


def _raw_sqlite_recent_runs(session_id: str, limit: int) -> list[dict[str, Any]]:
    rows = _sqlite_row_dicts(
        """
        SELECT
            r.run_id,
            r.strategy_id,
            r.total_return,
            r.mdd_pct,
            r.n_trades,
            r.year_avg_return,
            r.year_return_std,
            r.loss_years,
            r.composite_score,
            r.fail_reason,
            r.created_at,
            s.params_json,
            s.ai_summary,
            s.template_choices_json,
            s.xs_path,
            s.params_txt_path
        FROM runs r
        JOIN strategies s ON s.strategy_id = r.strategy_id
        WHERE r.session_id = ?
        ORDER BY r.created_at DESC
        LIMIT ?
        """,
        (session_id, int(limit)),
    )
    return [_attach_strategy_metadata(row) for row in rows]


def _raw_sqlite_strategy_groups(session_id: str, limit: int) -> list[dict[str, Any]]:
    rows = _sqlite_row_dicts(
        """
        SELECT
            r.strategy_id,
            r.total_return,
            r.mdd_pct,
            r.n_trades,
            r.composite_score,
            r.fail_reason,
            r.created_at,
            s.template_choices_json
        FROM runs r
        JOIN strategies s ON s.strategy_id = r.strategy_id
        WHERE r.session_id = ?
        """,
        (session_id,),
    )
    grouped: dict[str, dict[str, Any]] = {}
    for raw_row in rows:
        row = _attach_strategy_metadata(raw_row)
        group_code = str(row.get("strategy_group_code") or "ungrouped")
        group_label = str(row.get("strategy_group_label") or "未分類策略家族")
        bucket = grouped.setdefault(
            group_code,
            {
                "strategy_group_code": group_code,
                "strategy_group_label": group_label,
                "tested_params": 0,
                "valid_runs": 0,
                "best_strategy_id": None,
                "best_score": None,
                "best_total_return": None,
                "best_mdd_pct": None,
                "best_n_trades": None,
                "last_run_at": None,
            },
        )
        bucket["tested_params"] = int(bucket["tested_params"]) + 1
        if not row.get("fail_reason"):
            bucket["valid_runs"] = int(bucket["valid_runs"]) + 1
        created_at = str(row.get("created_at") or "")
        if created_at and (not bucket["last_run_at"] or created_at > str(bucket["last_run_at"])):
            bucket["last_run_at"] = created_at
        current_tuple = (
            float(row.get("composite_score") or -1e18),
            -float(row.get("mdd_pct") or 1e18),
            float(row.get("total_return") or -1e18),
        )
        best_tuple = (
            float(bucket.get("best_score") or -1e18),
            -float(bucket.get("best_mdd_pct") or 1e18),
            float(bucket.get("best_total_return") or -1e18),
        )
        if current_tuple > best_tuple:
            bucket["best_strategy_id"] = row.get("strategy_id")
            bucket["best_score"] = float(row.get("composite_score") or 0.0)
            bucket["best_total_return"] = float(row.get("total_return") or 0.0)
            bucket["best_mdd_pct"] = float(row.get("mdd_pct") or 0.0)
            bucket["best_n_trades"] = int(row.get("n_trades") or 0)
    summary_rows = list(grouped.values())
    summary_rows.sort(
        key=lambda row: (
            -float(row.get("best_score") or -1e18),
            float(row.get("best_mdd_pct") or 1e18),
            -float(row.get("best_total_return") or -1e18),
        )
    )
    return summary_rows[: int(limit)]


def _raw_sqlite_session_summary(session_id: str) -> dict[str, Any]:
    session_rows = _sqlite_row_dicts("SELECT * FROM sessions WHERE session_id = ?", (session_id,))
    run_count_rows = _sqlite_row_dicts("SELECT COUNT(*) AS run_count FROM runs WHERE session_id = ?", (session_id,))
    best_rows = _sqlite_row_dicts(
        """
        SELECT
            r.strategy_id,
            r.composite_score,
            r.total_return,
            r.mdd_pct,
            r.n_trades,
            s.template_choices_json
        FROM runs r
        JOIN strategies s ON s.strategy_id = r.strategy_id
        WHERE r.session_id = ?
        ORDER BY composite_score DESC, mdd_pct ASC, total_return DESC
        LIMIT 1
        """,
        (session_id,),
    )
    return {
        "session": session_rows[0] if session_rows else None,
        "run_count": int(run_count_rows[0]["run_count"]) if run_count_rows else 0,
        "best_run": _attach_strategy_metadata(best_rows[0]) if best_rows else None,
        "strategy_groups": _raw_sqlite_strategy_groups(session_id, limit=8),
    }


def start_research_session(
    *,
    config: ResearchConfig,
    source_root: str,
) -> dict[str, Any]:
    target_session_dir = session_dir(config.session_id)
    target_session_dir.mkdir(parents=True, exist_ok=True)

    config_path = target_session_dir / "config.json"
    stdout_path = target_session_dir / "worker_stdout.log"
    stderr_path = target_session_dir / "worker_stderr.log"

    config_path.write_text(json.dumps(asdict(config), ensure_ascii=False, indent=2), encoding="utf-8")

    stdout_handle = stdout_path.open("a", encoding="utf-8")
    stderr_handle = stderr_path.open("a", encoding="utf-8")
    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "src.research.worker", str(config_path)],
            cwd=str(source_root),
            stdin=subprocess.DEVNULL,
            stdout=stdout_handle,
            stderr=stderr_handle,
            creationflags=_creation_flags(),
        )
    finally:
        stdout_handle.close()
        stderr_handle.close()

    touch_session_heartbeat(config.session_id, owner_pid=process.pid, source="mq02")
    return {
        "session_id": config.session_id,
        "pid": process.pid,
        "config_path": str(config_path),
        "stdout_path": str(stdout_path),
        "stderr_path": str(stderr_path),
    }


def list_sessions_view(limit: int = 20) -> list[dict[str, Any]]:
    rows = list_sessions(str(research_db_path()), limit=limit)
    if rows:
        return rows
    return _raw_sqlite_list_sessions(limit)


def read_status_payload(session_id: str) -> dict[str, Any]:
    return _read_json(session_status_path(session_id))


def touch_session(session_id: str, owner_pid: int | None = None) -> str:
    path = touch_session_heartbeat(session_id, owner_pid=owner_pid, source="mq02")
    return str(path)


def stop_selected_session(session_id: str) -> str:
    return str(request_stop(session_id))


def load_session_dashboard(session_id: str) -> dict[str, Any]:
    db_path = str(research_db_path())
    summary = get_session_summary(db_path, session_id)
    top_runs = get_top_runs(db_path, session_id, limit=10)
    recent_runs = get_recent_runs(db_path, session_id, limit=20)
    strategy_groups = get_strategy_group_summary(db_path, session_id, limit=8)
    if not summary.get("session") and not top_runs and not recent_runs:
        summary = _raw_sqlite_session_summary(session_id)
        top_runs = _raw_sqlite_top_runs(session_id, limit=10)
        recent_runs = _raw_sqlite_recent_runs(session_id, limit=20)
        strategy_groups = _raw_sqlite_strategy_groups(session_id, limit=8)
    return {
        "status": read_status_payload(session_id),
        "summary": summary,
        "top_runs": top_runs,
        "recent_runs": recent_runs,
        "strategy_groups": strategy_groups,
        "module_learning": get_module_learning_summary(db_path, session_id=session_id, limit=6),
        "param_learning": get_param_learning_summary(db_path, session_id=session_id, limit=10),
    }


def export_best_artifacts(session_id: str, export_root: str) -> dict[str, str] | None:
    top_rows = get_top_runs(str(research_db_path()), session_id, limit=1)
    if not top_rows:
        top_rows = _raw_sqlite_top_runs(session_id, limit=1)
    if not top_rows:
        return None

    best_row = top_rows[0]
    xs_path = Path(str(best_row.get("xs_path") or ""))
    txt_path = Path(str(best_row.get("params_txt_path") or ""))
    if not xs_path.exists() or not txt_path.exists():
        return None

    base_xs_text = xs_path.read_text(encoding="utf-8")
    destination_dir = Path(export_root) / session_id
    destination_dir.mkdir(parents=True, exist_ok=True)

    target_indicator_xs = destination_dir / f"{session_id}_best_indicator.xs"
    target_trade_xs = destination_dir / f"{session_id}_best_trade.xs"
    legacy_target_xs = destination_dir / f"{session_id}_best_strategy.xs"
    target_txt = destination_dir / f"{session_id}_best_params.txt"

    target_indicator_xs.write_text(base_xs_text, encoding="utf-8")
    target_trade_xs.write_text(render_trade_xs(base_xs_text, {}), encoding="utf-8")
    legacy_target_xs.write_text(base_xs_text, encoding="utf-8")
    shutil.copy2(txt_path, target_txt)
    return {
        "indicator_xs_path": str(target_indicator_xs),
        "trade_xs_path": str(target_trade_xs),
        "xs_path": str(legacy_target_xs),
        "txt_path": str(target_txt),
    }

def module_dimension_rows(module_learning: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for dimension_key, values in (module_learning.get("dimensions") or {}).items():
        if not isinstance(values, list):
            continue
        for row in values:
            if not isinstance(row, dict):
                continue
            rows.append(
                {
                    "dimension": dimension_key,
                    "label": row.get("label"),
                    "valid_runs": row.get("valid_runs"),
                    "best_score": row.get("best_score"),
                    "avg_score": row.get("avg_score"),
                    "best_total_return": row.get("best_total_return"),
                    "best_mdd_pct": row.get("best_mdd_pct"),
                }
            )
    return rows


def module_combo_rows(module_learning: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in module_learning.get("top_combos") or []:
        if not isinstance(row, dict):
            continue
        rows.append(
            {
                "combo_label": row.get("combo_label"),
                "valid_runs": row.get("valid_runs"),
                "best_score": row.get("best_score"),
                "avg_score": row.get("avg_score"),
                "best_total_return": row.get("best_total_return"),
                "best_mdd_pct": row.get("best_mdd_pct"),
            }
        )
    return rows


def param_learning_rows(param_learning: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in param_learning.get("param_ranges") or []:
        if not isinstance(row, dict):
            continue
        rows.append(
            {
                "name": row.get("name"),
                "preferred_low": row.get("preferred_low"),
                "preferred_high": row.get("preferred_high"),
                "best_value": row.get("best_value"),
                "valid_runs": row.get("valid_runs"),
                "best_score": row.get("best_score"),
            }
        )
    return rows


def strategy_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    table_rows: list[dict[str, Any]] = []
    for row in rows:
        table_rows.append(
            {
                "strategy_id": row.get("strategy_id"),
                "strategy_group_label": row.get("strategy_group_label"),
                "ai_summary": row.get("ai_summary"),
                "total_return": row.get("total_return"),
                "mdd_pct": row.get("mdd_pct"),
                "n_trades": row.get("n_trades"),
                "composite_score": row.get("composite_score"),
                "fail_reason": row.get("fail_reason"),
                "created_at": row.get("created_at"),
                "xs_path": row.get("xs_path"),
                "params_txt_path": row.get("params_txt_path"),
            }
        )
    return table_rows


def tail_worker_log(session_id: str, filename: str, max_chars: int = 6_000) -> str:
    path = session_dir(session_id) / filename
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="ignore")
    return text[-max_chars:]
