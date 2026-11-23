from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from query_autopsy_trace import (
    JsonlTraceWriter,
    QueryAutopsyDjangoMiddleware,
    attach_sqlalchemy_tracing,
    normalize_engine,
    scrub_sql_literals,
    should_enable_tracing,
)


class FakeDialect:
    def __init__(self, name: str) -> None:
        self.name = name


class FakeSqlAlchemyEventBus:
    def __init__(self) -> None:
        self.listeners: list[tuple[object, str, object]] = []

    def listen(self, target: object, identifier: str, fn: object) -> None:
        self.listeners.append((target, identifier, fn))

    def emit(self, identifier: str, *args: object) -> None:
        for _, name, fn in self.listeners:
            if name == identifier:
                fn(*args)  # type: ignore[operator]


class FakeSqlAlchemyEngine:
    def __init__(self, dialect_name: str) -> None:
        self.dialect = FakeDialect(dialect_name)


class FakeDjangoConnection:
    def __init__(self, vendor: str) -> None:
        self.vendor = vendor
        self.wrapper_calls = 0

    def execute_wrapper(self, wrapper):
        self.wrapper_calls += 1
        conn = self

        class _Ctx:
            def __enter__(self_ctx):
                def _run(sql: str, params=None, many: bool = False):
                    def _exec(s, p, m, c):
                        return ("ok", s, p, m)

                    return wrapper(_exec, sql, params, many, {"connection": conn})

                conn._runner = _run
                return conn

            def __exit__(self_ctx, exc_type, exc, tb):
                conn._runner = None
                return False

        return _Ctx()


