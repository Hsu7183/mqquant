from __future__ import annotations

import csv
import ctypes
import hashlib
import importlib.util
import json
import math
import os
import re
import time
from datetime import datetime
from io import BytesIO
from pathlib import Path
from pprint import pformat
from typing import Any, Iterable, Mapping

import pandas as pd

from .bootstrap import resolve_source_root
from .xs_variants import render_indicator_xs, render_trade_xs
from src.optimize.gui_backend import (
    build_search_space_from_ui,
    RESULT_COLUMNS,
    _evaluate_task_sequence,
    _build_recent_trials_df,
    _hard_filter_fail_reasons,
    _init_worker_data,
    _passes_hard_filters,
    _run_single_combo,
    _score_row,
    _sort_results_df,
    load_market_data,
    shutdown_cached_worker_executor,
)
from src.research.param_space import PERSISTENT_BEST_PARAMS_JSON, PERSISTENT_TOP10_JSON
from src.strategy.strategy_0313plus import run_0313plus_backtest


_LAST_CPU_SAMPLE: tuple[int, int, int] | None = None
_LAST_CPU_PERCENT: float | None = None
_LAST_CPU_SAMPLED_AT: float = 0.0
_STREAMLIT_UPDATE_MIN_INTERVAL_SECONDS = 0.75
_STREAMLIT_UPDATE_MIN_STRIDE = 12
_STREAMLIT_UPDATE_MAX_STRIDE = 200
_GRID_RUN_HARD_LIMIT = 250_000
_BLAS_THREAD_ENV_VARS = (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)
_SOURCE_ROOT = resolve_source_root()
_RUN_HISTORY_DIR = _SOURCE_ROOT / "run_history"
_MQ01_EXPORTS_DIR = _RUN_HISTORY_DIR / "mq01_exports"
_PERSISTENT_TOP10_CSV = _RUN_HISTORY_DIR / "_persistent_top10_v3.csv"
_PERSISTENT_BEST_PARAMS_TXT = _RUN_HISTORY_DIR / "_persistent_best_top1_v3.txt"
_LATEST_RUN_MEMORY_PATH = _SOURCE_ROOT / "src" / "latest_run_memory.py"
_LEADERBOARD_META_FIELDS = {
    "saved_at",
    "source_saved_at",
    "source_run_dir",
    "strategy_signature",
    "optimization_mode",
    "total_return",
    "mdd_pct",
    "n_trades",
    "year_avg_return",
    "year_return_std",
    "loss_years",
    "composite_score",
    "xs_path",
    "params_txt_path",
    "params_json",
}


class _FILETIME(ctypes.Structure):
    _fields_ = [
        ("dwLowDateTime", ctypes.c_ulong),
        ("dwHighDateTime", ctypes.c_ulong),
    ]


class _MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def _read_json_dict(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _load_latest_memory() -> dict[str, Any]:
    if not _LATEST_RUN_MEMORY_PATH.exists():
        return {}
    try:
        spec = importlib.util.spec_from_file_location("mq01_latest_run_memory", _LATEST_RUN_MEMORY_PATH)
        if spec is None or spec.loader is None:
            return {}
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        payload = getattr(module, "LATEST_OPTIMIZATION_MEMORY", {})
    except Exception:
        return {}
    return dict(payload) if isinstance(payload, dict) else {}


def _system_cpu_percent() -> float | None:
    global _LAST_CPU_SAMPLE, _LAST_CPU_PERCENT, _LAST_CPU_SAMPLED_AT

    if os.name != "nt":
        return None

    now = time.monotonic()
    if _LAST_CPU_PERCENT is not None and (now - _LAST_CPU_SAMPLED_AT) < 0.35:
        return _LAST_CPU_PERCENT

    idle_time = _FILETIME()
    kernel_time = _FILETIME()
    user_time = _FILETIME()
    if not ctypes.windll.kernel32.GetSystemTimes(
        ctypes.byref(idle_time),
        ctypes.byref(kernel_time),
        ctypes.byref(user_time),
    ):
        return _LAST_CPU_PERCENT

    current_sample = (
        (int(idle_time.dwHighDateTime) << 32) | int(idle_time.dwLowDateTime),
        (int(kernel_time.dwHighDateTime) << 32) | int(kernel_time.dwLowDateTime),
        (int(user_time.dwHighDateTime) << 32) | int(user_time.dwLowDateTime),
    )

    cpu_percent: float | None = None
    if _LAST_CPU_SAMPLE is not None:
        idle_delta = max(current_sample[0] - _LAST_CPU_SAMPLE[0], 0)
        kernel_delta = max(current_sample[1] - _LAST_CPU_SAMPLE[1], 0)
        user_delta = max(current_sample[2] - _LAST_CPU_SAMPLE[2], 0)
        total_delta = kernel_delta + user_delta
        busy_delta = max(total_delta - idle_delta, 0)
        if total_delta > 0:
            cpu_percent = (busy_delta / total_delta) * 100.0

    _LAST_CPU_SAMPLE = current_sample
    _LAST_CPU_SAMPLED_AT = now
    if cpu_percent is not None:
        _LAST_CPU_PERCENT = cpu_percent
    return _LAST_CPU_PERCENT


def _system_memory_snapshot() -> dict[str, Any]:
    if os.name != "nt":
        return {}

    memory_status = _MEMORYSTATUSEX()
    memory_status.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory_status)):
        return {}

    total_gb = float(memory_status.ullTotalPhys) / (1024**3)
    available_gb = float(memory_status.ullAvailPhys) / (1024**3)
    used_gb = max(total_gb - available_gb, 0.0)
    return {
        "memory_pct": float(memory_status.dwMemoryLoad),
        "memory_total_gb": total_gb,
        "memory_used_gb": used_gb,
        "memory_available_gb": available_gb,
    }


def collect_system_snapshot(
    *,
    max_workers: int,
    requested_workers: int | None = None,
    cpu_limit_pct: int | None = None,
    memory_limit_pct: int | None = None,
) -> dict[str, Any]:
    cpu_count = os.cpu_count() or 0
    configured_workers = max(1, int(max_workers or 1))
    requested_worker_count = configured_workers if requested_workers is None else max(1, int(requested_workers or 1))
    memory_snapshot = _system_memory_snapshot()
    effective_cpu_count = _cpu_limited_core_count(cpu_count=cpu_count, cpu_limit_pct=cpu_limit_pct)
    worker_load_pct: float | None = None
    if effective_cpu_count > 0:
        worker_load_pct = (configured_workers / effective_cpu_count) * 100.0
    return {
        "cpu_pct": _system_cpu_percent(),
        "logical_cpu_count": cpu_count,
        "effective_cpu_count": effective_cpu_count,
        "configured_workers": configured_workers,
        "requested_workers": requested_worker_count,
        "cpu_limit_pct": None if cpu_limit_pct is None else int(cpu_limit_pct),
        "memory_limit_pct": None if memory_limit_pct is None else int(memory_limit_pct),
        "worker_load_pct": worker_load_pct,
        **memory_snapshot,
    }


def _cpu_limited_core_count(*, cpu_count: int | None = None, cpu_limit_pct: int | None = None) -> int:
    available_cpu_count = max(1, int(cpu_count or os.cpu_count() or 1))
    capped_limit = max(1, min(100, int(cpu_limit_pct or 100)))
    return max(1, int(math.floor(available_cpu_count * capped_limit / 100.0)))


