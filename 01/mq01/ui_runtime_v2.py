from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pandas as pd
import streamlit as st

from .config import default_hard_filters, default_paths, default_runtime_settings
from .job_store import create_job_request, is_terminal_status, launch_job_process, read_job_state, request_stop
from .parameters import load_strategy_metadata
from .runtime_views import artifact_download_payload, render_action_bar
from .services import (
    build_current_best_snapshot,
    collect_system_snapshot,
    estimate_run_count,
    grid_run_block_reason,
    load_historical_best_snapshot,
    load_latest_artifact_snapshot,
    resolve_effective_workers,
)
from .ui import (
    MODE_OPTIONS,
    TYPE_VALUE_LABELS,
    _apply_mode_enabled_defaults,
    _best_export_signature,
    _cached_best_export_payload,
    _current_ui_specs,
    _format_duration,
    _number_input,
    _remember_param_label_map,
    _render_best_card,
    _render_compact_dataframe,
    _render_monitor_card,
    _render_narrative_box,
    _render_summary_card,
    _result_frame,
    _rows_frame,
    _saved_progress_state,
)


STATUS_LABELS = {
    "running": "執行中",
    "stopping": "停止中",
    "stopped": "已停止",
    "completed": "已完成",
    "error": "發生錯誤",
}


def _status_label(status: str) -> str:
    return STATUS_LABELS.get(str(status or "").strip(), "待命中")


