<?php

declare(strict_types=1);

namespace QueryAutopsy\Laravel\Console;

use Closure;
use Illuminate\Console\Command;
use InvalidArgumentException;
use QueryAutopsy\Laravel\Trace\JsonlTraceWriter;

final class QueryAutopsyCommand extends Command
{
    private const ALLOWED_ACTIONS = ['trace', 'ci', 'check'];
    private const ALLOWED_FORMATS = ['markdown', 'json', 'sarif'];
    private const ALLOWED_FAIL_ON = ['none', 'info', 'warning', 'critical'];
    private const ALLOWED_ENGINES = ['postgresql', 'mysql', 'sqlite'];

    protected $signature = 'query:autopsy
        {action=trace : Subcommand to run (trace, ci, check)}
        {--file= : Trace JSONL file or PHP source file to inspect}
        {--dir= : Directory to scan in ci/check mode (defaults to app/)}
        {--uri= : Optional database DSN override}
        {--engine= : Explicit SQL engine override (postgresql, mysql, sqlite)}
        {--threshold-n1=3 : N+1 identical query burst threshold per requestId}
        {--slow-ms=200 : Slow trace query threshold in ms}
        {--explain-top=0 : Run read-only EXPLAIN on top N trace offenders (requires DSN)}
        {--format=markdown : Output format (markdown, json, sarif)}
        {--fail-on=none : Exit non-zero threshold (none, info, warning, critical)}
        {--no-redact : Disable PII literal redaction (enabled by default)}';

    protected $description = 'Inspect captured .query-autopsy/traces.jsonl telemetry or PHP SQL queries via @query-autopsy/cli.';

    /**
     * @var (Closure(list<string>, string, array<string, string>, callable, callable): int)|null
     */
    private ?Closure $processRunner = null;

    /**
     * Overrides the subprocess runner (primarily for deterministic unit testing).
     *
     * @param (Closure(list<string>, string, array<string, string>, callable, callable): int)|null $runner
     */
    public function setProcessRunner(?Closure $runner): void
    {
        $this->processRunner = $runner;
    }

    public function handle(JsonlTraceWriter $writer): int
    {
        // Flush any buffered queries recorded during the current Artisan lifecycle first.
        $writer->flush();

        $action = strtolower(trim((string) $this->argument('action')));
        if (!in_array($action, self::ALLOWED_ACTIONS, true)) {
            $this->error("Invalid action \"{$action}\". Expected one of: trace, ci, check.");
            return self::FAILURE;
        }

        $format = strtolower(trim((string) $this->option('format')));
        if (!in_array($format, self::ALLOWED_FORMATS, true)) {
            $this->error("Invalid --format \"{$format}\". Expected markdown, json, or sarif.");
            return self::FAILURE;
        }

        $failOn = strtolower(trim((string) $this->option('fail-on')));
        if (!in_array($failOn, self::ALLOWED_FAIL_ON, true)) {
            $this->error("Invalid --fail-on \"{$failOn}\". Expected none, info, warning, or critical.");
            return self::FAILURE;
        }

        $engine = $this->option('engine');
        if (is_string($engine) && trim($engine) !== '') {
            $normalizedEngine = JsonlTraceWriter::mapDriverToEngine($engine);
            if ($normalizedEngine === null || !in_array($normalizedEngine, self::ALLOWED_ENGINES, true)) {
                $this->error("Unsupported --engine \"{$engine}\". Expected postgresql, mysql, or sqlite.");
                return self::FAILURE;
            }
            $engine = $normalizedEngine;
        } else {
            $engine = null;
        }

        try {
            $basePath = $this->resolveBasePath();
            $fileOpt = $this->option('file');
            $dirOpt = $this->option('dir');
            $uriOpt = $this->option('uri');

            $spec = $this->buildCommandInvocation(
                action: $action,
                basePath: $basePath,
                defaultTracePath: $writer->getTracePath(),
                file: is_string($fileOpt) && trim($fileOpt) !== '' ? trim($fileOpt) : null,
                dir: is_string($dirOpt) && trim($dirOpt) !== '' ? trim($dirOpt) : null,
                uri: is_string($uriOpt) && trim($uriOpt) !== '' ? trim($uriOpt) : null,
                engine: $engine,
                thresholdN1: max(2, (int) $this->option('threshold-n1')),
                slowMs: max(1, (int) $this->option('slow-ms')),
                explainTop: max(0, min(25, (int) $this->option('explain-top'))),
                format: $format,
                failOn: $failOn,
                redact: !$this->option('no-redact'),
            );
        } catch (InvalidArgumentException $e) {
            $this->error($e->getMessage());
            return self::FAILURE;
        }

        $exitCode = $this->runSubprocess($spec['argv'], $basePath, $spec['env']);
        return $exitCode === 0 ? self::SUCCESS : self::FAILURE;
    }