class TraceBridgeTests(unittest.TestCase):
    def test_production_guardrails_block_by_default(self) -> None:
        self.assertFalse(should_enable_tracing(env={"APP_ENV": "production"}))
        self.assertFalse(should_enable_tracing(env={"DJANGO_ENV": "prod"}))
        self.assertFalse(should_enable_tracing(env={"ENVIRONMENT": "production"}))
        self.assertTrue(should_enable_tracing(env={"APP_ENV": "local"}))
        self.assertTrue(should_enable_tracing(env={}))
        self.assertTrue(
            should_enable_tracing(allow_production=True, env={"APP_ENV": "production"})
        )

    def test_normalize_engine_dialects(self) -> None:
        self.assertEqual(normalize_engine("postgresql+psycopg2"), "postgresql")
        self.assertEqual(normalize_engine("postgres"), "postgresql")
        self.assertEqual(normalize_engine("mysql+pymysql"), "mysql")
        self.assertEqual(normalize_engine("sqlite+pysqlite"), "sqlite")
        self.assertEqual(normalize_engine("duckdb"), "duckdb")
        self.assertIsNone(normalize_engine("oracle"))

    def test_writer_scrubs_pii_creates_gitignore_and_scopes_requests(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            writer = JsonlTraceWriter(
                workspace_root=tmp,
                current_environment="local",
            )
            with sqlite3.connect(":memory:") as db:
                db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, email TEXT)")
                db.execute("INSERT INTO items (email) VALUES ('alice@example.com')")

            with writer.request_scope("req-alpha"):
                writer.record(
                    sql="SELECT * FROM items WHERE email = 'secret@example.com'",
                    bindings=["secret@example.com", 42],
                    duration_ms=14.5678,
                    engine="postgresql",
                )

            trace_file = Path(tmp) / ".query-autopsy" / "traces.jsonl"
            gitignore_file = Path(tmp) / ".query-autopsy" / ".gitignore"
            self.assertTrue(trace_file.exists())
            self.assertTrue(gitignore_file.exists())
            self.assertIn("*.jsonl", gitignore_file.read_text(encoding="utf-8"))

            entries = [
                json.loads(line)
                for line in trace_file.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(len(entries), 1)
            entry = entries[0]
            self.assertEqual(entry["requestId"], "req-alpha")
            self.assertEqual(entry["engine"], "postgresql")
            self.assertEqual(entry["bindings"], [])
            self.assertEqual(entry["durationMs"], 14.568)
            self.assertNotIn("secret@example.com", entry["sql"])
            self.assertIn("'[REDACTED]'", entry["sql"])

    def test_writer_refuses_symlinks_and_rotates_on_size(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            qa_dir = Path(tmp) / ".query-autopsy"
            qa_dir.mkdir(parents=True, exist_ok=True)
            real_target = Path(tmp) / "outside.txt"
            real_target.write_text("", encoding="utf-8")
            symlink_trace = qa_dir / "traces.jsonl"
            os.symlink(real_target, symlink_trace)

            writer = JsonlTraceWriter(workspace_root=tmp, current_environment="testing")
            writer.record(sql="SELECT 1")
            with self.assertRaises(PermissionError):
                writer.flush()

            symlink_trace.unlink()
            rot_writer = JsonlTraceWriter(
                workspace_root=tmp,
                current_environment="testing",
                max_trace_bytes=4096,
            )
            for idx in range(35):
                rot_writer.record(sql=f"SELECT id, payload FROM events WHERE id = {idx}")
            rot_writer.flush()
            for idx in range(35):
                rot_writer.record(sql=f"SELECT id, payload FROM events WHERE id = {idx + 100}")
            rot_writer.flush()

            self.assertTrue((qa_dir / "traces.jsonl.1").exists())
            self.assertTrue((qa_dir / "traces.jsonl").exists())

    def test_django_middleware_noop_in_prod_and_captures_in_dev(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prod_conn = FakeDjangoConnection("postgresql")
            prod_writer = JsonlTraceWriter(
                workspace_root=tmp,
                env={"DJANGO_ENV": "production"},
            )
            prod_mw = QueryAutopsyDjangoMiddleware(
                lambda req: "prod-ok",
                writer=prod_writer,
                connections_provider=lambda: [prod_conn],
            )
            self.assertEqual(prod_mw(object()), "prod-ok")
            self.assertEqual(prod_conn.wrapper_calls, 0)
            self.assertFalse((Path(tmp) / ".query-autopsy" / "traces.jsonl").exists())

            dev_conn = FakeDjangoConnection("postgresql")
            dev_writer = JsonlTraceWriter(
                workspace_root=tmp,
                env={"DJANGO_ENV": "development"},
            )

            class _FakeRequest:
                headers = {"X-Request-Id": "django-req-9"}

            def _view(_req):
                dev_conn._runner(
                    "SELECT * FROM users WHERE email = 'dev@example.com'",
                    ["dev@example.com"],
                )
                return "dev-ok"

            dev_mw = QueryAutopsyDjangoMiddleware(
                _view,
                writer=dev_writer,
                connections_provider=lambda: [dev_conn],
            )
            self.assertEqual(dev_mw(_FakeRequest()), "dev-ok")
            self.assertEqual(dev_conn.wrapper_calls, 1)

            entries = [
                json.loads(line)
                for line in (Path(tmp) / ".query-autopsy" / "traces.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line.strip()
            ]
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["requestId"], "django-req-9")
            self.assertEqual(entries[0]["engine"], "postgresql")
            self.assertNotIn("dev@example.com", entries[0]["sql"])

    def test_sqlalchemy_bridge_hooks_and_records(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bus = FakeSqlAlchemyEventBus()
            engine = FakeSqlAlchemyEngine("postgresql+psycopg")

            prod_writer = JsonlTraceWriter(workspace_root=tmp, env={"APP_ENV": "production"})
            attach_sqlalchemy_tracing(engine, prod_writer, event_module=bus)
            self.assertEqual(len(bus.listeners), 0)

            dev_writer = JsonlTraceWriter(workspace_root=tmp, env={"APP_ENV": "local"})
            attach_sqlalchemy_tracing(engine, dev_writer, event_module=bus)
            self.assertEqual(len(bus.listeners), 2)

            class _Ctx:
                pass

            ctx = _Ctx()
            cursor = object()
            with dev_writer.request_scope("sa-req-1"):
                bus.emit(
                    "before_cursor_execute",
                    engine,
                    cursor,
                    "SELECT * FROM orders WHERE note = 'john@doe.io'",
                    ("john@doe.io",),
                    ctx,
                    False,
                )
                bus.emit(
                    "after_cursor_execute",
                    engine,
                    cursor,
                    "SELECT * FROM orders WHERE note = 'john@doe.io'",
                    ("john@doe.io",),
                    ctx,
                    False,
                )

            entries = [
                json.loads(line)
                for line in (Path(tmp) / ".query-autopsy" / "traces.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line.strip()
            ]
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["requestId"], "sa-req-1")
            self.assertEqual(entries[0]["engine"], "postgresql")
            self.assertIn("'[REDACTED]'", entries[0]["sql"])
            self.assertEqual(entries[0]["bindings"], [])
            self.assertIn("durationMs", entries[0])

    def test_scrub_sql_literals_handles_escaped_quotes(self) -> None:
        cleaned = scrub_sql_literals("SELECT * FROM users WHERE bio = 'O''Reilly' AND code = 'abc'")
        self.assertNotIn("Reilly", cleaned)
        self.assertNotIn("abc", cleaned)


if __name__ == "__main__":
    unittest.main()
