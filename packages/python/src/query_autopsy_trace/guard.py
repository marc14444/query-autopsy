"""Environment and production safety guardrails for query-autopsy-trace."""

from __future__ import annotations

import os
from typing import Iterable, Mapping, Optional

DEFAULT_ALLOWED_ENVIRONMENTS: tuple[str, ...] = ("local", "development", "dev", "testing", "test")

_ENV_KEYS: tuple[str, ...] = (
    "QUERY_AUTOPSY_ENV",
    "DJANGO_ENV",
    "FLASK_ENV",
    "FASTAPI_ENV",
    "APP_ENV",
    "ENVIRONMENT",
    "ENV",
    "PYTHON_ENV",
)

_TRUE_VALUES: frozenset[str] = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES: frozenset[str] = frozenset({"0", "false", "no", "off"})


def _parse_bool_flag(raw: Optional[str]) -> Optional[bool]:
    if raw is None:
        return None
    normalized = raw.strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False
    return None


def resolve_environment_name(
    current_environment: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
) -> str:
    """Resolve the active runtime environment name, defaulting to development when unset."""
    if current_environment and current_environment.strip():
        return current_environment.strip().lower()

    source = os.environ if env is None else env
    for key in _ENV_KEYS:
        val = source.get(key)
        if val and val.strip():
            return val.strip().lower()

    return "development"


def should_enable_tracing(
    *,
    enabled: Optional[bool] = None,
    allow_production: bool = False,
    current_environment: Optional[str] = None,
    allowed_environments: Optional[Iterable[str]] = None,
    env: Optional[Mapping[str, str]] = None,
) -> bool:
    """Return True only when dev-only query tracing is explicitly permitted.

    Production environments (``production`` / ``prod``) are hard-blocked unless
    ``allow_production=True`` is explicitly provided.
    """
    if enabled is False:
        return False

    source = os.environ if env is None else env
    env_flag = _parse_bool_flag(source.get("QUERY_AUTOPSY_TRACE_ENABLED"))
    if env_flag is False and enabled is None:
        return False

    resolved_env = resolve_environment_name(current_environment, source)
    if resolved_env in {"production", "prod"}:
        return bool(allow_production)

    if enabled is True or env_flag is True:
        return True

    allowed_list = (
        DEFAULT_ALLOWED_ENVIRONMENTS if allowed_environments is None else tuple(allowed_environments)
    )
    allowed_set = {item.strip().lower() for item in allowed_list if item and item.strip()}
    return resolved_env in allowed_set
