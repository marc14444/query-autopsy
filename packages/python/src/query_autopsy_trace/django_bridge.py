"""Django middleware wrapping connection.execute_wrapper inside dev-only request scopes."""

from __future__ import annotations

from contextlib import ExitStack
import time
from typing import Any, Callable, Iterable, Optional

from .writer import JsonlTraceWriter


def _extract_request_id(request: Any) -> Optional[str]:
    headers = getattr(request, "headers", None)
    if headers is not None and hasattr(headers, "get"):
        req_id = headers.get("X-Request-Id") or headers.get("x-request-id")
        if isinstance(req_id, str) and req_id.strip():
            return req_id

    meta = getattr(request, "META", None)
    if isinstance(meta, dict):
        req_id = meta.get("HTTP_X_REQUEST_ID")
        if isinstance(req_id, str) and req_id.strip():
            return req_id

    return None


class QueryAutopsyDjangoMiddleware:
    """Dev-only Django middleware capturing SQL via `connection.execute_wrapper`.

    Add to `settings.MIDDLEWARE` in local/testing environments. When tracing is disabled
    (e.g. `DJANGO_ENV=production` / `APP_ENV=production`), `__call__` forwards directly
    to `get_response(request)` with zero database wrappers or trace overhead.
    """

    def __init__(
        self,
        get_response: Callable[[Any], Any],
        *,
        writer: Optional[JsonlTraceWriter] = None,
        connections_provider: Optional[Callable[[], Iterable[Any]]] = None,
    ) -> None:
        self.get_response = get_response
        self.writer = writer or JsonlTraceWriter()
        self._connections_provider = connections_provider

    def _resolve_connections(self) -> Iterable[Any]:
        if self._connections_provider is not None:
            return self._connections_provider()
        try:
            from django.db import connections  # type: ignore[import-not-found]

            return connections.all()
        except Exception:
            return ()

    def _build_execute_wrapper(
        self,
        default_vendor: Optional[str],
    ) -> Callable[[Any, str, Any, bool, dict[str, Any]], Any]:
        writer = self.writer

        def wrapper(
            execute: Callable[[str, Any, bool, dict[str, Any]], Any],
            sql: str,
            params: Any,
            many: bool,
            context: dict[str, Any],
        ) -> Any:
            started = time.perf_counter()
            try:
                return execute(sql, params, many, context)
            finally:
                elapsed_ms = (time.perf_counter() - started) * 1000.0
                conn_obj = context.get("connection") if isinstance(context, dict) else None
                vendor = getattr(conn_obj, "vendor", default_vendor)
                writer.record(
                    sql=sql,
                    bindings=None if many else params,
                    duration_ms=elapsed_ms,
                    engine=vendor,
                )

        return wrapper

    def __call__(self, request: Any) -> Any:
        if not self.writer.is_enabled():
            return self.get_response(request)

        req_id = _extract_request_id(request)
        with self.writer.request_scope(req_id, auto_flush=True):
            with ExitStack() as stack:
                for conn in self._resolve_connections():
                    execute_wrapper = getattr(conn, "execute_wrapper", None)
                    if callable(execute_wrapper):
                        vendor = getattr(conn, "vendor", None)
                        stack.enter_context(
                            execute_wrapper(self._build_execute_wrapper(vendor))
                        )
                return self.get_response(request)
