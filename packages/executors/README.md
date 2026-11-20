# `@query-autopsy/executors`

Database executor adapters and slow-query readers for `@query-autopsy/core`:
- **PostgreSQL (`pg`)**: Runs `EXPLAIN` and HypoPG simulations inside `BEGIN READ ONLY` / `BEGIN` + `SET LOCAL statement_timeout` + unconditional `ROLLBACK` cleanup.
- **MySQL 8+ / MariaDB (`mysql2`)**: Transactional `START TRANSACTION READ ONLY` + `MAX_EXECUTION_TIME` + `ROLLBACK` isolation.
- **SQLite (`sql.js` WASM)**: Zero-native in-memory WASM copy so inspections never mutate database files on disk.

Supports both **ESM** and **CommonJS** consumers.
