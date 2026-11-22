"""SQL string literal scrubber and binding sanitizer mirroring @query-autopsy/core."""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import re
from typing import Any, Mapping, Optional, Sequence

MAX_BINDING_STR_LEN = 256
MAX_BINDING_COUNT = 256

# Preserve dollar-quoted tags ($tag$...$tag$) only outside strings if needed, scrub single-quoted SQL literals.
_SINGLE_QUOTED_SQL_RE = re.compile(r"'(?:''|\\.|[^'\\])*'")
_TRUE_VALUES: frozenset[str] = frozenset({"1", "true", "yes", "on"})


def should_redact_bindings(
    redact_bindings: Optional[bool] = None,
    env: Optional[Mapping[str, str]] = None,
) -> bool:
    """Redact bound parameter values by default unless QUERY_AUTOPSY_REDACT_BINDINGS=false."""
    if redact_bindings is not None:
        return bool(redact_bindings)
    source = os.environ if env is None else env
    raw = source.get("QUERY_AUTOPSY_REDACT_BINDINGS")
    if raw is None:
        return True
    normalized = raw.strip().lower()
    if normalized in {"0", "false", "no", "off"}:
        return False
    return True


def scrub_sql_literals(sql: str) -> str:
    """Replace inline single-quoted SQL literals with '[REDACTED]' without parsing ASTs."""
    if not sql:
        return ""
    return _SINGLE_QUOTED_SQL_RE.sub("'[REDACTED]'", sql)


def _normalize_scalar(value: Any) -> Any:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
        return value.isoformat()
    if isinstance(value, bytes):
        return f"<bytes:{len(value)}>"
    if isinstance(value, str):
        return value if len(value) <= MAX_BINDING_STR_LEN else f"{value[:MAX_BINDING_STR_LEN]}..."
    try:
        encoded = json.dumps(value, default=str)
        return encoded if len(encoded) <= MAX_BINDING_STR_LEN else f"{encoded[:MAX_BINDING_STR_LEN]}..."
    except (TypeError, ValueError):
        rendered = str(value)
        return rendered if len(rendered) <= MAX_BINDING_STR_LEN else f"{rendered[:MAX_BINDING_STR_LEN]}..."


def sanitize_bindings(bindings: Any, redact: bool = True) -> list[Any]:
    """Return [] when redacted, or a bounded list of JSON-safe scalar representations."""
    if redact or not bindings:
        return []

    if isinstance(bindings, Mapping):
        items: Sequence[Any] = list(bindings.values())
    elif isinstance(bindings, (list, tuple)):
        items = bindings
    else:
        items = [bindings]

    return [_normalize_scalar(item) for item in items[:MAX_BINDING_COUNT]]
