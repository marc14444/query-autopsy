<?php

declare(strict_types=1);

namespace QueryAutopsy\Laravel;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\ServiceProvider;
use QueryAutopsy\Laravel\Console\QueryAutopsyCommand;
use QueryAutopsy\Laravel\Trace\BindingSanitizer;
use QueryAutopsy\Laravel\Trace\CallerLocator;
use QueryAutopsy\Laravel\Trace\JsonlTraceWriter;
use Throwable;

final class QueryAutopsyServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(
            __DIR__ . '/../config/query-autopsy.php',
            'query-autopsy',
        );

        $this->app->singleton(BindingSanitizer::class);

        $this->app->singleton(CallerLocator::class, function ($app): CallerLocator {
            $basePath = method_exists($app, 'basePath') ? $app->basePath() : null;
            return new CallerLocator(is_string($basePath) ? $basePath : null);
        });

        $this->app->singleton(JsonlTraceWriter::class, function ($app): JsonlTraceWriter {
            /** @var array<string, mixed> $config */
            $config = $this->readPackageConfig($app);
            $basePath = method_exists($app, 'basePath') ? $app->basePath() : (getcwd() ?: '.');
            $configuredPath = $config['trace_path'] ?? null;
            $tracePath = is_string($configuredPath) && trim($configuredPath) !== ''
                ? trim($configuredPath)
                : $basePath . DIRECTORY_SEPARATOR . '.query-autopsy' . DIRECTORY_SEPARATOR . 'traces.jsonl';

            /** @var list<string> $ignorePatterns */
            $ignorePatterns = is_array($config['ignore_patterns'] ?? null)
                ? array_values(array_filter($config['ignore_patterns'], 'is_string'))
                : [];

            return new JsonlTraceWriter(
                tracePath: $tracePath,
                redactBindings: (bool) ($config['redact_bindings'] ?? true),
                maxTraceBytes: (int) ($config['max_trace_bytes'] ?? 5 * 1024 * 1024),
                maxBufferEntries: (int) ($config['max_buffer_entries'] ?? 2000),
                ignorePatterns: $ignorePatterns,
                basePath: is_string($basePath) ? $basePath : null,
                sanitizer: $app->make(BindingSanitizer::class),
                callerLocator: $app->make(CallerLocator::class),
            );
        });
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->publishes([
                __DIR__ . '/../config/query-autopsy.php' => $this->resolveConfigPath('query-autopsy.php'),
            ], 'query-autopsy-config');

            $this->commands([QueryAutopsyCommand::class]);
        }

        if (!$this->isCollectionEnabled()) {
            // Zero overhead / zero DB listener attached in production by default.
            return;
        }

        $attachListener = function (mixed $db): void {
            if (!is_object($db) || !method_exists($db, 'listen')) {
                return;
            }

            $db->listen(function (object $query): void {
                try {
                    /** @var JsonlTraceWriter $writer */
                    $writer = $this->app->make(JsonlTraceWriter::class);
                    $sql = property_exists($query, 'sql') && is_string($query->sql) ? $query->sql : '';
                    $bindings = property_exists($query, 'bindings') && is_array($query->bindings)
                        ? $query->bindings
                        : [];
                    $time = property_exists($query, 'time') && is_numeric($query->time)
                        ? (float) $query->time
                        : 0.0;

                    $driverName = 'mysql';
                    if (
                        property_exists($query, 'connection') &&
                        is_object($query->connection) &&
                        method_exists($query->connection, 'getDriverName')
                    ) {
                        $driverName = (string) $query->connection->getDriverName();
                    } elseif (property_exists($query, 'connectionName') && is_string($query->connectionName)) {
                        $driverName = $query->connectionName;
                    }

                    $writer->record($sql, $bindings, $time, $driverName);
                } catch (Throwable) {
                    // Never allow instrumentation telemetry to disrupt application execution.
                }
            });
        };

        if ($this->app->resolved('db')) {
            $attachListener($this->app->make('db'));
        } else {
            $this->app->afterResolving('db', $attachListener);
        }

        $flushCallback = function (): void {
            try {
                if ($this->app->resolved(JsonlTraceWriter::class)) {
                    /** @var JsonlTraceWriter $writer */
                    $writer = $this->app->make(JsonlTraceWriter::class);
                    $writer->flush();
                    $writer->resetRequestContext();
                }
            } catch (Throwable) {
                // Swallow telemetry I/O errors safely on shutdown/termination.
            }
        };

        if (method_exists($this->app, 'terminating')) {
            $this->app->terminating($flushCallback);
        }

        // Isolate worker/queue/Octane request boundaries cleanly when EventDispatcher is available.
        if ($this->app->bound('events')) {
            $events = $this->app->make('events');
            if (is_object($events) && method_exists($events, 'listen')) {
                $events->listen('Illuminate\\Queue\\Events\\JobProcessed', $flushCallback);
                $events->listen('Laravel\\Octane\\Events\\RequestTerminated', $flushCallback);
            }
        }

        register_shutdown_function($flushCallback);
    }

    public function isCollectionEnabled(): bool
    {
        $config = $this->readPackageConfig($this->app);
        $currentEnv = $this->resolveEnvironmentName();
        $allowed = is_array($config['allowed_environments'] ?? null)
            ? array_values(array_filter($config['allowed_environments'], 'is_string'))
            : ['local', 'testing'];

        return EnvironmentGuard::shouldEnable(
            enabledSetting: $config['enabled'] ?? null,
            allowProduction: (bool) ($config['allow_production'] ?? false),
            currentEnvironment: $currentEnv,
            allowedEnvironments: $allowed,
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function readPackageConfig(mixed $app): array
    {
        if (is_object($app) && method_exists($app, 'make') && $app->bound('config')) {
            $configService = $app->make('config');
            if (is_object($configService) && method_exists($configService, 'get')) {
                $value = $configService->get('query-autopsy', []);
                return is_array($value) ? $value : [];
            }
        }

        return [];
    }

    private function resolveEnvironmentName(): string
    {
        if (method_exists($this->app, 'environment')) {
            $env = $this->app->environment();
            if (is_string($env)) {
                return $env;
            }
        }

        return 'production';
    }

    private function resolveConfigPath(string $filename): string
    {
        if (method_exists($this->app, 'configPath')) {
            /** @var string $path */
            $path = $this->app->configPath($filename);
            return $path;
        }

        return $filename;
    }
}
