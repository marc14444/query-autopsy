export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class EmptyQueryError extends DomainError {
  readonly code = 'EMPTY_QUERY';

  constructor() {
    super('No SQL statement found in the current selection.');
  }
}

export class MultipleStatementsError extends DomainError {
  readonly code = 'MULTIPLE_STATEMENTS';

  constructor() {
    super(
      'Multiple SQL statements detected. Select a single SQL query to inspect.',
    );
  }
}

export class UnsafeQueryError extends DomainError {
  readonly code = 'UNSAFE_QUERY';

  constructor(message: string) {
    super(message);
  }
}

export class MissingParametersError extends DomainError {
  readonly code = 'MISSING_PARAMETERS';
  readonly parameterIndices: readonly number[];

  constructor(parameterIndices: readonly number[]) {
    super(
      `Query requires positional parameters (${parameterIndices.map((idx) => `$${idx}`).join(', ')}).`,
    );
    this.parameterIndices = parameterIndices;
  }
}

export class MissingConnectionError extends DomainError {
  readonly code = 'MISSING_CONNECTION';

  constructor() {
    super(
      'No PostgreSQL connection is configured. Click "QueryAutopsy: Connect PG" in the status bar or run "QueryAutopsy: Switch / Configure PostgreSQL Profile".',
    );
  }
}

export class InvalidPlanError extends DomainError {
  readonly code = 'INVALID_PLAN';

  constructor(message: string) {
    super(message);
  }
}

export class QueryExecutionError extends DomainError {
  readonly code = 'QUERY_EXECUTION_ERROR';
  readonly sqlState?: string | undefined;

  constructor(message: string, sqlState?: string) {
    super(message);
    this.sqlState = sqlState;
  }
}
