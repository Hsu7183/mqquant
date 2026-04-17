from __future__ import annotations

from pathlib import Path

import pandas as pd
import streamlit as st

from .config import AUTO_REFRESH_SECONDS, default_paths, default_research_settings
from .services import (
    build_research_config,
    export_best_artifacts,
    list_sessions_view,
    load_session_dashboard,
    make_session_id,
    module_combo_rows,
    module_dimension_rows,
    param_learning_rows,
    start_research_session,
    stop_selected_session,
    strategy_rows,
    tail_worker_log,
    touch_session,
)


def _session_label(row: dict[str, object]) -> str:
    session_id = str(row.get("session_id") or "")
    status = str(row.get("status") or "")
    run_count = int(row.get("run_count") or 0)
    best_score = row.get("best_score")
    if best_score is None:
        return f"{session_id} | {status} | runs {run_count}"
    return f"{session_id} | {status} | runs {run_count} | best {float(best_score):.2f}"


def _status_name(status_payload: dict[str, object], session_summary: dict[str, object]) -> str:
    status = str(status_payload.get("status") or "").strip()
    if status:
        return status
    session_info = session_summary.get("session") if isinstance(session_summary, dict) else None
    if isinstance(session_info, dict):
        return str(session_info.get("status") or "UNKNOWN")
    return "UNKNOWN"


def _is_active_status(status_name: str) -> bool:
    return status_name.upper() in {"CREATED", "RUNNING", "STOPPING"}


