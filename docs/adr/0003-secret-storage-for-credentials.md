# ADR-0003: VS Code SecretStorage as Primary Credential Store

- **Status**: Accepted
- **Date**: 2026-11-19

## Context

Developers often configure database connections in `.vscode/settings.json`. However, `.vscode/settings.json` is frequently committed to Git repositories, creating an immediate credential leak risk if database passwords appear in connection strings.

## Decision

1. Store PostgreSQL connection URIs in **VS Code `SecretStorage`** (`context.secrets`) via the `queryAutopsy.configureConnection` command (using a masked `password: true` InputBox).
2. Provide `queryAutopsy.clearConnection` to purge stored credentials.
3. Retain `queryAutopsy.postgres.fallbackConnectionString` strictly as an optional empty-by-default setting for passwordless/local dev URIs when `SecretStorage` is empty, explicitly recommending `SecretStorage` in documentation and settings descriptions.
4. Never emit connection URIs or query parameter values to `LoggerPort` or Output Channels.

## Consequences

- **Positive**:
  - Zero accidental Git leaks of database passwords.
  - Credentials persist encrypted via OS keychain (macOS Keychain / Linux libsecret / Windows Credential Locker).
- **Negative / Trade-offs**:
  - Users must run `QueryAutopsy: Configure PostgreSQL Connection` once before first query inspection (mitigated by offering a one-click `"Configure Connection"` button directly on `MissingConnectionError` notifications).
