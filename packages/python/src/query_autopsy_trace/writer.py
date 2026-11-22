"""Thread-safe, PII-redacting JSONL trace writer matching .query-autopsy/traces.jsonl."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import datetime as _dt
import json
import math
import os
import re
import secrets
import threading
from typing import Any, Iterable, Iterator, Mapping, Optional

from .caller import locate_app_caller
from .guard import should_enable_tracing
from .sanitizer import sanitize_bindings, scrub_sql_literals, should_redact_bindings

DEFAULT_IGNORE_PATTERNS: tuple[str, ...] = (
    "django_migrations",
    "alembic_version",
    "pg_stat_",
    "information_schema.",
)

_REQUEST_ID_SANITIZE_RE = re.compile(r"[^a-zA-Z0-9._:-]")


def normalize_engine(raw: Optional[str]) -> Optional[str]:
    """Normalize framework/dialect names (e.g. 'postgresql+psycopg2') to QueryAutopsy engines."""
    if not raw or not isinstance(raw, str):
        return None
    base = raw.strip().lower().split("+", 1)[0]
    if base in {"pg", "postgres", "postgresql", "pgsql", "psycopg", "psycopg2", "asyncpg"}:
        return "postgresql"
    if base in {"mysql", "mysql2", "mariadb", "pymysql", "mysqldb"}:
        return "mysql"
    if base in {"sqlite", "sqlite3", "aiosqlite"}:
        return "sqlite"
    return None


def _sanitize_request_id(raw: Optional[str]) -> Optional[str]:
    if not raw or not isinstance(raw, str):
        return None
    cleaned = _REQUEST_ID_SANITIZE_RE.sub("", raw.strip())[:64]
    return cleaned if cleaned else None


def _assert_not_symlink(target: str) -> None:
    if os.path.islink(target):
        raise PermissionError(
            f"Refusing to write QueryAutopsy trace to symlink path: {target}"
        )


def _utc_iso_timestamp() -> str:
    now = _dt.datetime.now(_dt.timezone.utc)
    return now.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class JsonlTraceWriter:
    """Buffers, sanitizes, and writes dev-only `.query-autopsy/traces.jsonl` records."""

    def __init__(
        self,
        *,
        enabled: Optional[bool] = None,
        allow_production: bool = False,
        current_environment: Optional[str] = None,
        allowed_environments: Optional[Iterable[str]] = None,
        workspace_root: Optional[str] = None,
        trace_path: Optional[str] = None,
        default_engine: str = "postgresql",
        redact_bindings: Optional[bool] = None,
        max_trace_bytes: int = 5 * 1024 * 1024,
        max_buffer_entries: int = 2000,
        ignore_patterns: Optional[Iterable[str]] = None,
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        self._enabled = should_enable_tracing(
            enabled=enabled,
            allow_production=allow_production,
            current_environment=current_environment,
            allowed_environments=allowed_environments,
            env=env,
        )
        self._workspace_root = os.path.abspath(workspace_root or os.getcwd())
        default_trace = os.path.join(self._workspace_root, ".query-autopsy", "traces.jsonl")
        self._trace_path = os.path.abspath(trace_path or default_trace)
        self._default_engine = normalize_engine(default_engine) or "postgresql"
        self._redact_bindings = should_redact_bindings(redact_bindings, env=env)
        self._max_trace_bytes = max(4096, int(max_trace_bytes))
        self._max_buffer_entries = max(1, int(max_buffer_entries))

        raw_patterns = (
            DEFAULT_IGNORE_PATTERNS if ignore_patterns is None else tuple(ignore_patterns)
        )
        self._ignore_needles = tuple(
            p.replace("%", "").strip().lower()
            for p in raw_patterns
            if isinstance(p, str) and p.replace("%", "").strip()
        )

        self._request_var: ContextVar[Optional[str]] = ContextVar(
            f"query_autopsy_req_{id(self)}", default=None
        )
        self._lock = threading.Lock()
        self._buffer: list[dict[str, Any]] = []

    def is_enabled(self) -> bool:
        return self._enabled

    def get_trace_path(self) -> str:
        return self._trace_path

    def get_buffered_count(self) -> int:
        with self._lock:
            return len(self._buffer)

    @contextmanager
    def request_scope(
        self,
        request_id: Optional[str] = None,
        *,
        auto_flush: bool = True,
    ) -> Iterator[str]:
        """Isolate all queries recorded in this context/thread under a scoped requestId."""
        safe_id = _sanitize_request_id(request_id) or f"req-{secrets.token_hex(8)}"
        token = self._request_var.set(safe_id)
        try:
            yield safe_id
        finally:
            self._request_var.reset(token)
            if auto_flush and self._enabled:
                self.flush()

    def record(
        self,
        *,
        sql: str,
        bindings: Any = None,
        duration_ms: Optional[float] = None,
        engine: Optional[str] = None,
        request_id: Optional[str] = None,
        file: Optional[str] = None,
        line: Optional[int] = None,
    ) -> None:
        if not self._enabled:
            return
        if not isinstance(sql, str):
            return

        trimmed_sql = sql.strip()
        if not trimmed_sql or self._should_ignore_sql(trimmed_sql):
            return

        resolved_engine = normalize_engine(engine) or self._default_engine
        safe_sql = scrub_sql_literals(trimmed_sql) if self._redact_bindings else trimmed_sql
        safe_bindings = sanitize_bindings(bindings, redact=self._redact_bindings)
        resolved_req_id = (
            _sanitize_request_id(request_id)
            or self._request_var.get()
            or "req-default"
        )

        caller_file = file
        caller_line = line
        if caller_file is None:
            caller = locate_app_caller(self._workspace_root)
            if caller is not None:
                caller_file = str(caller["file"])
                raw_line = caller.get("line")
                if isinstance(raw_line, int):
                    caller_line = raw_line

        entry: dict[str, Any] = {
            "timestamp": _utc_iso_timestamp(),
            "engine": resolved_engine,
            "sql": safe_sql,
            "bindings": safe_bindings,
            "requestId": resolved_req_id,
        }

        if duration_ms is not None and isinstance(duration_ms, (int, float)) and math.isfinite(duration_ms):
            entry["durationMs"] = round(max(0.0, float(duration_ms)), 3)
        if caller_file is not None:
            entry["file"] = caller_file
        if caller_line is not None:
            entry["line"] = max(1, int(caller_line))

        with self._lock:
            if len(self._buffer) >= self._max_buffer_entries:
                return
            self._buffer.append(entry)

    def flush(self) -> int:
        """Write buffered entries atomically to disk with symlink, .gitignore, and rotation guards."""
        with self._lock:
            if not self._buffer:
                return 0
            pending = self._buffer
            self._buffer = []

            trace_dir = os.path.dirname(self._trace_path)
            _assert_not_symlink(trace_dir)
            os.makedirs(trace_dir, mode=0o750, exist_ok=True)

            gitignore_path = os.path.join(trace_dir, ".gitignore")
            if not os.path.lexists(gitignore_path):
                with open(gitignore_path, "w", encoding="utf-8") as gi_file:
                    gi_file.write("*.jsonl\n*.ndjson\n")

            _assert_not_symlink(self._trace_path)

            if os.path.exists(self._trace_path):
                if os.path.getsize(self._trace_path) >= self._max_trace_bytes:
                    backup_path = f"{self._trace_path}.1"
                    if not os.path.islink(backup_path):
                        os.replace(self._trace_path, backup_path)

            payload = "".join(
                f"{json.dumps(entry, separators=(',', ':'))}\n" for entry in pending
            )
            with open(self._trace_path, "a", encoding="utf-8") as handle:
                handle.write(payload)

            return len(pending)

    def _should_ignore_sql(self, sql: str) -> bool:
        if not self._ignore_needles:
            return False
        lower = sql.lower()
        return any(needle in lower for needle in self._ignore_needles)
