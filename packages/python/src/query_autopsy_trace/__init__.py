"""Zero-dependency dev trace bridge emitting `.query-autopsy/traces.jsonl` for Python."""

from .caller import locate_app_caller
from .django_bridge import QueryAutopsyDjangoMiddleware
from .guard import resolve_environment_name, should_enable_tracing
from .sanitizer import sanitize_bindings, scrub_sql_literals, should_redact_bindings
from .sqlalchemy_bridge import attach_sqlalchemy_tracing
from .writer import JsonlTraceWriter, normalize_engine

__all__ = [
    "JsonlTraceWriter",
    "QueryAutopsyDjangoMiddleware",
    "attach_sqlalchemy_tracing",
    "locate_app_caller",
    "normalize_engine",
    "resolve_environment_name",
    "sanitize_bindings",
    "scrub_sql_literals",
    "should_enable_tracing",
    "should_redact_bindings",
]

__version__ = "1.8.0"
