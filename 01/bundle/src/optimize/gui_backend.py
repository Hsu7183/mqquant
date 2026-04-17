# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import random
import time
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from itertools import product
from multiprocessing import freeze_support
from typing import Any, Iterable

import pandas as pd

from src.backtest.report import build_report
from src.data.data_loader import load_d1, load_m1
from src.data.dedupe_loader import dedupe
from src.strategy.strategy_0313plus import run_0313plus_backtest


RESULT_COLUMNS = ["n_trades", "total_return", "mdd_amount", "mdd_pct"]
_WORKER_MINUTE_BARS: list[Any] | None = None
_WORKER_DAILY_BARS: list[Any] | None = None
_WORKER_CAPITAL: int | None = None
_WORKER_SCRIPT_NAME: str | None = None
_WORKER_SLIP_PER_SIDE: float = 0.0
_CACHED_WORKER_EXECUTOR: ProcessPoolExecutor | None = None
_CACHED_WORKER_EXECUTOR_KEY: tuple[Any, ...] | None = None


def format_seconds(seconds: float) -> str:
    total_seconds = max(0, int(seconds))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    if hours > 0:
        return f"{hours}h {minutes}m {secs}s"
    if minutes > 0:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


def _coerce_number(value: Any, value_type: str) -> int | float:
    text = str(value).strip()
    if value_type in ("int", "integer"):
        return int(float(text))
    return float(text)


def _frange(start: float, stop: float, step: float) -> list[float]:
    if step == 0:
        raise ValueError("step must not be 0")
    values: list[float] = []
    current = start
    if step > 0:
        while current <= stop + 1e-12:
            values.append(round(current, 10))
            current += step
    else:
        while current >= stop - 1e-12:
            values.append(round(current, 10))
            current += step
    return values


def _make_values(start: Any, stop: Any, step: Any, value_type: str) -> list[int | float]:
    if value_type in ("int", "integer"):
        s = int(float(start))
        e = int(float(stop))
        k = int(float(step))
        if k == 0:
            raise ValueError("int step must not be 0")
        if (k > 0 and s > e) or (k < 0 and s < e):
            raise ValueError("int range direction does not match step")
        values: list[int] = []
        current = s
        if k > 0:
            while current <= e:
                values.append(int(current))
                current += k
        else:
            while current >= e:
                values.append(int(current))
                current += k
        return values

    s = float(start)
    e = float(stop)
    k = float(step)
    if k == 0:
        raise ValueError("float step must not be 0")
    if (k > 0 and s > e) or (k < 0 and s < e):
        raise ValueError("float range direction does not match step")
    return [float(v) for v in _frange(s, e, k)]