    /**
     * Builds an argument-vector invocation (zero shell string concatenation).
     * Note: Explicit DSN passed via --uri is moved into subprocess env (`QUERY_AUTOPSY_URI`)
     * so database passwords do not appear in process listings (`ps`).
     *
     * @return array{argv: list<string>, env: array<string, string>}
     */
    public function buildCommandInvocation(
        string $action,
        string $basePath,
        string $defaultTracePath,
        ?string $file,
        ?string $dir,
        ?string $uri,
        ?string $engine,
        int $thresholdN1,
        int $slowMs,
        int $explainTop,
        string $format,
        string $failOn,
        bool $redact,
    ): array {
        if (!in_array($action, self::ALLOWED_ACTIONS, true)) {
            throw new InvalidArgumentException("Unsupported action: {$action}");
        }

        $argv = $this->resolveCliPrefix($basePath);
        $argv[] = $action;

        if ($action === 'trace') {
            $argv[] = '--file';
            $argv[] = $file ?? $defaultTracePath;
            $argv[] = '--threshold-n1';
            $argv[] = (string) max(2, $thresholdN1);
            $argv[] = '--slow-ms';
            $argv[] = (string) max(1, $slowMs);
            if ($explainTop > 0) {
                $argv[] = '--explain-top';
                $argv[] = (string) max(0, min(25, $explainTop));
            }
            if ($redact) {
                $argv[] = '--redact';
            }
        } else {
            if ($file !== null) {
                $argv[] = '--file';
                $argv[] = $file;
            } else {
                $argv[] = '--dir';
                $argv[] = $dir ?? $basePath . DIRECTORY_SEPARATOR . 'app';
            }
            if ($action === 'ci' && $redact) {
                $argv[] = '--redact';
            }
        }

        if ($engine !== null) {
            $argv[] = '--engine';
            $argv[] = $engine;
        }

        $argv[] = '--format';
        $argv[] = $format;

        if ($action !== 'check') {
            $argv[] = '--fail-on';
            $argv[] = $failOn;
        }

        $env = [];
        if ($uri !== null) {
            $env['QUERY_AUTOPSY_URI'] = $uri;
        }

        return [
            'argv' => $argv,
            'env' => $env,
        ];
    }

    /**
     * @return list<string>
     */
    private function resolveCliPrefix(string $basePath): array
    {
        $localBin = $basePath . DIRECTORY_SEPARATOR . 'node_modules' . DIRECTORY_SEPARATOR . '.bin' . DIRECTORY_SEPARATOR . 'query-autopsy';
        if (is_file($localBin) && is_executable($localBin)) {
            return [$localBin];
        }

        return ['npx', '--yes', '@query-autopsy/cli'];
    }

    private function resolveBasePath(): string
    {
        if (isset($this->laravel) && method_exists($this->laravel, 'basePath')) {
            /** @var string $path */
            $path = $this->laravel->basePath();
            return $path;
        }

        return getcwd() ?: '.';
    }

    /**
     * @param list<string> $argv
     * @param array<string, string> $extraEnv
     */
    private function runSubprocess(array $argv, string $cwd, array $extraEnv): int
    {
        $stdoutWriter = function (string $chunk): void {
            if (isset($this->output)) {
                $this->output->write($chunk);
            } else {
                echo $chunk;
            }
        };
        $stderrWriter = function (string $chunk): void {
            if (isset($this->output)) {
                $this->getOutput()->getErrorStyle()->write($chunk);
            } else {
                fwrite(STDERR, $chunk);
            }
        };

        if ($this->processRunner !== null) {
            return ($this->processRunner)($argv, $cwd, $extraEnv, $stdoutWriter, $stderrWriter);
        }

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];

        $mergedEnv = null;
        if ($extraEnv !== []) {
            $inherited = getenv();
            /** @var array<string, string> $currentEnv */
            $currentEnv = is_array($inherited)
                ? array_filter($inherited, static fn (mixed $v): bool => is_string($v))
                : array_filter($_ENV, static fn (mixed $v): bool => is_string($v));
            $mergedEnv = array_merge($currentEnv, $extraEnv);
        }

        $process = @proc_open($argv, $descriptors, $pipes, $cwd, $mergedEnv);
        if (!is_resource($process)) {
            $stderrWriter("Failed to start @query-autopsy/cli subprocess.\n");
            return 1;
        }

        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);

        $exitCode = proc_close($process);

        if (is_string($stdout) && $stdout !== '') {
            $stdoutWriter($stdout);
        }
        if (is_string($stderr) && $stderr !== '') {
            $stderrWriter($stderr);
        }

        return is_int($exitCode) ? $exitCode : 1;
    }
}
