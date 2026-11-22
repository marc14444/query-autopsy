"""SQLAlchemy event bridge hooking before_cursor_execute / after_cursor_execute."""

from __future__ import annotations

import threading
import time
from typing import Any, Optional

from .writer import JsonlTraceWriter


def attach_sqlalchemy_tracing(
    engine: Any,
    writer: Optional[JsonlTraceWriter] = None,
    *,
    event_module: Any = None,
) -> JsonlTraceWriter:
    """Attach dev-only QueryAutopsy listeners to a SQLAlchemy Engine or AsyncEngine.

    No-ops cleanly when tracing is disabled (e.g. `APP_ENV=production`).
    Returns the active `JsonlTraceWriter` so HTTP middlewares can manage `request_scope`.
    """
    active_writer = writer or JsonlTraceWriter()
    if not active_writer.is_enabled():
        return active_writer

    resolved_event = event_module
    if resolved_event is None:
        from sqlalchemy import event as sa_event  # type: ignore[import-not-found]

        resolved_event = sa_event

    target = getattr(engine, "sync_engine", engine)
    timings_lock = threading.Lock()
    timings: dict[tuple[int, int, int], float] = {}

    def before_cursor_execute(
        conn: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        now = time.perf_counter()
        if context is not None:
            try:
                setattr(context, "_query_autopsy_started_at", now)
                return
            except Exception:
                pass
        key = (threading.get_ident(), id(conn), id(cursor))
        with timings_lock:
            timings[key] = now

    def after_cursor_execute(
        conn: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        finished = time.perf_counter()
        started: Optional[float] = None
        if context is not None:
            raw_start = getattr(context, "_query_autopsy_started_at", None)
            if isinstance(raw_start, float):
                started = raw_start
        if started is None:
            key = (threading.get_ident(), id(conn), id(cursor))
            with timings_lock:
                started = timings.pop(key, None)

        duration_ms = (finished - started) * 1000.0 if started is not None else None
        dialect = getattr(conn, "dialect", None) or getattr(target, "dialect", None)
        dialect_name = getattr(dialect, "name", None)

        active_writer.record(
            sql=statement,
            bindings=None if executemany else parameters,
            duration_ms=duration_ms,
            engine=dialect_name,
        )

    resolved_event.listen(target, "before_cursor_execute", before_cursor_execute)
    resolved_event.listen(target, "after_cursor_execute", after_cursor_execute)
    return active_writer