def resolve_effective_workers(*, requested_workers: int, cpu_limit_pct: int) -> int:
    requested = max(1, int(requested_workers or 1))
    cpu_limited_workers = _cpu_limited_core_count(cpu_limit_pct=cpu_limit_pct)
    return max(1, min(requested, cpu_limited_workers))


def apply_cpu_guard(*, cpu_limit_pct: int) -> None:
    capped_limit = max(1, min(100, int(cpu_limit_pct or 100)))
    for env_name in _BLAS_THREAD_ENV_VARS:
        os.environ[env_name] = "1"
    os.environ["MQ01_CPU_LIMIT_PCT"] = str(capped_limit)


def build_best_snapshot(source: Mapping[str, Any] | None, param_names: list[str]) -> dict[str, Any]:
    if not source:
        return {}
    params = {
        name: source.get(name)
        for name in param_names
        if name in source and source.get(name) is not None
    }
    year_returns = {
        str(key).replace("year_return_", ""): source.get(key)
        for key in sorted(source.keys())
        if str(key).startswith("year_return_") and source.get(key) is not None
    }
    snapshot = {
        "params": params,
        "total_return": source.get("total_return"),
        "mdd_pct": source.get("mdd_pct"),
        "n_trades": source.get("n_trades"),
        "composite_score": source.get("composite_score"),
        "year_avg_return": source.get("year_avg_return"),
        "year_returns": year_returns,
    }
    source_slip = _normalize_slip_per_side(source.get("slip_per_side"))
    if source_slip is not None:
        snapshot["slip_per_side"] = source_slip
    return snapshot


def build_current_best_snapshot(
    top_df: pd.DataFrame,
    param_names: list[str],
    slip_per_side: float | None = None,
) -> dict[str, Any]:
    if top_df.empty:
        return {}
    row = top_df.iloc[0].to_dict()
    snapshot = build_best_snapshot(row, param_names)
    current_slip = _normalize_slip_per_side(slip_per_side)
    if snapshot and current_slip is not None:
        snapshot["slip_per_side"] = current_slip
    return snapshot


