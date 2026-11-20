# `@query-autopsy/cli`

Language-agnostic SQL `EXPLAIN` profiler, CI/CD performance gate, and offline SQL safety checker built on `@query-autopsy/core` and `@query-autopsy/executors`.

## Commands

```bash
# Inspect a single query safely (estimate mode by default)
npx @query-autopsy/cli explain --uri "$DATABASE_URL" --sql "SELECT id FROM orders WHERE user_id = 42;"

# Read SQL from stdin (Laravel, Python, Go, shell pipes) with PII redaction
cat query.sql | npx @query-autopsy/cli explain --stdin --uri "$DATABASE_URL" --redact --fail-on critical

# Scan a repository (.sql, .ts, .js, .py, .go) in CI and output SARIF 2.1.0
npx @query-autopsy/cli ci --dir ./src --uri "$DATABASE_URL" --format sarif --fail-on critical

# Offline SQL safety check (no database connection required)
npx @query-autopsy/cli check --dir ./migrations
```
