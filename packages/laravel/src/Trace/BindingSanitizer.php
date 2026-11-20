<?php

declare(strict_types=1);

namespace QueryAutopsy\Laravel\Trace;

use DateTimeInterface;
use Stringable;

final class BindingSanitizer
{
    private const MAX_STRING_LENGTH = 256;

    /**
     * Scrubs single-quoted SQL literals in a single pass when redaction is active.
     * Leaves '?' / '$N' parameter placeholders untouched without duplicating SQL parsing.
     */
    public function scrubSqlLiterals(string $sql, bool $redact): string
    {
        if (!$redact || !str_contains($sql, "'")) {
            return $sql;
        }

        $len = strlen($sql);
        $out = '';
        $i = 0;

        while ($i < $len) {
            $ch = $sql[$i];
            if ($ch === "'") {
                $i++;
                while ($i < $len) {
                    if ($sql[$i] === '\\' && $i + 1 < $len) {
                        $i += 2;
                        continue;
                    }
                    if ($sql[$i] === "'") {
                        if ($i + 1 < $len && $sql[$i + 1] === "'") {
                            $i += 2;
                            continue;
                        }
                        $i++;
                        break;
                    }
                    $i++;
                }
                $out .= "'[REDACTED]'";
                continue;
            }

            $out .= $ch;
            $i++;
        }

        return $out;
    }

    /**
     * Sanitizes bound query parameters before persisting trace entries.
     * When $redact is true, omits parameter values completely so no PII/secrets hit disk.
     *
     * @param array<int|string, mixed> $bindings
     * @return list<mixed>
     */
    public function sanitizeBindings(array $bindings, bool $redact): array
    {
        if ($redact || $bindings === []) {
            return [];
        }

        $sanitized = [];
        foreach (array_values($bindings) as $value) {
            if (count($sanitized) >= 256) {
                break;
            }
            $sanitized[] = $this->normalizeValue($value);
        }

        return $sanitized;
    }

    private function normalizeValue(mixed $value): mixed
    {
        if ($value === null || is_bool($value) || is_int($value)) {
            return $value;
        }

        if (is_float($value)) {
            return is_finite($value) ? $value : null;
        }

        if ($value instanceof DateTimeInterface) {
            return $value->format(DateTimeInterface::ATOM);
        }

        if (is_string($value)) {
            return $this->truncateString($value);
        }

        if ($value instanceof Stringable) {
            return $this->truncateString((string) $value);
        }

        return '[NON_SCALAR]';
    }

    private function truncateString(string $raw): string
    {
        if (strlen($raw) <= self::MAX_STRING_LENGTH) {
            return $raw;
        }

        return substr($raw, 0, self::MAX_STRING_LENGTH) . '...(truncated)';
    }
}
