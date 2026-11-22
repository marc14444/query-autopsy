"""Lightweight workspace-relative caller stack frame resolver."""

from __future__ import annotations

import os
import sys
from typing import Optional

_SKIP_DIR_FRAGMENTS: tuple[str, ...] = (
    f"{os.sep}query_autopsy_trace{os.sep}",
    f"{os.sep}site-packages{os.sep}",
    f"{os.sep}dist-packages{os.sep}",
    f"{os.sep}django{os.sep}",
    f"{os.sep}sqlalchemy{os.sep}",
    f"{os.sep}unittest{os.sep}",
    f"{os.sep}importlib",
)


def _to_posix_relative(abs_path: str, workspace_root: str) -> str:
    try:
        rel = os.path.relpath(abs_path, workspace_root)
    except ValueError:
        return abs_path.replace("\\", "/")
    if not rel.startswith("..") and not os.path.isabs(rel):
        return rel.replace("\\", "/")
    return abs_path.replace("\\", "/")


def locate_app_caller(
    workspace_root: str,
    *,
    max_depth: int = 32,
) -> Optional[dict[str, object]]:
    """Walk the current call stack and return the first user/workspace frame."""
    try:
        frame = sys._getframe(1)
    except (AttributeError, ValueError):
        return None

    real_workspace = os.path.realpath(workspace_root)
    fallback: Optional[dict[str, object]] = None
    depth = 0

    while frame is not None and depth < max_depth:
        depth += 1
        code = frame.f_code
        filename = code.co_filename or ""
        lineno = frame.f_lineno
        frame = frame.f_back

        if not filename or filename.startswith("<"):
            continue

        norm = os.path.abspath(filename)
        if any(fragment in norm for fragment in _SKIP_DIR_FRAGMENTS):
            continue

        real_file = os.path.realpath(norm)
        in_workspace = (
            real_file == real_workspace
            or real_file.startswith(real_workspace + os.sep)
        )
        candidate: dict[str, object] = {
            "file": _to_posix_relative(real_file, real_workspace),
            "line": int(lineno),
        }
        if code.co_name and code.co_name != "<module>":
            candidate["function"] = code.co_name

        if in_workspace:
            return candidate
        if fallback is None:
            fallback = candidate

    return fallback
