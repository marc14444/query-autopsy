<?php

declare(strict_types=1);

namespace QueryAutopsy\Laravel\Trace;

final class CallerLocator
{
    private readonly string $normalizedBasePath;

    public function __construct(?string $basePath = null)
    {
        $resolved = $basePath !== null && $basePath !== '' ? realpath($basePath) ?: $basePath : '';
        $this->normalizedBasePath = rtrim(str_replace('\\', '/', $resolved), '/');
    }

    /**
     * Resolves the first application source frame outside vendor/, framework internals, and this package.
     *
     * @return array{file: string, line: int}|null
     */
    public function locate(): ?array
    {
        $frames = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 40);

        foreach ($frames as $frame) {
            $file = $frame['file'] ?? null;
            $line = $frame['line'] ?? null;
            if (!is_string($file) || !is_int($line) || $line < 1) {
                continue;
            }

            $normalized = str_replace('\\', '/', $file);
            if ($this->isFrameworkOrVendorFrame($normalized)) {
                continue;
            }

            $relative = $this->toWorkspaceRelative($normalized);
            if ($relative === null) {
                continue;
            }

            return [
                'file' => $relative,
                'line' => $line,
            ];
        }

        return null;
    }

    private function isFrameworkOrVendorFrame(string $normalizedPath): bool
    {
        if (
            str_contains($normalizedPath, '/vendor/') ||
            str_contains($normalizedPath, '/packages/laravel/src/') ||
            str_contains($normalizedPath, '/Illuminate/') ||
            str_contains($normalizedPath, '/Symfony/') ||
            str_ends_with($normalizedPath, 'artisan')
        ) {
            return true;
        }

        return false;
    }

    private function toWorkspaceRelative(string $normalizedPath): ?string
    {
        if ($this->normalizedBasePath === '') {
            return ltrim($normalizedPath, '/');
        }

        $prefix = $this->normalizedBasePath . '/';
        if (!str_starts_with($normalizedPath, $prefix)) {
            // Do not leak arbitrary external filesystem paths into project traces
            return null;
        }

        $relative = substr($normalizedPath, strlen($prefix));
        if ($relative === '' || str_contains($relative, '../')) {
            return null;
        }

        return $relative;
    }
}