def render_app() -> None:
    st.set_page_config(page_title="MQQuant 01", layout="wide")
    st.title("MQQuant 01 - 固定策略參數最佳化")
    st.caption("這支程式只做固定策略參數搜尋，背景計算與畫面刷新已拆開，不再把監控流程塞進同一支大檔。")

    path_defaults = default_paths()
    runtime_defaults = default_runtime_settings()
    hard_filter_defaults = default_hard_filters()

    with st.sidebar:
        st.subheader("資料路徑")
        xs_path = st.text_input("XS 路徑", value=path_defaults.xs_path)
        minute_path = st.text_input("M1 路徑", value=path_defaults.minute_path)
        daily_path = st.text_input("D1 路徑", value=path_defaults.daily_path)
        preset_path = st.text_input("參數範圍 preset", value=path_defaults.param_preset_path)

        st.subheader("搜尋模式")
        mode = st.selectbox(
            "模式",
            options=list(MODE_OPTIONS.keys()),
            format_func=lambda key: MODE_OPTIONS[key],
            index=0,
        )

        st.subheader("執行設定")
        capital = int(st.number_input("本金", value=int(runtime_defaults["capital"]), step=100_000, format="%d"))
        slip_per_side = float(
            st.number_input(
                "????",
                value=float(runtime_defaults["slip_per_side"]),
                min_value=0.0,
                step=0.1,
                format="%.2f",
            )
        )
        requested_workers = int(
            st.number_input("最大 workers", value=int(runtime_defaults["max_workers"]), min_value=1, step=1, format="%d")
        )
        cpu_limit_pct = int(
            st.number_input("CPU 使用率上限(%)", value=int(runtime_defaults["cpu_limit_pct"]), min_value=1, max_value=100, step=5, format="%d")
        )
        memory_limit_pct = int(
            st.number_input("記憶體使用率上限(%)", value=int(runtime_defaults["memory_limit_pct"]), min_value=1, max_value=100, step=5, format="%d")
        )
        effective_workers = resolve_effective_workers(requested_workers=requested_workers, cpu_limit_pct=cpu_limit_pct)
        effective_cpu_count = max(1, int((os.cpu_count() or 1) * cpu_limit_pct / 100))
        st.caption(
            f"CPU 上限 {cpu_limit_pct}% | 記憶體上限 {memory_limit_pct}% | 可用核心 {effective_cpu_count} | 實際工作程序 {effective_workers}"
        )
        top_n = int(st.number_input("保留前幾名", value=int(runtime_defaults["top_n"]), min_value=1, step=1, format="%d"))
        seed_keep_count = int(
            st.number_input("每個參數保留前幾名", value=int(runtime_defaults["seed_keep_count"]), min_value=1, step=1, format="%d")
        )
        st.caption("兩種模式都會逐參數掃描；差別只在預設勾選方式。")

        st.subheader("硬條件")
        min_trades = int(
            st.number_input("最少交易數", value=int(hard_filter_defaults["min_trades"]), min_value=0, step=10, format="%d")
        )
        min_total_return = float(st.number_input("最低總報酬(%)", value=float(hard_filter_defaults["min_total_return"]), step=1.0))
        max_mdd_pct = float(st.number_input("最高 MDD(%)", value=float(hard_filter_defaults["max_mdd_pct"]), step=1.0))

    path_errors = [path for path in (xs_path, minute_path, daily_path, preset_path) if not Path(path).exists()]
    if path_errors:
        st.error("以下路徑不存在，請先確認：\n" + "\n".join(path_errors))
        return

    try:
        script_name, params_meta, default_specs = load_strategy_metadata(xs_path, preset_path)
    except Exception as exc:
        st.exception(exc)
        return

    _remember_param_label_map(params_meta)
    _apply_mode_enabled_defaults(mode, default_specs)
    param_names = [str(item["name"]) for item in params_meta]
    historical_snapshot = load_historical_best_snapshot(param_names, slip_per_side=slip_per_side)

    config_placeholder = st.empty()
    config_hidden = bool(st.session_state.get("mq01_hide_config", False))
    if config_hidden:
        if st.button("顯示參數設定", width="content"):
            st.session_state["mq01_hide_config"] = False
            st.rerun()

    with config_placeholder.container():
        if not config_hidden:
            st.subheader("參數設定")
            if mode == "cycle":
                st.caption(f"目前來源策略：`{script_name}`。單參數循環預設全部不勾，請手動挑要掃描的參數。")
            else:
                st.caption(f"目前來源策略：`{script_name}`。智慧搜尋預設全部勾選，但跑法仍是逐參數循環。")

            header_cols = st.columns([1.0, 1.8, 1.4, 1.4, 1.2, 0.8])
            header_cols[0].markdown("**啟用**")
            header_cols[1].markdown("**參數**")
            header_cols[2].markdown("**起點**")
            header_cols[3].markdown("**終點**")
            header_cols[4].markdown("**步長**")
            header_cols[5].markdown("**型別**")

            for spec in default_specs:
                name = str(spec["name"])
                value_type = str(spec["type"])
                row_cols = st.columns([1.0, 1.8, 1.4, 1.4, 1.2, 0.8])
                row_cols[0].checkbox(
                    "啟用",
                    value=bool(spec["enabled"]),
                    key=f"mq01_enabled_{name}",
                    label_visibility="collapsed",
                )
                row_cols[1].markdown(f"**{name}**  \n{spec['label']}")
                with row_cols[2]:
                    _number_input(label="起點", key=f"mq01_start_{name}", value=spec["start"], value_type=value_type, step=spec["step"])
                with row_cols[3]:
                    _number_input(label="終點", key=f"mq01_stop_{name}", value=spec["stop"], value_type=value_type, step=spec["step"])
                with row_cols[4]:
                    _number_input(
                        label="步長",
                        key=f"mq01_step_{name}",
                        value=spec["step"],
                        value_type=value_type,
                        step=spec["step"] if value_type == "float" else 1,
                    )
                row_cols[5].write(TYPE_VALUE_LABELS.get(value_type, value_type))

    ui_specs = _current_ui_specs(default_specs)
    try:
        estimated_total = estimate_run_count(mode, ui_specs, params_meta, seed_keep_count=seed_keep_count)
    except Exception as exc:
        estimated_total = 0
        if not config_hidden:
            st.warning(f"參數設定目前無法估算組數：{exc}")
    else:
        if not config_hidden:
            st.info(f"每一輪至少會跑 **{estimated_total:,}** 組；會持續循環到各參數保留名單穩定為止。")

    run_block_reason = grid_run_block_reason(mode, estimated_total)
    if run_block_reason and not config_hidden:
        st.error(run_block_reason)

    runtime_settings = {
        "cpu_limit_pct": cpu_limit_pct,
        "memory_limit_pct": memory_limit_pct,
        "capital": capital,
        "slip_per_side": slip_per_side,
        "requested_workers": requested_workers,
        "effective_workers": effective_workers,
        "max_workers": effective_workers,
        "top_n": top_n,
        "seed_keep_count": seed_keep_count,
    }
    hard_filters = {
        "min_trades": min_trades,
        "min_total_return": min_total_return,
        "max_mdd_pct": max_mdd_pct,
    }
    package_root = Path(__file__).resolve().parent.parent

    def _build_live_view_state() -> dict[str, Any]:
        saved_progress = _saved_progress_state()
        saved_top_df = _result_frame(st.session_state.get("mq01_last_top_df"))
        saved_recent_df = _result_frame(st.session_state.get("mq01_last_recent_df"))
        saved_fail_rows = list(st.session_state.get("mq01_last_fail_rows", []))

        active_job_id = str(st.session_state.get("mq01_active_job_id") or "").strip()
        active_job_state = read_job_state(active_job_id) if active_job_id else {}
        active_status = str(active_job_state.get("status") or saved_progress.get("status") or "")
        running_now = bool(active_job_id) and not is_terminal_status(active_status)

        if active_job_state.get("artifact"):
            st.session_state["mq01_last_artifacts"] = dict(active_job_state.get("artifact") or {})

        current_top_df = _rows_frame(active_job_state.get("top_rows")) if active_job_state else saved_top_df
        current_recent_df = _rows_frame(active_job_state.get("recent_rows")) if active_job_state else saved_recent_df
        current_fail_rows = list(active_job_state.get("fail_rows") or saved_fail_rows)

        current_snapshot = active_job_state.get("current_snapshot")
        if not isinstance(current_snapshot, dict):
            current_snapshot = dict(saved_progress.get("current_snapshot") or {})
        if not current_snapshot and not current_top_df.empty:
            current_snapshot = build_current_best_snapshot(current_top_df, param_names, slip_per_side=slip_per_side)

        if not current_top_df.empty:
            st.session_state["mq01_last_top_df"] = current_top_df.copy()
        if not current_recent_df.empty:
            st.session_state["mq01_last_recent_df"] = current_recent_df.copy()
        st.session_state["mq01_last_fail_rows"] = list(current_fail_rows)

        done = int(active_job_state.get("done") or saved_progress.get("done") or 0)
        total = max(int(active_job_state.get("total") or saved_progress.get("total") or estimated_total or 0), 1)
        passed = int(active_job_state.get("passed") or saved_progress.get("passed") or 0)
        step_note = str(active_job_state.get("step_note") or saved_progress.get("step_note") or "按下「開始最佳化」後，這裡會即時更新目前步驟。")
        summary_lines = [str(line) for line in (active_job_state.get("summary_lines") or saved_progress.get("summary_lines") or [])]
        narrative_lines = [str(line) for line in (active_job_state.get("narrative_lines") or saved_progress.get("narrative_lines") or [])]
        elapsed_seconds = float(active_job_state.get("elapsed_seconds") or saved_progress.get("elapsed_seconds") or 0.0)
        compute_elapsed_seconds = float(
            active_job_state.get("compute_elapsed_seconds") or saved_progress.get("compute_elapsed_seconds") or 0.0
        )
        transition_elapsed_seconds = float(
            active_job_state.get("transition_elapsed_seconds") or saved_progress.get("transition_elapsed_seconds") or 0.0
        )
        eta_seconds = float(active_job_state.get("eta_seconds") or saved_progress.get("eta_seconds") or 0.0)

        artifact_snapshot = st.session_state.get("mq01_last_artifacts")
        active_artifact = active_job_state.get("artifact") if isinstance(active_job_state.get("artifact"), dict) else {}
        export_payload = artifact_download_payload(active_artifact)

        live_signature = _best_export_signature(top_df=current_top_df, params_meta=params_meta, slip_per_side=slip_per_side)
        live_export_cache = st.session_state.get("mq01_live_export_cache")
        cache_signature = str(live_export_cache.get("signature") or "") if isinstance(live_export_cache, dict) else ""
        if not running_now and live_signature:
            export_payload = _cached_best_export_payload(
                top_df=current_top_df,
                params_meta=params_meta,
                xs_path=xs_path,
                minute_path=minute_path,
                daily_path=daily_path,
                script_name=script_name,
                slip_per_side=slip_per_side,
            ) or export_payload
        elif live_signature and cache_signature == live_signature and isinstance(live_export_cache, dict):
            export_payload = live_export_cache

        if not export_payload:
            if running_now:
                artifact_snapshot = {}
            elif not isinstance(artifact_snapshot, dict) or not artifact_snapshot:
                artifact_snapshot = load_latest_artifact_snapshot()
            if artifact_snapshot:
                export_payload = artifact_download_payload(artifact_snapshot)

        return {
            "active_job_id": active_job_id,
            "active_status": active_status,
            "active_job_state": active_job_state,
            "running_now": running_now,
            "current_top_df": current_top_df,
            "current_recent_df": current_recent_df,
            "current_fail_rows": current_fail_rows,
            "current_snapshot": current_snapshot,
            "done": done,
            "total": total,
            "passed": passed,
            "step_note": step_note,
            "summary_lines": summary_lines,
            "narrative_lines": narrative_lines,
            "elapsed_seconds": elapsed_seconds,
            "compute_elapsed_seconds": compute_elapsed_seconds,
            "transition_elapsed_seconds": transition_elapsed_seconds,
            "eta_seconds": eta_seconds,
            "export_payload": export_payload,
        }

    def _handle_action_clicks(view: dict[str, Any]) -> None:
        run_clicked, stop_clicked = render_action_bar(
            st.container(),
            run_disabled=bool(run_block_reason) or view["running_now"],
            stop_enabled=view["running_now"],
            export_payload=view["export_payload"],
            key_suffix=view["active_job_id"] or "idle",
        )

        if view["running_now"] and not view["export_payload"]:
            st.caption("執行中暫停準備 XS / TXT，避免畫面卡頓；停止或完成後會恢復下載。")

        if run_clicked:
            job_id = create_job_request(
                {
                    "mode": mode,
                    "mode_label": MODE_OPTIONS[mode],
                    "xs_path": xs_path,
                    "minute_path": minute_path,
                    "daily_path": daily_path,
                    "script_name": script_name,
                    "ui_param_specs": ui_specs,
                    "params_meta": params_meta,
                    "runtime_settings": runtime_settings,
                    "hard_filters": hard_filters,
                    "estimated_total": estimated_total,
                }
            )
            launch_job_process(job_id, package_root=str(package_root))
            st.session_state["mq01_active_job_id"] = job_id
            st.session_state["mq01_hide_config"] = True
            st.session_state["mq01_live_export_cache"] = {}
            st.rerun()

        if stop_clicked and view["active_job_id"]:
            request_stop(view["active_job_id"])
            st.rerun()

    def _render_status_notices(view: dict[str, Any]) -> None:
        status = str(view["active_status"] or "")
        if status == "stopping":
            st.warning("停止要求已送出，會在下一個安全檢查點結束並保留目前最佳結果。")
        elif status == "stopped":
            st.success("已停止並保留目前最佳結果。")
        elif status == "completed":
            st.success("最佳化已完成。")
        elif status == "error":
            st.error(str(view["active_job_state"].get("error") or "背景工作發生錯誤。"))

        if view["summary_lines"] and status in {"stopped", "completed", "error"}:
            st.info("\n".join(view["summary_lines"]))

    def _render_progress_overview(view: dict[str, Any]) -> None:
        if not (view["running_now"] or view["done"] > 0):
            return
        st.progress(min(view["done"] / view["total"], 1.0), text=f"已完成 {view['done']:,} / {view['total']:,}")
        status_cols = st.columns(6)
        status_cols[0].metric("已完成", f"{view['done']:,}")
        status_cols[1].metric("通過硬條件", f"{view['passed']:,}")
        status_cols[2].metric("總耗時", _format_duration(view["elapsed_seconds"]))
        status_cols[3].metric("計算耗時", _format_duration(view["compute_elapsed_seconds"]))
        status_cols[4].metric("切換耗時", _format_duration(view["transition_elapsed_seconds"]))
        status_cols[5].metric("剩餘組數", f"{max(view['total'] - view['done'], 0):,}")
        st.caption(f"狀態：{_status_label(view['active_status'])} | 預估剩餘：{_format_duration(view['eta_seconds'])}")
        st.caption(f"目前工作：{view['step_note']}")

    def _render_dashboard(view: dict[str, Any]) -> None:
        dashboard_cols = st.columns(4)
        _render_monitor_card(
            dashboard_cols[0],
            system_snapshot=collect_system_snapshot(
                max_workers=effective_workers,
                requested_workers=requested_workers,
                cpu_limit_pct=cpu_limit_pct,
                memory_limit_pct=memory_limit_pct,
            ),
            done=view["done"],
            total=view["total"],
            passed=view["passed"],
        )
        _render_best_card(
            dashboard_cols[1],
            title="歷史最佳化",
            snapshot=historical_snapshot,
            empty_text="目前還沒有歷史最佳化資料。",
        )
        _render_best_card(
            dashboard_cols[2],
            title="目前最佳化",
            snapshot=view["current_snapshot"],
            empty_text="尚未有通過硬條件的目前最佳結果。",
        )
        _render_summary_card(
            dashboard_cols[3],
            mode_label=MODE_OPTIONS[mode],
            estimated_total=estimated_total,
            step_note=view["step_note"],
            summary_lines=view["summary_lines"],
            done=view["done"],
            total=view["total"],
            passed=view["passed"],
            fail_rows=view["current_fail_rows"],
        )

    def _render_tables(view: dict[str, Any]) -> None:
        if not view["current_top_df"].empty:
            st.subheader("目前 Top 結果")
            _render_compact_dataframe(view["current_top_df"], height=360)
        if not view["current_recent_df"].empty:
            st.subheader("最近試算")
            _render_compact_dataframe(view["current_recent_df"], height=360)
        if view["current_fail_rows"]:
            st.subheader("失敗原因統計")
            _render_compact_dataframe(pd.DataFrame(view["current_fail_rows"]), height=220)

    initial_view = _build_live_view_state()

    if initial_view["running_now"]:

        @st.fragment(run_every=4)
        def _render_live_header() -> None:
            view = _build_live_view_state()
            if not view["running_now"]:
                st.rerun()
                return
            _handle_action_clicks(view)
            _render_progress_overview(view)
            _render_dashboard(view)
            _render_narrative_box(st.container(), view["narrative_lines"])

        @st.fragment(run_every=7)
        def _render_live_tables() -> None:
            view = _build_live_view_state()
            if not view["running_now"]:
                st.rerun()
                return
            _render_tables(view)

        _render_live_header()
        _render_live_tables()
        return

    _handle_action_clicks(initial_view)
    _render_status_notices(initial_view)
    _render_progress_overview(initial_view)
    _render_dashboard(initial_view)
    _render_narrative_box(st.container(), initial_view["narrative_lines"])
    _render_tables(initial_view)
