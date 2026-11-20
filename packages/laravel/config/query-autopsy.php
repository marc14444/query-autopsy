<?php

declare(strict_types=1);

$readEnv = static fn (string $key, mixed $default = null): mixed =>
    function_exists('env') ? env($key, $default) : $default;

return [
    /*
    |--------------------------------------------------------------------------
    | QueryAutopsy Runtime Trace Capture
    |--------------------------------------------------------------------------
    |
    | null  => Automatically enabled ONLY in `allowed_environments` (local, testing).
    | true  => Enabled in non-production environments.
    | false => Explicitly disabled everywhere.
    |
    */
    'enabled' => $readEnv('QUERY_AUTOPSY_ENABLED', null),

    /*
    |--------------------------------------------------------------------------
    | Allowed Environments & Production Safety Lock
    |--------------------------------------------------------------------------
    |
    | By default QueryAutopsy NEVER registers DB::listen() in production to
    | guarantee zero runtime overhead and zero trace exposure in live traffic.
    |
    */
    'allowed_environments' => ['local', 'testing'],
    'allow_production' => false,

    /*
    |--------------------------------------------------------------------------
    | Universal Trace Output Path (.query-autopsy/traces.jsonl)
    |--------------------------------------------------------------------------
    |
    | When null, defaults to base_path('.query-autopsy/traces.jsonl').
    |
    */
    'trace_path' => $readEnv('QUERY_AUTOPSY_TRACE_PATH', null),

    /*
    |--------------------------------------------------------------------------
    | PII Binding & Literal Redaction (Secure Default: true)
    |--------------------------------------------------------------------------
    |
    | When true, query bindings are stripped and inline SQL string literals are
    | replaced with '[REDACTED]' before flushing JSONL lines to disk.
    | Set QUERY_AUTOPSY_REDACT_BINDINGS=false locally when pairing with --explain-top.
    |
    */
    'redact_bindings' => filter_var(
        $readEnv('QUERY_AUTOPSY_REDACT_BINDINGS', true),
        FILTER_VALIDATE_BOOLEAN,
    ),

    /*
    |--------------------------------------------------------------------------
    | Size & Memory Guardrails
    |--------------------------------------------------------------------------
    |
    | Automatically rotates traces.jsonl -> traces.jsonl.1 beyond max_trace_bytes
    | and caps per-request buffered queries to bound memory usage.
    |
    */
    'max_trace_bytes' => (int) $readEnv('QUERY_AUTOPSY_MAX_TRACE_BYTES', 5 * 1024 * 1024),
    'max_buffer_entries' => (int) $readEnv('QUERY_AUTOPSY_MAX_BUFFER_ENTRIES', 2000),

    /*
    |--------------------------------------------------------------------------
    | Internal Framework Tables to Ignore
    |--------------------------------------------------------------------------
    */
    'ignore_patterns' => [
        'migrations',
        'telescope_entries',
        'telescope_entries_tags',
        'telescope_monitoring',
        'pulse_entries',
        'pulse_aggregates',
        'pulse_values',
        'horizon_',
    ],
];
