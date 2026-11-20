<?php

declare(strict_types=1);

namespace QueryAutopsy\Laravel\Trace;

use DateTimeImmutable;
use DateTimeZone;
use RuntimeException;

final class JsonlTraceWriter
{
    /** @var list<array<string, mixed>> */
    private array $buffer = [];

    private ?string $requestId = null;

    /** @var list<string> */
    private readonly array $normalizedIgnorePatterns;

    private readonly BindingSanitizer $sanitizer;

    private readonly CallerLocator $callerLocator;

    /**
     * @param list<string> $ignorePatterns
     */
    public function __construct(
        private readonly string $tracePath,
        private readonly bool $redactBindings = true,
        private readonly int $maxTraceBytes = 5 * 1024 * 1024,
        private readonly int $maxBufferEntries = 2000,
        array $ignorePatterns = [],
        ?string $basePath = null,
        ?BindingSanitizer $sanitizer = null,
        ?CallerLocator $callerLocator = null,
    ) {
        $this->sanitizer = $sanitizer ?? new BindingSanitizer();
        $this->callerLocator = $callerLocator ?? new CallerLocator($basePath);

        $cleaned = [];
        foreach ($ignorePatterns as $pattern) {
            $needle = strtolower(str_replace('%', '', trim($pattern)));
            if ($needle !== '') {
                $cleaned[] = $needle;
            }
        }
        $this->normalizedIgnorePatterns = $cleaned;
    }

    public static function mapDriverToEngine(string $driverName): ?string
    {
        return match (strtolower(trim($driverName))) {
            'pgsql', 'postgres', 'postgresql' => 'postgresql',
            'mysql', 'mariadb' => 'mysql',
            'sqlite', 'sqlite3' => 'sqlite',
            default => null,
        };
    }

    public function getTracePath(): string
    {
        return $this->tracePath;
    }

    public function getBufferedCount(): int
    {
        return count($this->buffer);
    }

    public function setRequestId(?string $rawRequestId): void
    {
        if ($rawRequestId === null) {
            $this->requestId = null;
            return;
        }

        $sanitized = preg_replace('/[^a-zA-Z0-9._:-]/', '', trim($rawRequestId)) ?? '';
        $this->requestId = $sanitized !== '' ? substr($sanitized, 0, 64) : null;
    }

    public function getRequestId(): string
    {
        if ($this->requestId === null) {
            $this->requestId = 'req-' . bin2hex(random_bytes(8));
        }

        return $this->requestId;
    }

    public function resetRequestContext(): void
    {
        $this->requestId = null;
    }

    /**
     * Records a captured DB query into the bounded in-memory request buffer.
     *
     * @param array<int|string, mixed> $bindings
     * @param array{file: string, line: int}|null $callerOverride
     */
    public function record(
        string $sql,
        array $bindings,
        float $durationMs,
        string $driverName = 'mysql',
        ?array $callerOverride = null,
    ): void {
        $trimmed = trim($sql);
        if ($trimmed === '' || count($this->buffer) >= max(1, $this->maxBufferEntries)) {
            return;
        }

        if ($this->shouldIgnoreSql($trimmed)) {
            return;
        }

        $engine = self::mapDriverToEngine($driverName);
        $caller = $callerOverride ?? $this->callerLocator->locate();
        $safeSql = $this->sanitizer->scrubSqlLiterals($trimmed, $this->redactBindings);
        $safeBindings = $this->sanitizer->sanitizeBindings($bindings, $this->redactBindings);

        $entry = [
            'timestamp' => (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z'),
            'sql' => $safeSql,
            'bindings' => $safeBindings,
            'durationMs' => round(max(0.0, $durationMs), 3),
            'requestId' => $this->getRequestId(),
        ];

        if ($engine !== null) {
            $entry['engine'] = $engine;
        }
        if ($caller !== null) {
            $entry['file'] = $caller['file'];
            $entry['line'] = $caller['line'];
        }

        $this->buffer[] = $entry;
    }

    /**
     * Atomically flushes buffered entries to `.query-autopsy/traces.jsonl`.
     * Protects against symlink escapes and rotates oversized trace files automatically.
     */
    public function flush(): void
    {
        if ($this->buffer === []) {
            return;
        }

        $pending = $this->buffer;
        $this->buffer = [];

        $dir = dirname($this->tracePath);
        if (is_link($dir) || is_link($this->tracePath)) {
            throw new RuntimeException('Refusing to write QueryAutopsy trace to a symlink path.');
        }

        if (!is_dir($dir)) {
            if (!@mkdir($dir, 0750, true) && !is_dir($dir)) {
                throw new RuntimeException("Unable to create QueryAutopsy trace directory: {$dir}");
            }
        }

        $gitignorePath = $dir . DIRECTORY_SEPARATOR . '.gitignore';
        if (!file_exists($gitignorePath) && !is_link($gitignorePath)) {
            @file_put_contents($gitignorePath, "*.jsonl\n*.ndjson\n", LOCK_EX);
        }

        if (is_link($this->tracePath)) {
            throw new RuntimeException('Refusing to write QueryAutopsy trace to a symlink file.');
        }

        $maxBytes = max(4096, $this->maxTraceBytes);
        if (file_exists($this->tracePath)) {
            clearstatcache(true, $this->tracePath);
            $size = @filesize($this->tracePath);
            if (is_int($size) && $size >= $maxBytes) {
                $backup = $this->tracePath . '.1';
                if (!is_link($backup)) {
                    @rename($this->tracePath, $backup);
                }
            }
        }

        $lines = [];
        foreach ($pending as $entry) {
            $encoded = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
            if (is_string($encoded)) {
                $lines[] = $encoded;
            }
        }

        if ($lines === []) {
            return;
        }

        $payload = implode("\n", $lines) . "\n";
        $written = @file_put_contents($this->tracePath, $payload, FILE_APPEND | LOCK_EX);
        if ($written === false) {
            throw new RuntimeException("Failed writing QueryAutopsy traces to {$this->tracePath}");
        }
    }

    private function shouldIgnoreSql(string $sql): bool
    {
        if ($this->normalizedIgnorePatterns === []) {
            return false;
        }

        $lower = strtolower($sql);
        foreach ($this->normalizedIgnorePatterns as $needle) {
            if (str_contains($lower, $needle)) {
                return true;
            }
        }

        return false;
    }
}
