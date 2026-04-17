from __future__ import annotations

from mq02.bootstrap import bootstrap_source_root

bootstrap_source_root()

from mq02.ui import render_app


render_app()
