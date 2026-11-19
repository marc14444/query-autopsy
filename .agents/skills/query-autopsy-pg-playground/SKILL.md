---
name: query-autopsy-pg-playground
description: >-
  Use this skill when starting, resetting, or testing QueryAutopsy against the
  local Docker PostgreSQL 16 playground database.
---

# QueryAutopsy Local PostgreSQL Playground

Use this procedure to spin up a seeded PostgreSQL 16 database (`10,000` users, `150,000` orders with intentional missing indexes) for manual testing in the VS Code Extension Development Host.

## Steps

1. **Start PostgreSQL 16**:
   ```bash
   docker compose -f docker/docker-compose.yml up -d
   ```
2. **Verify Container Readiness**:
   ```bash
   docker exec query_autopsy_pg pg_isready -U postgres -d query_autopsy_dev
   ```
3. **Connection URI** (use with `QueryAutopsy: Configure PostgreSQL Connection` inside Extension Development Host):
   ```text
   postgresql://postgres:queryautopsy@localhost:5432/query_autopsy_dev
   ```
4. **Test Scenarios**:
   - Open `docker/sample_queries.sql` in the Extension Development Host (`F5`).
   - Query 1 (`WHERE user_id = 42`) should trigger `SEQ_SCAN_LARGE_TABLE` and suggest `CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);`.
   - Query 3 (`WHERE user_id = $1 AND status = $2`) verifies positional parameter prompting (`42, pending`).
   - Query 4 (`users WHERE id = 42`) verifies a clean `Index Scan` with zero warnings.
5. **Reset Database State** (e.g., after testing suggested indexes):
   ```bash
   docker compose -f docker/docker-compose.yml down -v && docker compose -f docker/docker-compose.yml up -d
   ```
