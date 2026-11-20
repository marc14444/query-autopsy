# `@query-autopsy/mcp`

**Zero-Trust SQL EXPLAIN & Performance Firewall for AI Coding Agents** (Antigravity, Cursor, Claude Code, Windsurf).

Unlike generic SQL MCP servers that grant LLMs raw query power (`run_sql`), `@query-autopsy/mcp` acts as a local `stdio` security firewall:
- **Zero raw row exfiltration**: returns execution plans, metrics, and index diagnostics — never table rows.
- **Estimate-first default**: `autopsy_explain` runs non-executing `EXPLAIN` by default; `analyze` requires explicit `--allow-analyze` AND is blocked on `production` profiles.
- **Zero schema/data mutation**: `ApplyIndexUseCase` and `allowWriteAnalyze` are strictly excluded.
- **No SSRF via prompt injection**: connection DSN comes solely from local operator env/flags (`--uri` / `QUERY_AUTOPSY_URI` / `DATABASE_URL`), never from LLM arguments.
- **Automatic PII & error scrubbing**: strips SQL comments, redacts string literals (`'[REDACTED]'`), and sanitizes SQL cast/detail errors before returning to the model.

## Tools Exposed (Read-Only Annotated)

| Tool | Purpose |
| :--- | :--- |
| `autopsy_check_sql` | Offline static SQL dialect classification & dangerous-function check |
| `autopsy_explain` | Execution plan inspection (`estimate` default; `analyze` opt-in on non-prod) |
| `autopsy_simulate_index` | PostgreSQL HypoPG what-if index simulation (0 disk writes) |
| `autopsy_list_slow_queries` | Aggregated `pg_stat_statements` / `performance_schema` top slow queries (redacted) |

## IDE Setup (`mcp_config.json` / `.cursor/mcp.json` / Claude Code)

### Safe Default (Estimate-Only + PII Redaction)

```json
{
  "mcpServers": {
    "query-autopsy": {
      "command": "npx",
      "args": ["-y", "@query-autopsy/mcp"],
      "env": {
        "QUERY_AUTOPSY_URI": "postgresql://readonly_user:password@127.0.0.1:5432/app_dev"
      }
    }
  }
}
```

### Local Development with `EXPLAIN ANALYZE` Enabled

```json
{
  "mcpServers": {
    "query-autopsy": {
      "command": "npx",
      "args": ["-y", "@query-autopsy/mcp", "--env", "local", "--allow-analyze"],
      "env": {
        "QUERY_AUTOPSY_URI": "postgresql://postgres:password@127.0.0.1:5432/app_dev"
      }
    }
  }
}
```
