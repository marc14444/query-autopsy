# `marc14444/laravel-query-autopsy`

**Lightweight `--dev` Laravel bridge** that captures Eloquent & Query Builder queries into `.query-autopsy/traces.jsonl` so **`@query-autopsy/cli`**, **`@query-autopsy/mcp`**, and the **QueryAutopsy VS Code / Open VSX extension** can diagnose N+1 bursts and run `EXPLAIN` plans — **without rewriting SQL parsing or diagnostic rules in PHP**.

## Installation (`--dev` only)

```bash
composer require --dev marc14444/laravel-query-autopsy
```

Laravel package auto-discovery registers `QueryAutopsy\Laravel\QueryAutopsyServiceProvider` automatically.

Optional config publish:

```bash
php artisan vendor:publish --tag=query-autopsy-config
```

## Security & Zero-Production-Overhead Guarantees

- **Zero impact in `APP_ENV=production`**: Unless explicitly unlocked, `QueryAutopsyServiceProvider` does **not** attach `DB::listen()` or register trace buffers when `$app->environment('production')`.
- **PII binding redaction by default**: Query bindings are stripped (`bindings: []`) and inline `'...'` string literals are replaced with `'[REDACTED]'` before writing `.query-autopsy/traces.jsonl` (`QUERY_AUTOPSY_REDACT_BINDINGS=true` default).
- **Safe log hygiene**:
  - Creates `.query-autopsy/.gitignore` (`*.jsonl` / `*.ndjson`) automatically to prevent accidental trace commits.
  - Refuses to write through symlinks (`is_link()` guard).
  - Auto-rotates `traces.jsonl` beyond `5 MiB` (`QUERY_AUTOPSY_MAX_TRACE_BYTES`) and caps per-request buffers.
- **Zero shell injection & secret leakage in Artisan**: `php artisan query:autopsy` invokes `@query-autopsy/cli` with raw argument arrays (`proc_open(array $argv)` — never shell concatenation) and passes any `--uri` strictly via `QUERY_AUTOPSY_URI` environment variable rather than CLI arguments.

## Usage

1. Run your local app or PHPUnit / Pest feature tests (`APP_ENV=local` or `APP_ENV=testing`). Queries are automatically emitted to `.query-autopsy/traces.jsonl`.
2. Analyze N+1 bursts & slow queries from Laravel Artisan:

```bash
# Offline N+1 burst & latency report
php artisan query:autopsy trace

# Run read-only EXPLAIN on top offenders against your local PostgreSQL/MySQL/SQLite DB
php artisan query:autopsy trace --explain-top=3 --uri="postgresql://postgres:secret@127.0.0.1:5432/app_dev" --fail-on=warning

# Static PHP SQL safety & CI check across app/
php artisan query:autopsy check --dir=app --format=sarif
```

Or analyze the exact same `.query-autopsy/traces.jsonl` directly from AI coding agents via `@query-autopsy/mcp` (`autopsy_analyze_traces`).
