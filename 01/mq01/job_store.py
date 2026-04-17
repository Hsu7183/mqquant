from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from .bootstrap import resolve_source_root


def jobs_root() -> Path:
    root = resolve_source_root() / "run_history" / "mq01_jobs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def job_dir(job_id: str) -> Path:
    return jobs_root() / str(job_id)


def request_path(job_id: str) -> Path:
    return job_dir(job_id) / "request.json"


def state_path(job_id: str) -> Path:
    return job_dir(job_id) / "state.json"


def stop_flag_path(job_id: str) -> Path:
    return job_dir(job_id) / "stop.flag"


def _now_text() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def create_job_request(payload: dict[str, Any]) -> str:
    job_id = f"job_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
    job_directory = job_dir(job_id)
    job_directory.mkdir(parents=True, exist_ok=True)
    _write_json(request_path(job_id), payload)
    _write_json(
        state_path(job_id),
        {
            "job_id": job_id,
            "status": "queued",
            "created_at": _now_text(),
            "updated_at": _now_text(),
            "done": 0,
            "total": 0,
            "passed": 0,
            "step_note": "排隊中",
            "summary_lines": ["已建立背景任務，等待啟動。"],
            "narrative_lines": ["背景任務已建立，準備啟動。"],
            "top_rows": [],
            "recent_rows": [],
            "fail_rows": [],
            "elapsed_seconds": 0.0,
            "compute_elapsed_seconds": 0.0,
            "transition_elapsed_seconds": 0.0,
            "eta_seconds": 0.0,
            "artifact": {},
        },
    )
    return job_id


def read_job_request(job_id: str) -> dict[str, Any]:
    path = request_path(job_id)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def read_job_state(job_id: str) -> dict[str, Any]:
    path = state_path(job_id)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def write_job_state(job_id: str, payload: dict[str, Any]) -> None:
    existing = read_job_state(job_id)
    merged = dict(existing)
    merged.update(payload)
    merged["job_id"] = job_id
    merged["updated_at"] = _now_text()
    _write_json(state_path(job_id), merged)


def request_stop(job_id: str) -> None:
    stop_flag_path(job_id).write_text("stop\n", encoding="utf-8")
    write_job_state(
        job_id,
        {
            "status": "stopping",
            "step_note": "停止請求已送出",
            "summary_lines": ["背景任務收到停止請求，會在安全檢查點停止並存檔。"],
        },
    )


def stop_requested(job_id: str) -> bool:
    return stop_flag_path(job_id).exists()


def is_terminal_status(status: str) -> bool:
    return str(status) in {"completed", "stopped", "error"}


def launch_job_process(job_id: str, *, package_root: str) -> int:
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    stdout_path = job_dir(job_id) / "worker.stdout.log"
    stderr_path = job_dir(job_id) / "worker.stderr.log"
    stdout_handle = stdout_path.open("w", encoding="utf-8")
    stderr_handle = stderr_path.open("w", encoding="utf-8")
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    process = subprocess.Popen(
        [sys.executable, "-m", "mq01.background_worker", job_id],
        cwd=str(package_root),
        stdout=stdout_handle,
        stderr=stderr_handle,
        creationflags=creationflags,
        env=env,
    )
    write_job_state(
        job_id,
        {
            "status": "starting",
            "pid": int(process.pid),
            "stdout_log": str(stdout_path),
            "stderr_log": str(stderr_path),
        },
    )
    return int(process.pid)