def build_best_export_payload(
    *,
    top_df: pd.DataFrame,
    params_meta: list[dict[str, Any]],
    xs_path: str,
    minute_path: str,
    daily_path: str,
    script_name: str,
    slip_per_side: float,
) -> dict[str, Any]:
    if top_df.empty:
        return {}

    best_row = {key: _json_safe_value(value) for key, value in top_df.iloc[0].to_dict().items()}
    best_params = _best_params_from_row(best_row, params_meta)
    if not best_params:
        return {}

    signature = hashlib.sha1(
        json.dumps(
            {"params": best_params, "slip_per_side": _normalize_slip_per_side(slip_per_side)},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    base_xs_text = Path(xs_path).read_text(encoding="utf-8")
    indicator_xs_text = render_indicator_xs(base_xs_text, best_params)
    trade_xs_text = render_trade_xs(base_xs_text, best_params)

    trade_lines: list[str] = []
    artifact_error: str | None = None
    try:
        minute_bars, daily_bars = load_market_data(minute_path, daily_path)
        result = run_0313plus_backtest(
            minute_bars,
            daily_bars,
            best_params,
            script_name,
            slip_per_side=float(slip_per_side),
        )
        trade_lines = _build_trade_lines(list(getattr(result, "trades", []) or []))
    except Exception as exc:
        artifact_error = str(exc)

    params_header = ",".join(f"{name}={_format_param_value(value)}" for name, value in best_params.items())
    txt_lines = [params_header]
    if trade_lines:
        txt_lines.extend(trade_lines)
    elif artifact_error:
        txt_lines.append(f"匯出交易明細失敗: {artifact_error}")
    else:
        txt_lines.append("無逐筆交易資料")

    return {
        "signature": signature,
        "params": best_params,
        "slip_per_side": _normalize_slip_per_side(slip_per_side),
        "indicator_xs_bytes": indicator_xs_text.encode("utf-8"),
        "trade_xs_bytes": trade_xs_text.encode("utf-8"),
        "txt_bytes": ("\n".join(txt_lines) + "\n").encode("utf-8"),
        "indicator_xs_file_name": f"{script_name}_{signature[:8]}_indicator.xs",
        "trade_xs_file_name": f"{script_name}_{signature[:8]}_trade.xs",
        "txt_file_name": f"{script_name}_{signature[:8]}_best_strategy.txt",
        "artifact_error": artifact_error,
    }


def load_historical_best_snapshot(
    param_names: list[str],
    slip_per_side: float | None = None,
) -> dict[str, Any]:
    latest_memory = _load_latest_memory()
    persistent_best_payload = _read_json_dict(PERSISTENT_BEST_PARAMS_JSON)
    persistent_top10_payload = _read_json_dict(PERSISTENT_TOP10_JSON)
    normalized_slip = _normalize_slip_per_side(slip_per_side)

    top_rows = persistent_top10_payload.get("rows") or []
    top_candidates = [
        dict(row)
        for row in top_rows
        if isinstance(row, dict) and _slippage_matches(row, normalized_slip)
    ]
    top_best_row = max(top_candidates, key=_historical_compare_key) if top_candidates else {}
    latest_best_source = _payload_best_source(latest_memory)
    if not _slippage_matches(latest_best_source, normalized_slip):
        latest_best_source = {}
    persistent_best_source = _payload_best_source(persistent_best_payload)
    if not _slippage_matches(persistent_best_source, normalized_slip):
        persistent_best_source = {}

    candidate_bundle: list[dict[str, Any]] = []
    if persistent_best_source:
        candidate_bundle.append(
            {
                "source": persistent_best_source,
                "saved_at": persistent_best_payload.get("saved_at"),
                "optimization_mode": persistent_best_payload.get("optimization_mode"),
                "tested_count": persistent_best_payload.get("tested_count"),
                "total_count": persistent_best_payload.get("total_count"),
                "elapsed_seconds": persistent_best_payload.get("elapsed_seconds"),
                "cpu_limit_pct": persistent_best_payload.get("cpu_limit_pct"),
                "effective_workers": persistent_best_payload.get("effective_workers"),
            }
        )
    if top_best_row:
        candidate_bundle.append(
            {
                "source": top_best_row,
                "saved_at": top_best_row.get("saved_at") or persistent_top10_payload.get("saved_at"),
                "optimization_mode": top_best_row.get("optimization_mode"),
                "tested_count": None,
                "total_count": None,
                "elapsed_seconds": None,
                "cpu_limit_pct": None,
                "effective_workers": None,
            }
        )
    if latest_best_source:
        candidate_bundle.append(
            {
                "source": latest_best_source,
                "saved_at": latest_memory.get("saved_at"),
                "optimization_mode": latest_memory.get("optimization_mode"),
                "tested_count": latest_memory.get("tested_count"),
                "total_count": latest_memory.get("total_count"),
                "elapsed_seconds": latest_memory.get("elapsed_seconds"),
                "cpu_limit_pct": latest_memory.get("cpu_limit_pct"),
                "effective_workers": latest_memory.get("effective_workers"),
            }
        )

    if not candidate_bundle:
        return {}
    best_candidate = max(candidate_bundle, key=lambda item: _historical_compare_key(item.get("source")))
    metrics_source = dict(best_candidate.get("source") or {})
    snapshot = build_best_snapshot(metrics_source, param_names)
    if not snapshot:
        return {}

    snapshot.update(
        {
            "saved_at": best_candidate.get("saved_at"),
            "optimization_mode": best_candidate.get("optimization_mode"),
            "tested_count": best_candidate.get("tested_count"),
            "total_count": best_candidate.get("total_count"),
            "elapsed_seconds": best_candidate.get("elapsed_seconds"),
            "cpu_limit_pct": best_candidate.get("cpu_limit_pct"),
            "effective_workers": best_candidate.get("effective_workers"),
        }
    )
    return snapshot

def estimate_run_count(
    mode: str,
    ui_param_specs: list[dict[str, Any]],
    params_meta: list[dict[str, Any]],
    *,
    seed_keep_count: int,
) -> int:
    del mode, seed_keep_count
    _fixed_params, variable_specs = build_search_space_from_ui(ui_param_specs, params_meta)
    if not variable_specs:
        return 1
    return sum(len(spec["values"]) for spec in variable_specs)


def grid_run_block_reason(mode: str, estimated_total: int) -> str | None:
    del mode, estimated_total
    return None


def _now_text() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)


def _normalize_slip_per_side(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    if pd.isna(numeric):
        return None
    return float(numeric)


def _slippage_matches(source: Mapping[str, Any] | None, slip_per_side: float | None) -> bool:
    if slip_per_side is None:
        return True
    if not source:
        return False
    source_slip = _normalize_slip_per_side(source.get("slip_per_side"))
    if source_slip is None:
        return False
    return abs(source_slip - float(slip_per_side)) < 1e-9


def _json_safe_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        if isinstance(value, float) and pd.isna(value):
            return None
        return value
    if pd.isna(value):
        return None
    if hasattr(value, "item"):
        try:
            return _json_safe_value(value.item())
        except Exception:
            pass
    return str(value)


def _format_param_value(value: Any) -> str:
    normalized = _json_safe_value(value)
    if isinstance(normalized, int):
        return str(normalized)
    if isinstance(normalized, float):
        if abs(normalized - round(normalized)) < 1e-9:
            return str(int(round(normalized)))
        return f"{normalized:.4f}".rstrip("0").rstrip(".")
    return str(normalized)


def _format_trade_number(value: Any) -> str:
    try:
        numeric = float(value)
    except Exception:
        return str(value)
    if abs(numeric - round(numeric)) < 1e-9:
        return str(int(round(numeric)))
    return f"{numeric:.4f}".rstrip("0").rstrip(".")


def _build_trade_lines(trades: list[Any]) -> list[str]:
    lines: list[str] = []
    for trade in trades or []:
        entry_action = str(getattr(trade, "entry_action", "") or "").strip()
        exit_action = str(getattr(trade, "exit_action", "") or "").strip()
        if not entry_action:
            entry_action = "新買" if int(getattr(trade, "direction", 1) or 1) >= 0 else "新賣"
        if not exit_action:
            exit_action = "平賣" if int(getattr(trade, "direction", 1) or 1) >= 0 else "平買"
        entry_dt = f"{int(getattr(trade, 'entry_date', 0) or 0)}{int(getattr(trade, 'entry_time', 0) or 0):06d}"
        exit_dt = f"{int(getattr(trade, 'exit_date', 0) or 0)}{int(getattr(trade, 'exit_time', 0) or 0):06d}"
        lines.append(f"{entry_dt} {_format_trade_number(getattr(trade, 'entry_price', ''))} {entry_action}")
        lines.append(f"{exit_dt} {_format_trade_number(getattr(trade, 'exit_price', ''))} {exit_action}")
    return lines


def _best_params_from_row(best_row: Mapping[str, Any], params_meta: list[dict[str, Any]]) -> dict[str, int | float]:
    params: dict[str, int | float] = {}
    for meta in params_meta:
        name = str(meta["name"])
        if name not in best_row:
            continue
        raw_value = _json_safe_value(best_row.get(name))
        if raw_value in (None, ""):
            continue
        value_type = str(meta.get("type") or "float").lower()
        if value_type == "int":
            params[name] = int(round(float(raw_value)))
        else:
            params[name] = round(float(raw_value), 10)
    return params


def _render_optimized_xs_text(base_xs_text: str, best_params: Mapping[str, Any]) -> str:
    rendered_lines: list[str] = []
    for line in base_xs_text.splitlines():
        updated_line = line
        for name, value in best_params.items():
            pattern = rf"^(\s*{re.escape(name)}\s*\()\s*([^,]+)(,.*)$"
            match = re.match(pattern, updated_line)
            if match is None:
                continue
            updated_line = f"{match.group(1)}{_format_param_value(value)}{match.group(3)}"
            break
        rendered_lines.append(updated_line)
    return "\n".join(rendered_lines) + "\n"


def _write_latest_memory(payload: dict[str, Any]) -> None:
    _LATEST_RUN_MEMORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    text = (
        "# -*- coding: utf-8 -*-\n"
        "from __future__ import annotations\n\n"
        "# Auto-generated by MQQuant 01 when an optimization run is saved.\n"
        "# This file is the code-side memory of the latest optimization result.\n\n"
        f"LATEST_OPTIMIZATION_MEMORY = {pformat(payload, width=100, sort_dicts=False)}\n"
    )
    _LATEST_RUN_MEMORY_PATH.write_text(text, encoding="utf-8")


def _load_existing_top10_rows() -> list[dict[str, Any]]:
    payload = _read_json_dict(PERSISTENT_TOP10_JSON)
    rows = payload.get("rows") or []
    if isinstance(rows, list):
        return [dict(row) for row in rows if isinstance(row, dict)]
    return []


def _ordered_param_names(rows: list[dict[str, Any]], params_meta: list[dict[str, Any]]) -> list[str]:
    preferred = [str(item["name"]) for item in params_meta]
    discovered = {key for row in rows for key in row.keys() if key not in _LEADERBOARD_META_FIELDS}
    ordered = [name for name in preferred if name in discovered]
    ordered.extend(sorted(name for name in discovered if name not in ordered))
    return ordered


def _historical_compare_key(source: Mapping[str, Any] | None) -> tuple[float, float, float, float]:
    if not source:
        return (-1e18, -1e18, -1e18, -1e18)
    return (
        _safe_float(source.get("total_return"), -1e18),
        -_safe_float(source.get("mdd_pct"), 1e18),
        _safe_float(source.get("composite_score"), -1e18),
        _safe_float(source.get("year_avg_return"), -1e18),
    )


def _merge_best_source(best_result: Any, params: Any) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    if isinstance(best_result, Mapping):
        merged.update({str(key): _json_safe_value(value) for key, value in best_result.items()})
    if isinstance(params, Mapping):
        for key, value in params.items():
            merged.setdefault(str(key), _json_safe_value(value))
    return merged


def _payload_best_source(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    if not payload:
        return {}
    merged = _merge_best_source(payload.get("best_result"), payload.get("params"))
    payload_slip = _normalize_slip_per_side(payload.get("slip_per_side"))
    if payload_slip is not None:
        merged["slip_per_side"] = payload_slip
    return merged


def _persist_historical_best_payload(payload: dict[str, Any]) -> None:
    PERSISTENT_BEST_PARAMS_JSON.parent.mkdir(parents=True, exist_ok=True)
    PERSISTENT_BEST_PARAMS_JSON.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    best_params = payload.get("params")
    if not isinstance(best_params, Mapping):
        best_params = {}
    _PERSISTENT_BEST_PARAMS_TXT.write_text(
        "\n".join(f"{name}={_format_param_value(value)}" for name, value in best_params.items()) + "\n",
        encoding="utf-8",
    )


def _historical_best_payload(
    *,
    best_row: dict[str, Any],
    best_params: dict[str, Any],
    mode_label: str,
    export_dir: Path,
    best_indicator_xs_path: Path,
    best_trade_xs_path: Path,
    best_txt_path: Path,
    summary_json_path: Path,
    runtime_settings: dict[str, Any],
    tested_count: int,
    total_count: int,
    elapsed_seconds: float,
    compute_elapsed_seconds: float,
    transition_elapsed_seconds: float,
) -> dict[str, Any]:
    return {
        "saved_at": _now_text(),
        "run_dir": str(export_dir),
        "optimization_mode": mode_label,
        "cpu_limit_pct": int(runtime_settings.get("cpu_limit_pct", 100)),
        "memory_limit_pct": int(runtime_settings.get("memory_limit_pct", 100)),
        "requested_workers": int(runtime_settings.get("requested_workers", runtime_settings["max_workers"])),
        "effective_workers": int(runtime_settings["max_workers"]),
        "tested_count": int(tested_count),
        "total_count": int(total_count),
        "elapsed_seconds": float(elapsed_seconds),
        "compute_elapsed_seconds": float(compute_elapsed_seconds),
        "transition_elapsed_seconds": float(transition_elapsed_seconds),
        "best_xs_path": str(best_indicator_xs_path),
        "best_indicator_xs_path": str(best_indicator_xs_path),
        "best_trade_xs_path": str(best_trade_xs_path),
        "best_txt_path": str(best_txt_path),
        "best_summary_json_path": str(summary_json_path),
        "slip_per_side": float(runtime_settings["slip_per_side"]),
        "params": {str(key): _json_safe_value(value) for key, value in best_params.items()},
        "best_result": {str(key): _json_safe_value(value) for key, value in best_row.items()},
    }


def _update_historical_best(
    *,
    best_row: dict[str, Any],
    best_params: dict[str, Any],
    mode_label: str,
    export_dir: Path,
    best_indicator_xs_path: Path,
    best_trade_xs_path: Path,
    best_txt_path: Path,
    summary_json_path: Path,
    runtime_settings: dict[str, Any],
    tested_count: int,
    total_count: int,
    elapsed_seconds: float,
    compute_elapsed_seconds: float,
    transition_elapsed_seconds: float,
) -> bool:
    normalized_slip = _normalize_slip_per_side(runtime_settings.get("slip_per_side"))
    current_payload = _read_json_dict(PERSISTENT_BEST_PARAMS_JSON)
    current_source = _payload_best_source(current_payload)
    if not _slippage_matches(current_source, normalized_slip):
        current_source = {}
    top_rows = [row for row in _load_existing_top10_rows() if _slippage_matches(row, normalized_slip)]
    top_best_source = max(top_rows, key=_historical_compare_key) if top_rows else {}
    latest_memory_source = _payload_best_source(_load_latest_memory())
    if not _slippage_matches(latest_memory_source, normalized_slip):
        latest_memory_source = {}
    candidate_payload = _historical_best_payload(
        best_row=best_row,
        best_params=best_params,
        mode_label=mode_label,
        export_dir=export_dir,
        best_indicator_xs_path=best_indicator_xs_path,
        best_trade_xs_path=best_trade_xs_path,
        best_txt_path=best_txt_path,
        summary_json_path=summary_json_path,
        runtime_settings=runtime_settings,
        tested_count=tested_count,
        total_count=total_count,
        elapsed_seconds=elapsed_seconds,
        compute_elapsed_seconds=compute_elapsed_seconds,
        transition_elapsed_seconds=transition_elapsed_seconds,
    )
    candidate_source = _payload_best_source(candidate_payload)
    incumbent_candidates = [source for source in (current_source, top_best_source, latest_memory_source) if source]
    incumbent_source = max(incumbent_candidates, key=_historical_compare_key) if incumbent_candidates else {}
    if incumbent_source and _historical_compare_key(candidate_source) <= _historical_compare_key(incumbent_source):
        return False
    _persist_historical_best_payload(candidate_payload)
    return True


def _write_top10_csv(rows: list[dict[str, Any]], params_meta: list[dict[str, Any]]) -> None:
    fieldnames = list(_LEADERBOARD_META_FIELDS) + _ordered_param_names(rows, params_meta)
    with _PERSISTENT_TOP10_CSV.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _leaderboard_row(
    *,
    best_row: dict[str, Any],
    best_params: dict[str, Any],
    mode_label: str,
    export_dir: Path,
    best_xs_path: Path,
    best_txt_path: Path,
    signature: str,
    slip_per_side: float,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "saved_at": _now_text(),
        "source_saved_at": _now_text(),
        "source_run_dir": str(export_dir),
        "strategy_signature": signature,
        "optimization_mode": mode_label,
        "total_return": _safe_float(best_row.get("total_return"), 0.0),
        "mdd_pct": _safe_float(best_row.get("mdd_pct"), 0.0),
        "n_trades": int(round(_safe_float(best_row.get("n_trades"), 0.0))),
        "year_avg_return": _safe_float(best_row.get("year_avg_return"), 0.0),
        "year_return_std": _safe_float(best_row.get("year_return_std"), 0.0),
        "loss_years": int(round(_safe_float(best_row.get("loss_years"), 0.0))),
        "composite_score": _safe_float(best_row.get("composite_score"), 0.0),
        "xs_path": str(best_xs_path),
        "params_txt_path": str(best_txt_path),
        "params_json": json.dumps(best_params, ensure_ascii=False, sort_keys=True),
        "slip_per_side": float(slip_per_side),
    }
    for key, value in best_row.items():
        key_text = str(key)
        if key_text == "mdd_amount" or key_text.startswith("year_return_"):
            row[key_text] = _json_safe_value(value)
    for name, value in best_params.items():
        row[name] = value
    return row


def _update_persistent_top10(row: dict[str, Any], params_meta: list[dict[str, Any]]) -> None:
    PERSISTENT_TOP10_JSON.parent.mkdir(parents=True, exist_ok=True)
    rows = _load_existing_top10_rows()
    rows.append(row)
    rows.sort(
        key=lambda item: (
            _safe_float(item.get("composite_score"), -1e18),
            -_safe_float(item.get("mdd_pct"), 1e18),
            _safe_float(item.get("total_return"), -1e18),
            _safe_float(item.get("year_avg_return"), -1e18),
        ),
        reverse=True,
    )

    deduped: list[dict[str, Any]] = []
    seen_signatures: set[str] = set()
    for current in rows:
        signature = str(current.get("strategy_signature") or current.get("params_json") or "").strip()
        if signature and signature in seen_signatures:
            continue
        if signature:
            seen_signatures.add(signature)
        deduped.append(current)
        if len(deduped) >= 10:
            break

    ordered_names = _ordered_param_names(deduped, params_meta)
    best_params = {
        name: deduped[0][name]
        for name in ordered_names
        if deduped and name in deduped[0] and deduped[0].get(name) not in (None, "")
    }

    PERSISTENT_TOP10_JSON.write_text(
        json.dumps(
            {
                "saved_at": _now_text(),
                "count": len(deduped),
                "best_params": best_params,
                "rows": deduped,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    _write_top10_csv(deduped, params_meta)


def persist_best_run(
    *,
    top_df: pd.DataFrame,
    params_meta: list[dict[str, Any]],
    xs_path: str,
    minute_path: str,
    daily_path: str,
    script_name: str,
    mode_label: str,
    runtime_settings: dict[str, Any],
    hard_filters: dict[str, Any],
    tested_count: int,
    total_count: int,
    elapsed_seconds: float,
    compute_elapsed_seconds: float,
    transition_elapsed_seconds: float,
    fail_reason_counts: dict[str, int],
) -> dict[str, Any]:
    if top_df.empty:
        return {}

    best_row = {key: _json_safe_value(value) for key, value in top_df.iloc[0].to_dict().items()}
    best_params = _best_params_from_row(best_row, params_meta)
    if not best_params:
        return {}

    signature = hashlib.sha1(
        json.dumps(
            {"params": best_params, "slip_per_side": _normalize_slip_per_side(runtime_settings["slip_per_side"])},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    export_dir = _MQ01_EXPORTS_DIR / f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{script_name}_{signature[:8]}"
    export_dir.mkdir(parents=True, exist_ok=True)

    base_xs_text = Path(xs_path).read_text(encoding="utf-8")
    best_indicator_xs_path = export_dir / "best_indicator.xs"
    best_trade_xs_path = export_dir / "best_trade.xs"
    best_indicator_xs_path.write_text(render_indicator_xs(base_xs_text, best_params), encoding="utf-8")
    best_trade_xs_path.write_text(render_trade_xs(base_xs_text, best_params), encoding="utf-8")

    trade_lines: list[str] = []
    artifact_error: str | None = None
    try:
        minute_bars, daily_bars = load_market_data(minute_path, daily_path)
        result = run_0313plus_backtest(
            minute_bars,
            daily_bars,
            best_params,
            script_name,
            slip_per_side=float(runtime_settings["slip_per_side"]),
        )
        trade_lines = _build_trade_lines(list(getattr(result, "trades", []) or []))
    except Exception as exc:
        artifact_error = str(exc)

    params_header = ",".join(f"{name}={_format_param_value(value)}" for name, value in best_params.items())
    best_txt_path = export_dir / "best_strategy.txt"
    txt_lines = [params_header]
    if trade_lines:
        txt_lines.extend(trade_lines)
    elif artifact_error:
        txt_lines.append(f"匯出交易明細失敗: {artifact_error}")
    else:
        txt_lines.append("無逐筆交易資料")
    best_txt_path.write_text("\n".join(txt_lines) + "\n", encoding="utf-8")

    summary_json_path = export_dir / "summary.json"
    summary_payload = {
        "saved_at": _now_text(),
        "script_name": script_name,
        "optimization_mode": mode_label,
        "cpu_limit_pct": int(runtime_settings.get("cpu_limit_pct", 100)),
        "memory_limit_pct": int(runtime_settings.get("memory_limit_pct", 100)),
        "requested_workers": int(runtime_settings.get("requested_workers", runtime_settings["max_workers"])),
        "effective_workers": int(runtime_settings["max_workers"]),
        "tested_count": int(tested_count),
        "total_count": int(total_count),
        "elapsed_seconds": float(elapsed_seconds),
        "compute_elapsed_seconds": float(compute_elapsed_seconds),
        "transition_elapsed_seconds": float(transition_elapsed_seconds),
        "capital": int(runtime_settings["capital"]),
        "slip_per_side": float(runtime_settings["slip_per_side"]),
        "hard_filters": {key: _json_safe_value(value) for key, value in hard_filters.items()},
        "best_result": best_row,
        "best_params": best_params,
        "best_xs_path": str(best_indicator_xs_path),
        "best_indicator_xs_path": str(best_indicator_xs_path),
        "best_trade_xs_path": str(best_trade_xs_path),
        "best_txt_path": str(best_txt_path),
        "trade_line_count": len(trade_lines),
        "artifact_error": artifact_error,
    }
    summary_json_path.write_text(json.dumps(summary_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    leaderboard_row = _leaderboard_row(
        best_row=best_row,
        best_params=best_params,
        mode_label=mode_label,
        export_dir=export_dir,
        best_xs_path=best_indicator_xs_path,
        best_txt_path=best_txt_path,
        signature=signature,
        slip_per_side=float(runtime_settings["slip_per_side"]),
    )
    _update_persistent_top10(leaderboard_row, params_meta)
    historical_best_updated = _update_historical_best(
        best_row=best_row,
        best_params=best_params,
        mode_label=mode_label,
        export_dir=export_dir,
        best_indicator_xs_path=best_indicator_xs_path,
        best_trade_xs_path=best_trade_xs_path,
        best_txt_path=best_txt_path,
        summary_json_path=summary_json_path,
        runtime_settings=runtime_settings,
        tested_count=tested_count,
        total_count=total_count,
        elapsed_seconds=elapsed_seconds,
        compute_elapsed_seconds=compute_elapsed_seconds,
        transition_elapsed_seconds=transition_elapsed_seconds,
    )

    latest_memory_payload = {
        "saved_at": _now_text(),
        "run_dir": str(export_dir),
        "xs_path": xs_path,
        "m1_path": minute_path,
        "d1_path": daily_path,
        "txt_path": str(best_txt_path),
        "best_xs_path": str(best_indicator_xs_path),
        "best_indicator_xs_path": str(best_indicator_xs_path),
        "best_trade_xs_path": str(best_trade_xs_path),
        "best_txt_path": str(best_txt_path),
        "best_summary_json_path": str(summary_json_path),
        "optimization_mode": mode_label,
        "run_state": "completed",
        "cpu_limit_pct": int(runtime_settings.get("cpu_limit_pct", 100)),
        "memory_limit_pct": int(runtime_settings.get("memory_limit_pct", 100)),
        "requested_workers": int(runtime_settings.get("requested_workers", runtime_settings["max_workers"])),
        "effective_workers": int(runtime_settings["max_workers"]),
        "elapsed_seconds": float(elapsed_seconds),
        "compute_elapsed_seconds": float(compute_elapsed_seconds),
        "transition_elapsed_seconds": float(transition_elapsed_seconds),
        "tested_count": int(tested_count),
        "total_count": int(total_count),
        "capital": int(runtime_settings["capital"]),
        "slip_per_side": float(runtime_settings["slip_per_side"]),
        "min_trades": int(hard_filters.get("min_trades", 0)),
        "min_total_return": float(hard_filters.get("min_total_return", 0.0)),
        "max_mdd_pct": float(hard_filters.get("max_mdd_pct", 0.0)),
        "best_result": best_row,
        "latest_total_return_pct": _safe_float(best_row.get("total_return"), 0.0),
        "latest_mdd_pct": _safe_float(best_row.get("mdd_pct"), 0.0),
        "latest_n_trades": int(round(_safe_float(best_row.get("n_trades"), 0.0))),
        "historical_best_updated": bool(historical_best_updated),
        "fail_reason_counts": {str(key): int(value) for key, value in fail_reason_counts.items()},
    }
    _write_latest_memory(latest_memory_payload)

    return {
        "saved_at": latest_memory_payload["saved_at"],
        "export_dir": str(export_dir),
        "best_xs_path": str(best_indicator_xs_path),
        "best_indicator_xs_path": str(best_indicator_xs_path),
        "best_trade_xs_path": str(best_trade_xs_path),
        "best_txt_path": str(best_txt_path),
        "summary_json_path": str(summary_json_path),
        "trade_line_count": len(trade_lines),
        "artifact_error": artifact_error,
        "params": best_params,
        "historical_best_updated": bool(historical_best_updated),
    }


def load_latest_artifact_snapshot() -> dict[str, Any]:
    latest_memory = _load_latest_memory()
    best_xs_path = str(latest_memory.get("best_xs_path") or "").strip()
    best_indicator_xs_path = str(latest_memory.get("best_indicator_xs_path") or best_xs_path or "").strip()
    best_trade_xs_path = str(latest_memory.get("best_trade_xs_path") or "").strip()
    best_txt_path = str(latest_memory.get("best_txt_path") or latest_memory.get("txt_path") or "").strip()
    export_dir = str(latest_memory.get("run_dir") or "").strip()
    summary_json_path = str(latest_memory.get("best_summary_json_path") or "").strip()
    if not any([best_indicator_xs_path, best_trade_xs_path, best_txt_path, export_dir, summary_json_path]):
        return {}
    return {
        "saved_at": latest_memory.get("saved_at"),
        "export_dir": export_dir,
        "best_xs_path": best_indicator_xs_path,
        "best_indicator_xs_path": best_indicator_xs_path,
        "best_trade_xs_path": best_trade_xs_path,
        "best_txt_path": best_txt_path,
        "summary_json_path": summary_json_path,
    }


def _normalized_param_value(value: Any) -> int | float | str:
    normalized = _json_safe_value(value)
    if isinstance(normalized, float):
        if abs(normalized - round(normalized)) < 1e-9:
            return int(round(normalized))
        return round(normalized, 10)
    return normalized if normalized is not None else ""


def _performance_signature(row: Mapping[str, Any], focus_param: str) -> tuple[Any, ...]:
    metric_keys = [
        "n_trades",
        "total_return",
        "mdd_amount",
        "mdd_pct",
        "year_avg_return",
        "year_return_std",
        "loss_years",
        "composite_score",
    ]
    yearly_keys = sorted(key for key in row.keys() if str(key).startswith("year_return_"))
    values: list[Any] = []
    for key in [*metric_keys, *yearly_keys]:
        values.append(_normalized_param_value(row.get(key)))
    values.append(("focus_param", focus_param))
    return tuple(values)


def _stage_candidate_sort_key(row: Mapping[str, Any], focus_param: str) -> tuple[Any, ...]:
    focus_value = row.get(focus_param)
    normalized_focus = _normalized_param_value(focus_value)
    return (*_score_row(dict(row)), normalized_focus)


def _representative_stage_rows(
    rows: list[dict[str, Any]],
    *,
    focus_param: str,
    keep_count: int,
) -> list[dict[str, Any]]:
    if not rows:
        return []
    ranked_rows = sorted(rows, key=lambda row: _stage_candidate_sort_key(row, focus_param))
    selected_rows: list[dict[str, Any]] = []
    seen_signatures: set[tuple[Any, ...]] = set()
    seen_focus_values: set[Any] = set()
    for row in ranked_rows:
        focus_value = _normalized_param_value(row.get(focus_param))
        performance_signature = _performance_signature(row, focus_param)
        if performance_signature in seen_signatures or focus_value in seen_focus_values:
            continue
        seen_signatures.add(performance_signature)
        seen_focus_values.add(focus_value)
        selected_rows.append(dict(row))
        if len(selected_rows) >= keep_count:
            break
    if selected_rows:
        return selected_rows
    return [dict(ranked_rows[0])]


def _coordinate_cycle_generator(
    *,
    mode: str,
    fixed_params: dict[str, Any],
    variable_specs: list[dict[str, Any]],
    minute_path: str,
    daily_path: str,
    capital: int,
    script_name: str,
    slip_per_side: float,
    max_workers: int,
    top_n: int,
    hard_filters: dict[str, Any],
    keep_count: int,
) -> Iterable[dict[str, Any]]:
    if not variable_specs:
        single_combo = dict(fixed_params)
        started_at = time.time()
        for update in _evaluate_task_sequence_safe(
            tasks=[(single_combo, {"mode": mode, "cycle_no": 1, "round_no": 1, "stage_name": "固定參數"})],
            minute_path=minute_path,
            daily_path=daily_path,
            capital=capital,
            script_name=script_name,
            slip_per_side=slip_per_side,
            max_workers=max_workers,
            top_n=top_n,
            hard_filters=hard_filters,
            total_planned=1,
            initial_started_at=started_at,
        ):
            update["compute_elapsed"] = float(update.get("elapsed", 0.0))
            update["transition_elapsed"] = 0.0
            update["summary_lines"] = ["目前沒有勾選可變參數，本輪只會驗證一組固定參數。"]
            update["step_note"] = "固定參數驗證中"
            yield update
        return

    keep_count = max(1, int(keep_count or 3))
    started_at = time.time()
    done = 0
    passed = 0
    planned_total = 0
    cycle_no = 0
    stage_no = 0
    compute_elapsed_total = 0.0
    transition_elapsed_total = 0.0
    accepted_rows: list[dict[str, Any]] = []
    recent_rows: list[dict[str, Any]] = []
    fail_counts: dict[str, int] = {}
    current_combo = dict(fixed_params)
    for spec in variable_specs:
        current_combo.setdefault(spec["name"], spec.get("default", spec["values"][0]))

    previous_cycle_profiles: dict[str, tuple[Any, ...]] | None = None

    while True:
        cycle_no += 1
        cycle_profiles: dict[str, tuple[Any, ...]] = {}
        cycle_done_start = done
        cycle_passed_start = passed

        for param_idx, spec in enumerate(variable_specs, start=1):
            stage_no += 1
            focus_param = str(spec["name"])
            previous_focus_values = list(previous_cycle_profiles.get(focus_param, ())) if previous_cycle_profiles else []
            tasks: list[tuple[dict[str, Any], dict[str, Any]]] = []
            base_combo = dict(current_combo)
            for value in spec["values"]:
                combo = dict(base_combo)
                combo[focus_param] = value
                tasks.append(
                    (
                        combo,
                        {
                            "mode": mode,
                            "cycle_no": cycle_no,
                            "round_no": stage_no,
                            "stage_name": focus_param,
                            "param_index": param_idx,
                            "param_total": len(variable_specs),
                            "candidate_value": value,
                            "keep_count": keep_count,
                        },
                    )
                )

            if not tasks:
                cycle_profiles[focus_param] = (current_combo.get(focus_param),)
                continue

            planned_total += len(tasks)
            stage_rows: list[dict[str, Any]] = []
            stage_compute_started = time.time()

            for update in _evaluate_task_sequence_safe(
                tasks=tasks,
                minute_path=minute_path,
                daily_path=daily_path,
                capital=capital,
                script_name=script_name,
                slip_per_side=slip_per_side,
                max_workers=max_workers,
                top_n=top_n,
                hard_filters=hard_filters,
                initial_done=done,
                initial_passed=passed,
                total_planned=planned_total,
                initial_started_at=started_at,
                accepted_seed_rows=accepted_rows,
                recent_trial_rows=recent_rows,
                fail_reason_counts=fail_counts,
            ):
                done = int(update.get("done") or 0)
                passed = int(update.get("passed") or 0)
                accepted_rows = list(update.get("accepted_rows") or accepted_rows)
                recent_trials_df = update.get("recent_trials_df")
                if isinstance(recent_trials_df, pd.DataFrame):
                    recent_rows = list(recent_trials_df.to_dict("records"))
                fail_counts = dict(update.get("fail_reason_counts") or fail_counts)
                row = update.get("row")
                if row is not None and "error" not in row:
                    stage_rows.append(dict(row))

                update["compute_elapsed"] = compute_elapsed_total + max(time.time() - stage_compute_started, 0.0)
                update["transition_elapsed"] = transition_elapsed_total
                update["summary_lines"] = [
                    f"第 {cycle_no} 輪，第 {param_idx}/{len(variable_specs)} 個參數 {focus_param} 掃描中。",
                    f"目前只展開 {focus_param}，其他已勾選參數都固定在目前最佳值。",
                    f"本段共 {len(tasks):,} 組；結束後只記住 {focus_param} 的前 {keep_count} 個代表值，並沿用第 1 名繼續。",
                ]
                update["step_note"] = f"第 {cycle_no} 輪掃描 {focus_param}"
                update["stage_name"] = focus_param
                update["cycle_no"] = cycle_no
                update["round_no"] = stage_no
                yield update

            compute_elapsed_total += max(time.time() - stage_compute_started, 0.0)

            transition_started = time.time()
            ranked_source_rows = [row for row in stage_rows if _passes_hard_filters(row, hard_filters)] or stage_rows
            stage_pass_count = sum(1 for row in stage_rows if _passes_hard_filters(row, hard_filters))
            representative_rows = _representative_stage_rows(
                ranked_source_rows,
                focus_param=focus_param,
                keep_count=keep_count,
            )
            remembered_values = [_normalized_param_value(row.get(focus_param)) for row in representative_rows]
            if not remembered_values:
                remembered_values = [_normalized_param_value(current_combo.get(focus_param))]
            cycle_profiles[focus_param] = tuple(remembered_values)
            added_values = [value for value in remembered_values if value not in previous_focus_values]
            removed_values = [value for value in previous_focus_values if value not in remembered_values]
            current_combo[focus_param] = (
                representative_rows[0].get(focus_param, current_combo.get(focus_param))
                if representative_rows
                else current_combo.get(focus_param)
            )
            transition_elapsed_total += max(time.time() - transition_started, 0.0)
            remembered_text = " / ".join(str(value) for value in remembered_values)
            best_stage_row = representative_rows[0] if representative_rows else (ranked_source_rows[0] if ranked_source_rows else {})
            yield {
                "done": done,
                "passed": passed,
                "total": max(done, planned_total),
                "elapsed": time.time() - started_at,
                "compute_elapsed": compute_elapsed_total,
                "transition_elapsed": transition_elapsed_total,
                "eta": 0.0,
                "top_df": _sort_results_df(pd.DataFrame(accepted_rows)) if accepted_rows else pd.DataFrame(columns=RESULT_COLUMNS),
                "row": None,
                "meta": None,
                "accepted_rows": list(accepted_rows),
                "recent_trials_df": pd.DataFrame(recent_rows) if recent_rows else pd.DataFrame(),
                "fail_reason_counts": dict(fail_counts),
                "summary_lines": [
                    f"第 {cycle_no} 輪，第 {param_idx}/{len(variable_specs)} 個參數 {focus_param} 已完成；本段共跑 {len(tasks):,} 組，通過硬條件 {stage_pass_count:,} 組。",
                    f"記住的前 {len(remembered_values)} 個代表值：{remembered_text}；相較上一輪新增 {len(added_values)} 個、淘汰 {len(removed_values)} 個。",
                    f"本段第 1 名為 {focus_param}={remembered_values[0]}，總報酬 {_safe_float(best_stage_row.get('total_return'), 0.0):.2f}% / MDD {_safe_float(best_stage_row.get('mdd_pct'), 0.0):.2f}% / 交易數 {int(round(_safe_float(best_stage_row.get('n_trades'), 0.0)))}。",
                ],
                "step_note": f"第 {cycle_no} 輪完成 {focus_param}",
                "stage_name": focus_param,
                "cycle_no": cycle_no,
                "round_no": stage_no,
                "current_param_top_values": list(remembered_values),
            }

        stop_reason = ""
        if previous_cycle_profiles is not None and cycle_profiles == previous_cycle_profiles:
            stop_reason = f"本輪跑完後，所有已勾選參數的前 {keep_count} 名代表值都和上一輪相同，停止。"
        changed_param_count = 0 if previous_cycle_profiles is None else sum(
            1 for key, value in cycle_profiles.items() if tuple(previous_cycle_profiles.get(key, ())) != tuple(value)
        )
        previous_cycle_profiles = dict(cycle_profiles)

        yield {
            "done": done,
            "passed": passed,
            "total": max(done, planned_total),
            "elapsed": time.time() - started_at,
            "compute_elapsed": compute_elapsed_total,
            "transition_elapsed": transition_elapsed_total,
            "eta": 0.0,
            "top_df": _sort_results_df(pd.DataFrame(accepted_rows)) if accepted_rows else pd.DataFrame(columns=RESULT_COLUMNS),
            "row": None,
            "meta": None,
            "accepted_rows": list(accepted_rows),
            "recent_trials_df": pd.DataFrame(recent_rows) if recent_rows else pd.DataFrame(),
            "fail_reason_counts": dict(fail_counts),
            "summary_lines": [
                f"第 {cycle_no} 輪已完成，本輪新增測試 {done - cycle_done_start:,} 組，其中通過硬條件 {passed - cycle_passed_start:,} 組。",
                f"本輪共有 {changed_param_count} 個參數的保留名單與上一輪不同。",
                stop_reason or "下一輪會從目前最佳組合重新開始，再逐參數各掃一次。",
            ],
            "step_note": f"第 {cycle_no} 輪循環完成",
            "cycle_no": cycle_no,
            "stop_reason": stop_reason,
            "cycle_profiles": {key: list(value) for key, value in cycle_profiles.items()},
        }

        if stop_reason:
            break


def _streamlit_update_stride(*, max_workers: int, total: int) -> int:
    worker_stride = max(_STREAMLIT_UPDATE_MIN_STRIDE, max(1, int(max_workers)) * 4)
    if total <= 0:
        return min(worker_stride, _STREAMLIT_UPDATE_MAX_STRIDE)
    total_stride = max(_STREAMLIT_UPDATE_MIN_STRIDE, total // 150)
    return min(max(worker_stride, total_stride), _STREAMLIT_UPDATE_MAX_STRIDE)


def _evaluate_task_sequence_safe(
    *,
    tasks: list[tuple[dict[str, Any], Any]],
    minute_path: str | None,
    daily_path: str | None,
    capital: int,
    script_name: str,
    slip_per_side: float,
    max_workers: int,
    top_n: int,
    hard_filters: dict[str, Any],
    initial_done: int = 0,
    initial_passed: int = 0,
    total_planned: int | None = None,
    initial_started_at: float | None = None,
    accepted_seed_rows: list[dict[str, Any]] | None = None,
    recent_trial_rows: list[dict[str, Any]] | None = None,
    fail_reason_counts: dict[str, int] | None = None,
) -> Iterable[dict[str, Any]]:
    if int(max_workers) > 1:
        yield from _evaluate_task_sequence(
            tasks=tasks,
            minute_path=minute_path,
            daily_path=daily_path,
            capital=capital,
            script_name=script_name,
            slip_per_side=slip_per_side,
            max_workers=max_workers,
            top_n=top_n,
            hard_filters=hard_filters,
            initial_done=initial_done,
            initial_passed=initial_passed,
            total_planned=total_planned,
            initial_started_at=initial_started_at,
            accepted_seed_rows=accepted_seed_rows,
            recent_trial_rows=recent_trial_rows,
            fail_reason_counts=fail_reason_counts,
        )
        return

    total = total_planned if total_planned is not None else len(tasks)
    if total == 0:
        yield {"done": 0, "passed": 0, "total": 0, "elapsed": 0.0, "eta": 0.0, "top_df": pd.DataFrame(), "row": None, "meta": None}
        return

    if not minute_path or not daily_path:
        raise ValueError("missing M1 / D1 data paths")

    _init_worker_data(minute_path, daily_path, capital, script_name, slip_per_side)
    started_at = time.time() if initial_started_at is None else initial_started_at
    done = initial_done
    passed = initial_passed
    accepted_rows: list[dict[str, Any]] = list(accepted_seed_rows or [])
    recent_rows: list[dict[str, Any]] = list(recent_trial_rows or [])
    fail_counts: dict[str, int] = dict(fail_reason_counts or {})

    for combo, meta in tasks:
        try:
            row = _run_single_combo(combo)
        except Exception as exc:
            row = {"error": str(exc), "n_trades": 0, "total_return": -1e18, "mdd_amount": 1e18, "mdd_pct": 1e18}

        done += 1
        latest_fail_reasons: list[str] = []
        if "error" not in row:
            latest_fail_reasons = _hard_filter_fail_reasons(row, hard_filters)
            if not latest_fail_reasons:
                accepted_rows.append(row)
                accepted_rows.sort(key=_score_row)
                if len(accepted_rows) > top_n:
                    accepted_rows = accepted_rows[:top_n]
                passed += 1
            else:
                for reason in latest_fail_reasons:
                    fail_counts[reason] = fail_counts.get(reason, 0) + 1
        else:
            latest_fail_reasons = [f"執行失敗: {row['error']}"]
            fail_counts[latest_fail_reasons[0]] = fail_counts.get(latest_fail_reasons[0], 0) + 1

        trial_row: dict[str, Any] = {}
        if meta is not None and isinstance(meta, dict):
            trial_row.update({k: v for k, v in meta.items() if k not in {"summary_lines"}})
        trial_row.update(
            {
                "status": "通過" if not latest_fail_reasons else "淘汰",
                "reason": "、".join(latest_fail_reasons) if latest_fail_reasons else "通過硬條件",
                "n_trades": int(row.get("n_trades", 0)),
                "total_return": float(row.get("total_return", 0.0)),
                "mdd_pct": float(row.get("mdd_pct", 0.0)),
            }
        )
        for key, value in row.items():
            if key not in trial_row and key != "error":
                trial_row[key] = value
        recent_rows.append(trial_row)
        recent_rows = recent_rows[-30:]

        elapsed = time.time() - started_at
        avg = elapsed / done if done > 0 else 0.0
        eta = avg * max(total - done, 0)
        top_df = pd.DataFrame(accepted_rows) if accepted_rows else pd.DataFrame(columns=RESULT_COLUMNS)
        top_df = _sort_results_df(top_df)
        yield {
            "done": done,
            "passed": passed,
            "total": total,
            "elapsed": elapsed,
            "eta": eta,
            "top_df": top_df,
            "row": row,
            "meta": meta,
            "accepted_rows": list(accepted_rows),
            "recent_trials_df": _build_recent_trials_df(recent_rows),
            "fail_reason_counts": dict(fail_counts),
            "latest_fail_reasons": list(latest_fail_reasons),
        }


def _throttled_optimizer_updates(
    iterator: Iterable[dict[str, Any]],
    *,
    max_workers: int,
) -> Iterable[dict[str, Any]]:
    pending_update: dict[str, Any] | None = None
    last_yield_done = -1
    last_yield_at = 0.0

    for update in iterator:
        pending_update = update
        done = int(update.get("done") or 0)
        total = int(update.get("total") or 0)
        now = time.monotonic()
        stride = _streamlit_update_stride(max_workers=max_workers, total=total)

        should_yield = last_yield_done < 0
        if total > 0 and done >= total:
            should_yield = True
        if done > max(last_yield_done, 0) and (done - max(last_yield_done, 0)) >= stride:
            should_yield = True
        if (now - last_yield_at) >= _STREAMLIT_UPDATE_MIN_INTERVAL_SECONDS:
            should_yield = True

        if should_yield:
            yield update
            last_yield_done = done
            last_yield_at = now
            pending_update = None

    if pending_update is not None:
        yield pending_update


def run_optimizer(
    *,
    mode: str,
    ui_param_specs: list[dict[str, Any]],
    params_meta: list[dict[str, Any]],
    runtime_settings: dict[str, Any],
    hard_filters: dict[str, Any],
    minute_path: str,
    daily_path: str,
    script_name: str,
) -> Iterable[dict[str, Any]]:
    max_workers = int(runtime_settings["max_workers"])
    apply_cpu_guard(cpu_limit_pct=int(runtime_settings.get("cpu_limit_pct", 100)))
    try:
        fixed_params, variable_specs = build_search_space_from_ui(ui_param_specs, params_meta)
        iterator = _coordinate_cycle_generator(
            mode=mode,
            fixed_params=fixed_params,
            variable_specs=variable_specs,
            minute_path=minute_path,
            daily_path=daily_path,
            capital=int(runtime_settings["capital"]),
            script_name=script_name,
            slip_per_side=float(runtime_settings["slip_per_side"]),
            max_workers=max_workers,
            top_n=int(runtime_settings["top_n"]),
            hard_filters=hard_filters,
            keep_count=int(runtime_settings["seed_keep_count"]),
        )

        for update in _throttled_optimizer_updates(iterator, max_workers=max_workers):
            yield update
    finally:
        shutdown_cached_worker_executor(wait=False, cancel_futures=False)


def dataframe_to_csv_bytes(df: pd.DataFrame) -> bytes:
    if df.empty:
        return b""
    buffer = BytesIO()
    df.to_csv(buffer, index=False, encoding="utf-8-sig")
    return buffer.getvalue()
