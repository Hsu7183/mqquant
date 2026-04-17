from __future__ import annotations

from dataclasses import dataclass

from .bootstrap import resolve_source_root


DEFAULT_MODEL = "local-modular-loop"
AUTO_REFRESH_SECONDS = 15


@dataclass(slots=True)
class ResearchPaths:
    source_root: str
    base_xs_path: str
    minute_path: str
    daily_path: str
    param_preset_path: str
    export_root: str


def default_paths() -> ResearchPaths:
    source_root = resolve_source_root()
    return ResearchPaths(
        source_root=str(source_root),
        base_xs_path=str(source_root / "strategy" / "0313plus.xs"),
        minute_path=str(source_root / "data" / "m1"),
        daily_path=str(source_root / "data" / "d1"),
        param_preset_path=str(source_root / "param_presets" / "0313plus.txt"),
        export_root=str(source_root / "run_history" / "mqquant_exports"),
    )


def default_research_settings() -> dict[str, int | float | bool | None | str]:
    return {
        "model": DEFAULT_MODEL,
        "batch_size": 20,
        "top_n": 10,
        "capital": 1_000_000,
        "slip_per_side": 2.0,
        "min_trades": 300,
        "min_total_return": 5.0,
        "max_mdd_pct": 40.0,
        "max_rounds": None,
        "allow_param_mutation": True,
        "allow_template_mutation": True,
        "exploration_mode": "modular_loop",
    }
