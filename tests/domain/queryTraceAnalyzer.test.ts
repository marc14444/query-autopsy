import {
  analyzeQueryTraces,
  computeTraceQueryFingerprint,
  formatTraceAnalysisMarkdown,
  parseQueryTraceStream,
  selectExplainCandidatesForTrace,
} from '@query-autopsy/core';
import { describe, expect, it } from 'vitest';

describe('queryTraceAnalyzer', () => {
  it('parses universal .query-autopsy/traces.jsonl lines safely, skips malformed lines, and resists prototype keys', () => {
    const raw = [
      '# header comment ignored',
      '',
      JSON.stringify({
        timestamp: '2026-11-20T12:00:00Z',
        engine: 'pg',
        sql: "SELECT * FROM users WHERE id = '1'",
        bindings: ['secret@example.com'],
        durationMs: 12.5,
        requestId: 'req-1',
        file: 'app/Http/Controllers/UserController.php',
        line: 42,
      }),
      '{invalid json line',
      JSON.stringify({ engine: 'postgresql', durationMs: 5 }), // missing sql
      JSON.stringify({
        sql: 'SELECT * FROM roles WHERE name = $1',
        requestId: '__proto__',
        durationMs: 3.1,
      }),
    ].join('\n');

    const parsed = parseQueryTraceStream(raw);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.skippedLines).toBe(2);
    expect(parsed.truncated).toBe(false);
    expect(parsed.entries[0]?.engine).toBe('postgresql');
    expect(parsed.entries[0]?.line).toBe(42);
    expect(parsed.entries[1]?.requestId).toBe('__proto__');

    const truncated = parseQueryTraceStream(raw, { maxEntries: 1 });
    expect(truncated.entries).toHaveLength(1);
    expect(truncated.truncated).toBe(true);
  });

  it('normalizes SQL literals, numeric constants, IN lists, VALUES rows, and bindings into identical fingerprints while keeping PG casts', () => {
    const q1 =
      "/* comment */ select id, created_at::date FROM orders WHERE user_id = 42 AND status = 'paid' AND tag_id IN (1, 2, 3);";
    const q2 =
      'SELECT id, created_at::date from orders where user_id = $1 and status = $2 and tag_id in (99);';
    const q3 =
      'SELECT id, created_at::date FROM orders WHERE user_id = :uid AND status = :st AND tag_id IN (?, ?, ?, ?)';

    const fp1 = computeTraceQueryFingerprint(q1, 'postgresql');
    const fp2 = computeTraceQueryFingerprint(q2, 'postgresql');
    const fp3 = computeTraceQueryFingerprint(q3, 'postgresql');

    expect(fp1).toBe(fp2);
    expect(fp2).toBe(fp3);
    expect(fp1).toContain('created_at::date');
    expect(fp1).toContain('IN (?)');

    const bulk1 =
      "INSERT INTO logs (uid, msg) VALUES (1, 'a'), (2, 'b'), (3, 'c')";
    const bulk2 = 'INSERT INTO logs (uid, msg) VALUES (9, ?)';
    expect(computeTraceQueryFingerprint(bulk1, 'postgresql')).toBe(
      computeTraceQueryFingerprint(bulk2, 'postgresql'),
    );
  });

  it('detects per-request N_PLUS_ONE_BURST and SLOW_TRACE_QUERY while separating distinct requests and scrubbing PII', () => {
    const entries = [
      // Request 1: 4x N+1 warning burst + 1 slow query
      ...['alice@a.com', 'bob@b.com', 'carol@c.com', 'dave@d.com'].map(
        (email, idx) => ({
          engine: 'mysql' as const,
          sql: `SELECT * FROM profiles WHERE email = '${email}'`,
          bindings: [email],
          durationMs: 4.2,
          requestId: 'req-n1-warning',
          file: 'app/Http/Controllers/OrderController.php',
          line: 88 + idx,
        }),
      ),
      // Separate request with 1 single query should NOT merge with req-n1-warning
      {
        engine: 'mysql' as const,
        sql: "SELECT * FROM profiles WHERE email = 'single@s.com'",
        durationMs: 3.0,
        requestId: 'req-single',
      },
      // Critical N+1 burst across 10 repeats
      ...Array.from({ length: 10 }, (_, idx) => ({
        engine: 'postgresql' as const,
        sql: `SELECT id, total FROM invoices WHERE customer_id = ${idx + 1}`,
        durationMs: 2.5,
        requestId: 'req-critical-burst',
        file: 'src/services/invoiceService.ts',
        line: 30,
      })),
      // Slow analytical query
      {
        engine: 'postgresql' as const,
        sql: "/* token */ SELECT count(*) FROM audit_logs WHERE org_email = 'ceo@corp.com' AND score > 99.5",
        durationMs: 350,
        requestId: 'req-report',
        file: 'app/Jobs/AuditExport.php',
        line: 19,
      },
    ];

    const result = analyzeQueryTraces(entries, {
      nPlusOneWarningThreshold: 3,
      nPlusOneCriticalThreshold: 10,
      slowQueryMsThreshold: 200,
      redact: true,
    });

    expect(result.totalQueries).toBe(16);
    expect(result.requestCount).toBe(4);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(3);

    const n1Critical = result.diagnostics.find(
      (d) =>
        d.ruleId === 'N_PLUS_ONE_BURST' &&
        d.requestId === 'req-critical-burst',
    );
    expect(n1Critical?.severity).toBe('critical');
    expect(n1Critical?.repeatCount).toBe(10);

    const n1Warn = result.diagnostics.find(
      (d) =>
        d.ruleId === 'N_PLUS_ONE_BURST' && d.requestId === 'req-n1-warning',
    );
    expect(n1Warn?.severity).toBe('warning');
    expect(n1Warn?.repeatCount).toBe(4);
    expect(n1Warn?.sampleSql).not.toContain('alice@a.com');
    expect(n1Warn?.sampleSql).toContain('[REDACTED]');

    const slow = result.diagnostics.find((d) => d.ruleId === 'SLOW_TRACE_QUERY');
    expect(slow?.severity).toBe('warning');
    expect(slow?.maxDurationMs).toBe(350);
    expect(slow?.sampleSql).not.toContain('ceo@corp.com');
    expect(slow?.sampleSql).not.toContain('token');

    const md = formatTraceAnalysisMarkdown(result, '.query-autopsy/traces.jsonl');
    expect(md).toContain('N_PLUS_ONE_BURST');
    expect(md).toContain('SLOW_TRACE_QUERY');
    expect(md).not.toContain('ceo@corp.com');

    const candidates = selectExplainCandidatesForTrace(entries, result, 2);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.rawSql).toContain('invoices');
  });
});
