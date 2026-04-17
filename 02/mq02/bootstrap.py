from __future__ import annotations

import os
import sys
from pathlib import Path


DEFAULT_SOURCE_ROOT = Path(r"C:\xs_optimizer_v1")


def resolve_source_root() -> Path:
    override = os.getenv("MQQUANT_SOURCE_ROOT", "").strip()
    if override:
        return Path(override).expanduser()
    return DEFAULT_SOURCE_ROOT


def bootstrap_source_root() -> Path:
    source_root = resolve_source_root()
    source_root_str = str(source_root)
    if source_root_str not in sys.path:
        sys.path.insert(0, source_root_str)
    return source_root