def render_app() -> None:
    st.set_page_config(page_title="MQQuant 02", layout="wide")
    st.title("MQQuant 02 - 0313plus 模組化研究循環")
    st.caption("這支程式只做 modular research session，直接接 `src/research/*`，不碰 `gui_app.py`。")

    path_defaults = default_paths()
    settings_defaults = default_research_settings()

    with st.sidebar:
        st.subheader("資料路徑")
        source_root = st.text_input("原始專案根目錄", value=path_defaults.source_root)
        base_xs_path = st.text_input("母策略 XS", value=path_defaults.base_xs_path)
        minute_path = st.text_input("M1 路徑", value=path_defaults.minute_path)
        daily_path = st.text_input("D1 路徑", value=path_defaults.daily_path)
        param_preset_path = st.text_input("參數 preset", value=path_defaults.param_preset_path)
        export_root = st.text_input("匯出資料夾", value=path_defaults.export_root)

        st.subheader("研究設定")
        model = st.text_input("模型名稱", value=str(settings_defaults["model"]))
        batch_size = int(
            st.number_input("每輪候選數", value=int(settings_defaults["batch_size"]), min_value=1, step=1, format="%d")
        )
        top_n = int(
            st.number_input("保留前幾名", value=int(settings_defaults["top_n"]), min_value=1, step=1, format="%d")
        )
        capital = int(st.number_input("本金", value=int(settings_defaults["capital"]), step=100_000, format="%d"))
        slip_per_side = float(st.number_input("每邊滑價", value=float(settings_defaults["slip_per_side"]), step=0.5))
        min_trades = int(st.number_input("最少交易數", value=int(settings_defaults["min_trades"]), step=10, format="%d"))
        min_total_return = float(
            st.number_input("最低總報酬(%)", value=float(settings_defaults["min_total_return"]), step=1.0)
        )
        max_mdd_pct = float(st.number_input("最高 MDD(%)", value=float(settings_defaults["max_mdd_pct"]), step=1.0))
        max_rounds_raw = int(
            st.number_input("最多輪數(0 代表不限)", value=0, min_value=0, step=1, format="%d")
        )

        start_clicked = st.button("啟動新研究 Session", type="primary", use_container_width=True)

    path_errors = [path for path in (source_root, base_xs_path, minute_path, daily_path, param_preset_path) if not Path(path).exists()]
    if path_errors:
        st.error("以下路徑不存在，請先修正：\n" + "\n".join(path_errors))
        return

    if start_clicked:
        session_id = make_session_id()
        config = build_research_config(
            session_id=session_id,
            settings={
                "model": model,
                "batch_size": batch_size,
                "top_n": top_n,
                "capital": capital,
                "slip_per_side": slip_per_side,
                "min_trades": min_trades,
                "min_total_return": min_total_return,
                "max_mdd_pct": max_mdd_pct,
                "max_rounds": None if max_rounds_raw <= 0 else max_rounds_raw,
                "allow_param_mutation": True,
                "allow_template_mutation": True,
                "exploration_mode": "modular_loop",
            },
            paths={
                "base_xs_path": base_xs_path,
                "minute_path": minute_path,
                "daily_path": daily_path,
                "param_preset_path": param_preset_path,
            },
        )
        launch_info = start_research_session(config=config, source_root=source_root)
        st.session_state["mq02_selected_session"] = session_id
        st.success(f"已啟動 session：{session_id}，背景 PID：{launch_info['pid']}")

    sessions = list_sessions_view(limit=20)
    if not sessions:
        st.info("目前還沒有 research session。先用左側按鈕啟動一個新的。")
        return

    option_ids = [str(row["session_id"]) for row in sessions]
    selected_session_id = st.session_state.get("mq02_selected_session", option_ids[0])
    if selected_session_id not in option_ids:
        selected_session_id = option_ids[0]

    selected_session_id = st.selectbox(
        "選擇 Session",
        options=option_ids,
        index=option_ids.index(selected_session_id),
        format_func=lambda session_id: _session_label(next(row for row in sessions if str(row["session_id"]) == session_id)),
    )
    st.session_state["mq02_selected_session"] = selected_session_id

    dashboard = load_session_dashboard(selected_session_id)
    status_payload = dashboard["status"]
    session_summary = dashboard["summary"]
    status_name = _status_name(status_payload, session_summary)

    if _is_active_status(status_name):
        touch_session(selected_session_id)
        st.markdown(
            f"<meta http-equiv='refresh' content='{AUTO_REFRESH_SECONDS}'>",
            unsafe_allow_html=True,
        )
        st.caption(f"執行中 session 會每 {AUTO_REFRESH_SECONDS} 秒自動刷新一次。")

    action_cols = st.columns(3)
    if action_cols[0].button("停止這個 Session", use_container_width=True):
        stop_flag = stop_selected_session(selected_session_id)
        st.warning(f"已送出停止請求：{stop_flag}")
    if action_cols[1].button("匯出最佳指標版/交易版/TXT", use_container_width=True):
        export_result = export_best_artifacts(selected_session_id, export_root)
        if export_result:
            st.success(
                "已匯出到："
                f"{export_result['indicator_xs_path']} / "
                f"{export_result['trade_xs_path']} / "
                f"{export_result['txt_path']}"
            )
        else:
            st.error("找不到可匯出的最佳指標版 / 交易版 / TXT。")
    action_cols[2].write("")
    summary_cols = st.columns(5)
    summary_cols[0].metric("狀態", status_name)
    summary_cols[1].metric("目前輪數", int(status_payload.get("current_round") or 0))
    summary_cols[2].metric("已測數量", int(status_payload.get("tested_count") or 0))
    summary_cols[3].metric("最佳分數", f"{float(status_payload.get('best_score') or 0.0):.2f}")
    summary_cols[4].metric("最佳策略", str(status_payload.get("best_strategy_id") or "-"))

    current_action = str(status_payload.get("current_action") or "").strip()
    if current_action:
        st.info(current_action)

    best_run = session_summary.get("best_run") if isinstance(session_summary, dict) else None
    if isinstance(best_run, dict):
        st.subheader("目前最佳")
        best_cols = st.columns(4)
        best_cols[0].metric("總報酬", f"{float(best_run.get('total_return') or 0.0):.2f}%")
        best_cols[1].metric("MDD", f"{float(best_run.get('mdd_pct') or 0.0):.2f}%")
        best_cols[2].metric("交易數", int(best_run.get("n_trades") or 0))
        best_cols[3].metric("策略家族", str(best_run.get("strategy_group_label") or "-"))

    group_rows = dashboard["strategy_groups"]
    if group_rows:
        st.subheader("策略家族摘要")
        st.dataframe(pd.DataFrame(group_rows), use_container_width=True, hide_index=True)

    top_runs = strategy_rows(dashboard["top_runs"])
    if top_runs:
        st.subheader("Top Runs")
        st.dataframe(pd.DataFrame(top_runs), use_container_width=True, hide_index=True)

    recent_runs = strategy_rows(dashboard["recent_runs"])
    if recent_runs:
        st.subheader("最近 Runs")
        st.dataframe(pd.DataFrame(recent_runs), use_container_width=True, hide_index=True)

    module_rows = module_dimension_rows(dashboard["module_learning"])
    combo_rows = module_combo_rows(dashboard["module_learning"])
    param_rows = param_learning_rows(dashboard["param_learning"])

    if module_rows:
        st.subheader("模組學習摘要")
        st.dataframe(pd.DataFrame(module_rows), use_container_width=True, hide_index=True)
    if combo_rows:
        st.subheader("最佳模組組合")
        st.dataframe(pd.DataFrame(combo_rows), use_container_width=True, hide_index=True)
    if param_rows:
        st.subheader("參數學習區間")
        st.dataframe(pd.DataFrame(param_rows), use_container_width=True, hide_index=True)

    with st.expander("狀態 JSON", expanded=False):
        st.json(status_payload)

    stdout_text = tail_worker_log(selected_session_id, "worker_stdout.log")
    stderr_text = tail_worker_log(selected_session_id, "worker_stderr.log")

    with st.expander("Worker Stdout", expanded=False):
        if stdout_text:
            st.code(stdout_text, language="text")
        else:
            st.caption("目前還沒有 stdout。")

    with st.expander("Worker Stderr", expanded=False):
        if stderr_text:
            st.code(stderr_text, language="text")
        else:
            st.caption("目前還沒有 stderr。")
