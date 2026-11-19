# TECH-SPEC-01: SQL Classifier & Safe PostgreSQL Executor

- **Modules Covered**:
  - `src/domain/services/sqlClassifier.ts`
  - `src/application/usecases/inspectQueryService.ts`
  - `src/infrastructure/postgres/pgQueryExecutor.ts`
  - `src/infrastructure/postgres/pgErrors.ts`

---

## 1. SQL Lexical Scanner & Statement Classifier

`classifySqlStatement(rawSql: string): ClassifiedSql` operates as a single-pass state machine (`scanPostgreSql`) without external SQL parser bloat:

### 1.1 Lexical Rules
- **Line comments**: `-- ... \n` stripped from `normalizedSql` and ignored for token classification.
- **Nested block comments**: `/* ... /* ... */ ... */` supported per PostgreSQL syntax (`depth` counter).
- **Single-quoted literals**: `'...'` handles doubled quotes `''` and PostgreSQL escape strings `E'...\''`.
- **Double-quoted identifiers**: `"..."` handles `""`.
- **Dollar-quoted literals**: `$$...$$` and `$tag$...$tag$` matched before `$N` positional parameters so `$1` inside a PL/pgSQL string literal is ignored.
- **Positional parameters**: `$[1-9][0-9]*` (outside identifier boundaries) collected into sorted unique `parameterIndices`.
- **Semicolon enforcement**: A trailing `;` is stripped cleanly; any non-whitespace token appearing after a top-level `;` immediately throws `MultipleStatementsError`.

### 1.2 Statement Kind Matrix

| First Top-Level Keyword | Additional Condition | `SqlStatementKind` | `analyze` Allowed? | `estimate` Allowed? |
| :--- | :--- | :--- | :--- | :--- |
| `SELECT`, `VALUES`, `TABLE` | — | `READ` | Yes (`BEGIN READ ONLY`) | Yes |
| `WITH` | No `INSERT`/`UPDATE`/`DELETE`/`MERGE` token | `READ` | Yes (`BEGIN READ ONLY`) | Yes |
| `WITH` | Contains `INSERT`/`UPDATE`/`DELETE`/`MERGE` | `WRITE` | Only if `allowWriteAnalyze=true` | Yes |
| `INSERT`, `UPDATE`, `DELETE`, `MERGE` | — | `WRITE` | Only if `allowWriteAnalyze=true` | Yes |
| `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `VACUUM`, `CLUSTER`, `REINDEX`, `COMMENT`, `LOCK`, `COPY` | — | `DDL` | Never (`UnsafeQueryError`) | Never (`UnsafeQueryError`) |
| `EXPLAIN` | — | `EXPLAIN` | Rejected (`UnsafeQueryError`) | Rejected (`UnsafeQueryError`) |
| Anything else | — | `UNKNOWN` | Never (`UnsafeQueryError`) | Never (`UnsafeQueryError`) |

---

## 2. Parameterized Queries (`$1..$n`)

1. `InspectQueryService` inspects `classified.parameterIndices`. If non-empty, it requires `input.parameters.length >= highestIndex`.
2. If missing, `InspectQueryService` throws `MissingParametersError(parameterIndices)`.
3. Presentation catches `MissingParametersError`, prompts the user via `InputBox` (accepting either a JSON array `[42, "pending"]` or comma-separated primitives `42, pending`), and re-invokes `InspectQueryUseCase.execute`.
4. `PgQueryExecutor` executes `client.query(explainSql, [...request.parameters])` only when `parameters.length > 0`, triggering `node-postgres` Extended Query Protocol (`Parse`/`Bind`/`Execute`).

---

## 3. Transactional Isolation & Timeout Protocol

Inside `PgQueryExecutor.executeExplain(connectionString, request)`:

```text
1. Acquire pooled client (Pool max: 4, connectionTimeoutMillis: 5000)
2. Clamp timeoutMs = trunc(clamp(statementTimeoutMs, 100, 120000))
3. BEGIN READ ONLY   (if mode === 'analyze' && kind === 'READ')
   OR BEGIN          (otherwise)
4. SET LOCAL statement_timeout = <timeoutMs>
5. Execute:
   - analyze : EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) <normalizedSql>
   - estimate: EXPLAIN (COSTS, VERBOSE, FORMAT JSON) <normalizedSql>
6. Extract row[0]["QUERY PLAN"] (or throw InvalidPlanError)
7. FINALLY:
   - ROLLBACK (unconditional, swallows cleanup warning via LoggerPort)
   - client.release()
```

### 3.1 PostgreSQL Error Mapping (`pgErrors.ts`)
- `57014`: Timeout (`statement_timeout` exceeded)
- `28P01`, `28000`: Auth failure -> direct user to `queryAutopsy.configureConnection`
- `3D000`: Missing database
- `42P01`, `42703`, `42601`: Missing relation, missing column, syntax error
- `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`: Server unreachable hint
