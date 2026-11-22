# `query-autopsy-trace` (Python)

Zero-dependency, dev-only trace bridge emitting `.query-autopsy/traces.jsonl` for **QueryAutopsy** (`N+1` burst detection, slow queries, and 1-click VS Code `file:line` jump + `EXPLAIN`).

## Safety Guarantees

- **Disabled in production by default**: Automatically stays idle whenever `QUERY_AUTOPSY_ENV`, `DJANGO_ENV`, `FLASK_ENV`, `FASTAPI_ENV`, `APP_ENV`, `ENVIRONMENT`, or `ENV` is `production` / `prod` (unless `allow_production=True`).
- **PII Scrubbing by default**: Replaces inline SQL string literals with `'[REDACTED]'` and suppresses bindings (`[]`) unless `QUERY_AUTOPSY_REDACT_BINDINGS=false`.
- **Workspace hygiene**: Auto-creates `.query-autopsy/.gitignore`, blocks symlink writes, caps in-memory buffering (`2000`), and rotates `traces.jsonl` to `traces.jsonl.1` at `5 MiB`.

## Django Usage

```python
# settings.py (dev / local only)
MIDDLEWARE = [
    "query_autopsy_trace.QueryAutopsyDjangoMiddleware",
    # ...
]
```

## SQLAlchemy Usage

```python
from sqlalchemy import create_engine
from query_autopsy_trace import JsonlTraceWriter, attach_sqlalchemy_tracing

engine = create_engine("postgresql+psycopg://localhost/app")
writer = JsonlTraceWriter(workspace_root=".")
attach_sqlalchemy_tracing(engine, writer)

with writer.request_scope("req-checkout"):
    # Every SQLAlchemy query executed inside this block shares requestId="req-checkout"
    ...
```