def build_param_grid_from_ui(ui_param_specs: list[dict[str, Any]], params_meta: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not params_meta:
        raise ValueError("params_meta is empty")

    meta_map = {str(item["name"]): item for item in params_meta}
    value_lists: list[tuple[str, list[int | float]]] = []
    for spec in ui_param_specs:
        name = str(spec["name"])
        meta = meta_map.get(name)
        if meta is None:
            raise ValueError(f"param metadata not found: {name}")
        value_type = str(spec.get("type") or meta.get("type") or "float").lower()
        default = meta.get("default", spec.get("default", 0))
        enabled = bool(spec.get("enabled", False))
        if enabled:
            values = _make_values(spec.get("start", default), spec.get("stop", default), spec.get("step", 1), value_type)
        else:
            values = [_coerce_number(default, value_type)]
        if not values:
            raise ValueError(f"param has no generated values: {name}")
        value_lists.append((name, values))

    all_names = [item[0] for item in value_lists]
    all_value_lists = [item[1] for item in value_lists]
    combos: list[dict[str, Any]] = []
    for combo in product(*all_value_lists):
        combos.append({name: value for name, value in zip(all_names, combo)})
    return combos


def build_search_space_from_ui(ui_param_specs: list[dict[str, Any]], params_meta: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not params_meta:
        raise ValueError("params_meta is empty")

    meta_map = {str(item["name"]): item for item in params_meta}
    fixed_params: dict[str, Any] = {}
    variable_specs: list[dict[str, Any]] = []
    for spec in ui_param_specs:
        name = str(spec["name"])
        meta = meta_map.get(name)
        if meta is None:
            raise ValueError(f"param metadata not found: {name}")
        value_type = str(spec.get("type") or meta.get("type") or "float").lower()
        default = meta.get("default", spec.get("default", 0))
        enabled = bool(spec.get("enabled", False))
        values = _make_values(spec.get("start", default), spec.get("stop", default), spec.get("step", 1), value_type) if enabled else [_coerce_number(default, value_type)]
        if not values:
            raise ValueError(f"param has no generated values: {name}")
        if enabled and len(values) > 1:
            variable_specs.append({"name": name, "values": values, "type": value_type, "default": _coerce_number(default, value_type)})
        else:
            fixed_params[name] = values[0]

    return fixed_params, variable_specs


def estimate_sequential_total(variable_specs: list[dict[str, Any]], seed_keep_count: int) -> int:
    if not variable_specs:
        return 0
    total = 0
    active_seeds = 1
    for spec in variable_specs:
        total += active_seeds * len(spec["values"])
        active_seeds = max(1, seed_keep_count)
    return total


def load_market_data(minute_path: str, daily_path: str) -> tuple[list[Any], list[Any]]:
    return dedupe(load_m1(minute_path)), dedupe(load_d1(daily_path))


def _extract_metrics(report: dict[str, Any]) -> dict[str, Any]:
    yearly_values: list[float] = []
    metrics = {
        "n_trades": int(report.get("n_trades", 0)),
        "total_return": float(report.get("total_return", 0.0)) * 100.0,
        "mdd_amount": float(report.get("mdd_amount", 0.0)),
        "mdd_pct": float(report.get("mdd_pct", 0.0)) * 100.0,
    }
    for item in report.get("yearly_returns", []) or []:
        period = str(item.get("period", "")).strip()
        if not period:
            continue
        year_return = float(item.get("return", 0.0)) * 100.0
        yearly_values.append(year_return)
        metrics[f"year_return_{period}"] = year_return
    if yearly_values:
        year_count = len(yearly_values)
        year_avg = sum(yearly_values) / year_count
        year_std = (sum((value - year_avg) ** 2 for value in yearly_values) / year_count) ** 0.5
        loss_years = sum(1 for value in yearly_values if value < 0)
    else:
        year_avg = 0.0
        year_std = 0.0
        loss_years = 0
    metrics["year_avg_return"] = year_avg
    metrics["year_return_std"] = year_std
    metrics["loss_years"] = loss_years
    metrics["composite_score"] = (
        float(metrics["total_return"]) * 0.20
        + float(year_avg) * 0.15
        - float(metrics["mdd_pct"]) * 0.55
        - float(year_std) * 0.10
        - float(loss_years) * 5.0
    )
    return metrics


def _passes_hard_filters(metrics: dict[str, Any], hard_filters: dict[str, Any]) -> bool:
    min_trades = int(hard_filters.get("min_trades", 0))
    min_total_return = float(hard_filters.get("min_total_return", -1e18))
    max_mdd_pct = float(hard_filters.get("max_mdd_pct", 1e18))
    if int(metrics["n_trades"]) < min_trades:
        return False
    if float(metrics["total_return"]) < min_total_return:
        return False
    if float(metrics["mdd_pct"]) > max_mdd_pct:
        return False
    return True


def _hard_filter_fail_reasons(metrics: dict[str, Any], hard_filters: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    min_trades = int(hard_filters.get("min_trades", 0))
    min_total_return = float(hard_filters.get("min_total_return", -1e18))
    max_mdd_pct = float(hard_filters.get("max_mdd_pct", 1e18))
    if int(metrics.get("n_trades", 0)) < min_trades:
        reasons.append(f"交易筆數 < {min_trades}")
    if float(metrics.get("total_return", 0.0)) < min_total_return:
        reasons.append(f"總報酬 < {min_total_return:.2f}%")
    if float(metrics.get("mdd_pct", 0.0)) > max_mdd_pct:
        reasons.append(f"MDD > {max_mdd_pct:.2f}%")
    return reasons


def _score_row(row: dict[str, Any]) -> tuple[float, float, int]:
    return (
        -float(row.get("composite_score", -1e18)),
        float(row.get("mdd_pct", 999999.0)),
        -float(row.get("total_return", -1e18)),
    )


def _sort_results_df(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    sort_columns = [col for col in ["composite_score", "mdd_pct", "total_return", "year_avg_return"] if col in df.columns]
    ascending = [False, True, False, False][: len(sort_columns)]
    return df.sort_values(by=sort_columns, ascending=ascending, kind="stable").reset_index(drop=True)


def _build_recent_trials_df(rows: list[dict[str, Any]]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows).reset_index(drop=True)


def _init_worker_data(minute_path: str, daily_path: str, capital: int, script_name: str, slip_per_side: float) -> None:
    global _WORKER_MINUTE_BARS, _WORKER_DAILY_BARS, _WORKER_CAPITAL, _WORKER_SCRIPT_NAME, _WORKER_SLIP_PER_SIDE
    _WORKER_MINUTE_BARS, _WORKER_DAILY_BARS = load_market_data(minute_path, daily_path)
    _WORKER_CAPITAL = capital
    _WORKER_SCRIPT_NAME = script_name
    _WORKER_SLIP_PER_SIDE = float(slip_per_side)


def _run_single_combo(combo: dict[str, Any]) -> dict[str, Any]:
    if _WORKER_MINUTE_BARS is None or _WORKER_DAILY_BARS is None or _WORKER_CAPITAL is None or _WORKER_SCRIPT_NAME is None:
        raise RuntimeError("worker data is not initialized")

    result = run_0313plus_backtest(
        _WORKER_MINUTE_BARS,
        _WORKER_DAILY_BARS,
        combo,
        _WORKER_SCRIPT_NAME,
        slip_per_side=_WORKER_SLIP_PER_SIDE,
    )
    report = build_report(result, _WORKER_DAILY_BARS, _WORKER_CAPITAL)
    row = dict(combo)
    row.update(_extract_metrics(report))
    return row


def _build_worker_executor(
    minute_path: str,
    daily_path: str,
    capital: int,
    script_name: str,
    slip_per_side: float,
    max_workers: int,
) -> ProcessPoolExecutor:
    worker_count = max(1, min(int(max_workers), os.cpu_count() or 1))
    return ProcessPoolExecutor(
        max_workers=worker_count,
        initializer=_init_worker_data,
        initargs=(minute_path, daily_path, capital, script_name, slip_per_side),
    )


def _get_cached_worker_executor(
    minute_path: str,
    daily_path: str,
    capital: int,
    script_name: str,
    slip_per_side: float,
    max_workers: int,
) -> ProcessPoolExecutor:
    global _CACHED_WORKER_EXECUTOR, _CACHED_WORKER_EXECUTOR_KEY
    worker_count = max(1, min(int(max_workers), os.cpu_count() or 1))
    cache_key = (
        str(minute_path),
        str(daily_path),
        int(capital),
        str(script_name),
        float(slip_per_side),
        worker_count,
    )
    if _CACHED_WORKER_EXECUTOR is not None and _CACHED_WORKER_EXECUTOR_KEY == cache_key:
        return _CACHED_WORKER_EXECUTOR

    shutdown_cached_worker_executor()
    _CACHED_WORKER_EXECUTOR = _build_worker_executor(
        minute_path,
        daily_path,
        capital,
        script_name,
        slip_per_side,
        worker_count,
    )
    _CACHED_WORKER_EXECUTOR_KEY = cache_key
    return _CACHED_WORKER_EXECUTOR


def shutdown_cached_worker_executor(wait: bool = True, cancel_futures: bool = False) -> None:
    global _CACHED_WORKER_EXECUTOR, _CACHED_WORKER_EXECUTOR_KEY
    if _CACHED_WORKER_EXECUTOR is not None:
        _CACHED_WORKER_EXECUTOR.shutdown(wait=wait, cancel_futures=cancel_futures)
    _CACHED_WORKER_EXECUTOR = None
    _CACHED_WORKER_EXECUTOR_KEY = None


def _evaluate_task_sequence(
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
    executor: ProcessPoolExecutor | None = None,
) -> Iterable[dict[str, Any]]:
    freeze_support()
    total = total_planned if total_planned is not None else len(tasks)
    if total == 0:
        yield {"done": 0, "passed": 0, "total": 0, "elapsed": 0.0, "eta": 0.0, "top_df": pd.DataFrame(), "row": None, "meta": None}
        return

    if not minute_path or not daily_path:
        raise ValueError("missing M1 / D1 data paths")

    started_at = time.time() if initial_started_at is None else initial_started_at
    done = initial_done
    passed = initial_passed
    accepted_rows: list[dict[str, Any]] = list(accepted_seed_rows or [])
    recent_rows: list[dict[str, Any]] = list(recent_trial_rows or [])
    fail_counts: dict[str, int] = dict(fail_reason_counts or {})
    worker_count = max(1, min(int(max_workers), len(tasks), os.cpu_count() or 1))
    submit_window = max(worker_count * 4, 8)
    active_executor = executor or _get_cached_worker_executor(
        minute_path,
        daily_path,
        capital,
        script_name,
        slip_per_side,
        max_workers,
    )
    try:
        task_iter = iter(tasks)
        pending: dict[Any, Any] = {}

        while len(pending) < submit_window:
            try:
                combo, meta = next(task_iter)
                pending[active_executor.submit(_run_single_combo, combo)] = meta
            except StopIteration:
                break

        while pending:
            done_set, still_pending = wait(set(pending.keys()), return_when=FIRST_COMPLETED)
            done_meta = {future: pending[future] for future in done_set}
            pending = {future: pending[future] for future in still_pending}
            for future in done_set:
                meta = done_meta.get(future)
                try:
                    row = future.result()
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

                while len(pending) < submit_window:
                    try:
                        combo, new_meta = next(task_iter)
                        pending[active_executor.submit(_run_single_combo, combo)] = new_meta
                    except StopIteration:
                        break
    finally:
        pass


def optimize_generator(
    param_grid: list[dict[str, Any]],
    minute_bars: Any | None,
    daily_bars: Any | None,
    minute_path: str | None,
    daily_path: str | None,
    capital: int,
    script_name: str,
    slip_per_side: float,
    max_workers: int,
    top_n: int,
    hard_filters: dict[str, Any],
) -> Iterable[dict[str, Any]]:
    tasks = [(combo, None) for combo in param_grid]
    for update in _evaluate_task_sequence(
        tasks=tasks,
        minute_path=minute_path,
        daily_path=daily_path,
        capital=capital,
        script_name=script_name,
        slip_per_side=slip_per_side,
        max_workers=max_workers,
        top_n=top_n,
        hard_filters=hard_filters,
    ):
        update["compute_elapsed"] = float(update.get("elapsed", 0.0))
        update["transition_elapsed"] = 0.0
        yield update


def smart_optimize_generator(
    fixed_params: dict[str, Any],
    variable_specs: list[dict[str, Any]],
    minute_path: str | None,
    daily_path: str | None,
    capital: int,
    script_name: str,
    slip_per_side: float,
    max_workers: int,
    top_n: int,
    hard_filters: dict[str, Any],
    total_budget: int,
    initial_samples: int,
    seed_top_k: int,
    neighbors_per_seed: int,
    rng_seed: int = 42,
) -> Iterable[dict[str, Any]]:
    del total_budget, initial_samples, neighbors_per_seed
    seed_top_k = max(1, int(seed_top_k or 3))

    if not variable_specs:
        single_combo = dict(fixed_params)
        for update in optimize_generator(
            param_grid=[single_combo],
            minute_bars=None,
            daily_bars=None,
            minute_path=minute_path,
            daily_path=daily_path,
            capital=capital,
            script_name=script_name,
            slip_per_side=slip_per_side,
            max_workers=max_workers,
            top_n=top_n,
            hard_filters=hard_filters,
        ):
            yield update
        return

    total_possible = 1
    for spec in variable_specs:
        total_possible *= len(spec["values"])

    rng = random.Random(rng_seed)
    accepted_rows: list[dict[str, Any]] = []
    recent_rows: list[dict[str, Any]] = []
    fail_counts: dict[str, int] = {}
    started_at = time.time()
    done = 0
    passed = 0
    planned_total = 0
    cycle_no = 0
    stage_no = 0
    compute_elapsed_total = 0.0
    transition_elapsed_total = 0.0

    def _combo_signature(combo: dict[str, Any]) -> tuple[tuple[str, Any], ...]:
        items: list[tuple[str, Any]] = []
        for key in sorted(combo.keys()):
            value = combo[key]
            if isinstance(value, float):
                value = round(value, 10)
            items.append((key, value))
        return tuple(items)

    def _row_signature(row: dict[str, Any]) -> tuple[tuple[str, Any], ...]:
        combo = dict(fixed_params)
        for spec in variable_specs:
            combo[spec["name"]] = row[spec["name"]]
        return _combo_signature(combo)

    def _random_seed() -> dict[str, Any]:
        combo = dict(fixed_params)
        for spec in variable_specs:
            combo[spec["name"]] = rng.choice(spec["values"])
        return combo

    def _candidate_sort_key(row: dict[str, Any], param_name: str) -> tuple[Any, ...]:
        key: list[Any] = list(_score_row(row))
        key.append(float(row.get(param_name, 0)))
        for spec in variable_specs:
            value = row.get(spec["name"], 0)
            key.append(float(value) if isinstance(value, (int, float)) else str(value))
        return tuple(key)

    def _select_seed_rows(
        candidates: list[dict[str, Any]],
        fallback_rows: list[dict[str, Any]],
        keep_count: int,
        param_name: str,
    ) -> list[dict[str, Any]]:
        if candidates:
            ranked = sorted(candidates, key=lambda row: _candidate_sort_key(row, param_name))
            return [dict(row) for row in ranked[:keep_count]]
        return [dict(row) for row in fallback_rows[:keep_count]]

    current_seed_rows: list[dict[str, Any]] = [_random_seed()]
    prev_cycle_signature = tuple(_row_signature(row) for row in current_seed_rows)

    while True:
        cycle_no += 1
        keep_count = 1 if cycle_no <= 2 else min(seed_top_k, 3)

        for param_idx, spec in enumerate(variable_specs, start=1):
            stage_no += 1
            stage_transition_started = time.time()
            tasks: list[tuple[dict[str, Any], Any]] = []
            for seed_idx, seed_row in enumerate(current_seed_rows, start=1):
                base_combo = dict(fixed_params)
                for item in variable_specs:
                    base_combo[item["name"]] = seed_row[item["name"]]
                for value in spec["values"]:
                    combo = dict(base_combo)
                    combo[spec["name"]] = value
                    tasks.append(
                        (
                            combo,
                            {
                                "mode": "smart",
                                "cycle_no": cycle_no,
                                "round_no": stage_no,
                                "stage_name": spec["name"],
                                "param_index": param_idx,
                                "param_total": len(variable_specs),
                                "seed_index": seed_idx,
                                "seed_total": len(current_seed_rows),
                                "candidate_value": value,
                                "keep_count": keep_count,
                            },
                        )
                    )

            stage_task_count = len(tasks)
            if stage_task_count == 0:
                continue

            planned_total += stage_task_count
            stage_rows: list[dict[str, Any]] = []
            transition_elapsed_total += max(time.time() - stage_transition_started, 0.0)
            stage_compute_started = time.time()

            for update in _evaluate_task_sequence(
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
                done = int(update["done"])
                passed = int(update["passed"])
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
                    f"第 {cycle_no} 輪循環，第 {stage_no} 次參數測試，正在掃描 {spec['name']}。",
                    f"固定其他 {max(len(variable_specs) - 1, 0)} 個參數，本次共測 {stage_task_count} 筆。",
                    f"若績效同分，這一步會優先保留較小的 {spec['name']}。",
                ]
                update["step_note"] = f"第 {stage_no} 次測試，參數 {spec['name']} 測試中"
                update["round_no"] = stage_no
                update["cycle_no"] = cycle_no
                update["current_param"] = spec["name"]
                update["space_total"] = total_possible
                yield update

            compute_elapsed_total += max(time.time() - stage_compute_started, 0.0)
            if not stage_rows:
                continue

            stage_transition_started = time.time()
            stage_pass_rows = [row for row in stage_rows if _passes_hard_filters(row, hard_filters)]
            chosen_rows = stage_pass_rows if stage_pass_rows else stage_rows
            current_seed_rows = _select_seed_rows(chosen_rows, current_seed_rows, keep_count, spec["name"])
            transition_elapsed_total += max(time.time() - stage_transition_started, 0.0)

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
                "recent_trials_df": _build_recent_trials_df(recent_rows),
                "fail_reason_counts": dict(fail_counts),
                "summary_lines": [
                    f"第 {stage_no} 次測試完成，參數 {spec['name']} 已更新。",
                    f"本次從 {stage_task_count} 筆中保留前 {len(current_seed_rows)} 名；同分時優先取較小參數。",
                ],
                "step_note": f"第 {stage_no} 次測試完成，參數 {spec['name']}",
                "round_no": stage_no,
                "cycle_no": cycle_no,
                "current_param": spec["name"],
                "space_total": total_possible,
            }

        cycle_transition_started = time.time()
        current_cycle_signature = tuple(_row_signature(row) for row in current_seed_rows)
        stop_reason = ""
        if current_cycle_signature == prev_cycle_signature and cycle_no >= 2:
            stop_reason = "完整跑完一輪後，保留的最佳參數組合已經不再變動，智慧搜尋停止。"
        prev_cycle_signature = current_cycle_signature
        transition_elapsed_total += max(time.time() - cycle_transition_started, 0.0)

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
            "recent_trials_df": _build_recent_trials_df(recent_rows),
            "fail_reason_counts": dict(fail_counts),
            "summary_lines": [
                f"第 {cycle_no} 輪循環已完成，共跑完 {len(variable_specs)} 個參數。",
                stop_reason or f"下一輪會以目前最佳組合繼續，保留前 {1 if cycle_no + 1 <= 2 else min(seed_top_k, 3)} 名。",
            ],
            "step_note": f"第 {cycle_no} 輪循環完成",
            "round_no": stage_no,
            "cycle_no": cycle_no,
            "stop_reason": stop_reason,
            "space_total": total_possible,
        }

        if stop_reason:
            break


def sequential_optimize_generator(
    fixed_params: dict[str, Any],
    variable_specs: list[dict[str, Any]],
    minute_path: str | None,
    daily_path: str | None,
    capital: int,
    script_name: str,
    slip_per_side: float,
    max_workers: int,
    top_n: int,
    hard_filters: dict[str, Any],
    seed_keep_count: int = 3,
) -> Iterable[dict[str, Any]]:
    if not variable_specs:
        single_combo = dict(fixed_params)
        for update in optimize_generator(
            param_grid=[single_combo],
            minute_bars=None,
            daily_bars=None,
            minute_path=minute_path,
            daily_path=daily_path,
            capital=capital,
            script_name=script_name,
            slip_per_side=slip_per_side,
            max_workers=max_workers,
            top_n=top_n,
            hard_filters=hard_filters,
        ):
            update["stage_name"] = "固定參數"
            yield update
        return

    started_at = time.time()
    done = 0
    passed = 0
    seed_rows: list[dict[str, Any]] = [dict(fixed_params)]
    best_rows: list[dict[str, Any]] = []
    total_planned = estimate_sequential_total(variable_specs, seed_keep_count)

    for spec in variable_specs:
        tasks: list[tuple[dict[str, Any], Any]] = []
        raw_rows: list[dict[str, Any]] = []
        for seed_idx, seed in enumerate(seed_rows):
            for value in spec["values"]:
                combo = dict(seed)
                combo[spec["name"]] = value
                tasks.append((combo, {"stage_name": spec["name"], "seed_idx": seed_idx}))

        stage_best_rows: list[dict[str, Any]] = []
        stage_good_rows: list[dict[str, Any]] = []
        for update in _evaluate_task_sequence(
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
            total_planned=total_planned,
            initial_started_at=started_at,
            accepted_seed_rows=best_rows,
        ):
            done = int(update["done"])
            passed = int(update["passed"])
            row = update.get("row")
            if row is not None and "error" not in row:
                raw_rows.append(row)
            stage_good_rows = list(update.get("accepted_rows") or stage_good_rows)
            stage_best_rows = list(stage_good_rows)
            update["stage_name"] = spec["name"]
            yield update

        candidates = stage_good_rows if stage_good_rows else raw_rows
        if not candidates:
            continue
        ranked = sorted(candidates, key=_score_row)
        seed_rows = [dict(row) for row in ranked[: max(1, seed_keep_count)]]
        best_rows = sorted((best_rows + ranked), key=_score_row)[:top_n]


def sequential_optimize_generator(
    fixed_params: dict[str, Any],
    variable_specs: list[dict[str, Any]],
    minute_path: str | None,
    daily_path: str | None,
    capital: int,
    script_name: str,
    slip_per_side: float,
    max_workers: int,
    top_n: int,
    hard_filters: dict[str, Any],
    seed_keep_count: int = 2,
) -> Iterable[dict[str, Any]]:
    if not variable_specs:
        single_combo = dict(fixed_params)
        for update in optimize_generator(
            param_grid=[single_combo],
            minute_bars=None,
            daily_bars=None,
            minute_path=minute_path,
            daily_path=daily_path,
            capital=capital,
            script_name=script_name,
            slip_per_side=slip_per_side,
            max_workers=max_workers,
            top_n=top_n,
            hard_filters=hard_filters,
        ):
            update["stage_name"] = "固定參數"
            yield update
        return

    keep_count = max(1, int(seed_keep_count or 2))
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

    def _combo_signature(combo: dict[str, Any]) -> tuple[tuple[str, Any], ...]:
        items: list[tuple[str, Any]] = []
        for key in sorted(combo.keys()):
            value = combo[key]
            if isinstance(value, float):
                value = round(value, 10)
            items.append((key, value))
        return tuple(items)

    def _row_signature(row: dict[str, Any]) -> tuple[tuple[str, Any], ...]:
        combo = dict(fixed_params)
        for spec in variable_specs:
            combo[spec["name"]] = row.get(spec["name"], spec.get("default", spec["values"][0]))
        return _combo_signature(combo)

    def _candidate_sort_key(row: dict[str, Any], param_name: str) -> tuple[Any, ...]:
        key: list[Any] = list(_score_row(row))
        focus_value = row.get(param_name, 0)
        key.append(float(focus_value) if isinstance(focus_value, (int, float)) else str(focus_value))
        for spec in variable_specs:
            if spec["name"] == param_name:
                continue
            value = row.get(spec["name"], spec.get("default", spec["values"][0]))
            key.append(float(value) if isinstance(value, (int, float)) else str(value))
        return tuple(key)

    current_seed_rows: list[dict[str, Any]] = [
        {
            **fixed_params,
            **{spec["name"]: spec.get("default", spec["values"][0]) for spec in variable_specs},
        }
    ]
    prev_cycle_signature = tuple(_row_signature(row) for row in current_seed_rows)

    while True:
        cycle_no += 1

        for param_idx, spec in enumerate(variable_specs, start=1):
            stage_no += 1
            stage_transition_started = time.time()
            tasks: list[tuple[dict[str, Any], Any]] = []
            for seed_idx, seed_row in enumerate(current_seed_rows, start=1):
                base_combo = dict(fixed_params)
                for item in variable_specs:
                    base_combo[item["name"]] = seed_row.get(item["name"], item.get("default", item["values"][0]))
                for value in spec["values"]:
                    combo = dict(base_combo)
                    combo[spec["name"]] = value
                    tasks.append(
                        (
                            combo,
                            {
                                "mode": "batch",
                                "cycle_no": cycle_no,
                                "round_no": stage_no,
                                "stage_name": spec["name"],
                                "param_index": param_idx,
                                "param_total": len(variable_specs),
                                "seed_index": seed_idx,
                                "seed_total": len(current_seed_rows),
                                "candidate_value": value,
                                "keep_count": keep_count,
                            },
                        )
                    )

            stage_task_count = len(tasks)
            if stage_task_count == 0:
                continue

            planned_total += stage_task_count
            stage_rows: list[dict[str, Any]] = []
            transition_elapsed_total += max(time.time() - stage_transition_started, 0.0)
            stage_compute_started = time.time()

            for update in _evaluate_task_sequence(
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
                done = int(update["done"])
                passed = int(update["passed"])
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
                    f"第 {cycle_no} 輪，第 {param_idx} 個參數 {spec['name']} 掃描中。",
                    f"前面已保留前 {keep_count} 組，這一輪只展開 {spec['name']}。",
                    f"本次共測 {stage_task_count:,} 組；其餘參數沿用目前保留值。",
                ]
                update["step_note"] = f"第 {cycle_no} 輪掃描 {spec['name']}"
                update["stage_name"] = spec["name"]
                update["round_no"] = stage_no
                update["cycle_no"] = cycle_no
                yield update

            compute_elapsed_total += max(time.time() - stage_compute_started, 0.0)
            if not stage_rows:
                continue

            stage_transition_started = time.time()
            stage_pass_rows = [row for row in stage_rows if _passes_hard_filters(row, hard_filters)]
            chosen_rows = stage_pass_rows if stage_pass_rows else stage_rows
            ranked = sorted(chosen_rows, key=lambda row: _candidate_sort_key(row, spec["name"]))
            current_seed_rows = [dict(row) for row in ranked[:keep_count]]
            transition_elapsed_total += max(time.time() - stage_transition_started, 0.0)

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
                "recent_trials_df": _build_recent_trials_df(recent_rows),
                "fail_reason_counts": dict(fail_counts),
                "summary_lines": [
                    f"第 {cycle_no} 輪參數 {spec['name']} 已掃描完成。",
                    f"目前保留前 {len(current_seed_rows)} 組，準備進入下一個參數。",
                ],
                "step_note": f"第 {cycle_no} 輪完成 {spec['name']}",
                "stage_name": spec["name"],
                "round_no": stage_no,
                "cycle_no": cycle_no,
            }

        cycle_transition_started = time.time()
        current_cycle_signature = tuple(_row_signature(row) for row in current_seed_rows)
        stop_reason = ""
        if cycle_no >= 2 and current_cycle_signature == prev_cycle_signature:
            stop_reason = f"完整再跑一輪後，保留前 {keep_count} 組參數都沒有變動，單參數輪巡停止。"
        prev_cycle_signature = current_cycle_signature
        transition_elapsed_total += max(time.time() - cycle_transition_started, 0.0)

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
            "recent_trials_df": _build_recent_trials_df(recent_rows),
            "fail_reason_counts": dict(fail_counts),
            "summary_lines": [
                f"第 {cycle_no} 輪 1~{len(variable_specs)} 參數已全部跑完。",
                stop_reason or f"下一輪會沿用目前保留前 {keep_count} 組繼續掃描。",
            ],
            "step_note": f"第 {cycle_no} 輪循環完成",
            "round_no": stage_no,
            "cycle_no": cycle_no,
            "stop_reason": stop_reason,
        }

        if stop_reason:
            break
