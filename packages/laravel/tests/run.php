<?php

declare(strict_types=1);

namespace Illuminate\Console {
    if (!class_exists(Command::class)) {
        abstract class Command
        {
            public const SUCCESS = 0;
            public const FAILURE = 1;

            protected mixed $laravel = null;
            protected mixed $output = null;

            /** @var array<string, mixed> */
            public array $capturedArguments = [];

            /** @var array<string, mixed> */
            public array $capturedOptions = [];

            /** @var list<string> */
            public array $errors = [];

            public function argument(string $key): mixed
            {
                return $this->capturedArguments[$key] ?? null;
            }

            public function option(string $key): mixed
            {
                return $this->capturedOptions[$key] ?? null;
            }

            public function error(string $message): void
            {
                $this->errors[] = $message;
            }
        }
    }
}

namespace Illuminate\Support {
    if (!class_exists(ServiceProvider::class)) {
        abstract class ServiceProvider
        {
            /** @var list<string> */
            public static array $registeredCommands = [];

            /** @var array<string, array<string, string>> */
            public static array $publishes = [];

            public function __construct(protected mixed $app)
            {
            }

            protected function mergeConfigFrom(string $path, string $key): void
            {
                $defaults = require $path;
                if (is_object($this->app) && method_exists($this->app, 'mergeConfig')) {
                    $this->app->mergeConfig($key, $defaults);
                }
            }

            /**
             * @param array<string, string> $paths
             */
            protected function publishes(array $paths, string $group): void
            {
                self::$publishes[$group] = $paths;
            }

            /**
             * @param list<class-string> $commands
             */
            protected function commands(array $commands): void
            {
                foreach ($commands as $cmd) {
                    self::$registeredCommands[] = $cmd;
                }
            }
        }
    }
}

namespace QueryAutopsy\Laravel\Tests {

    use DateTimeImmutable;
    use PDO;
    use QueryAutopsy\Laravel\Console\QueryAutopsyCommand;
    use QueryAutopsy\Laravel\EnvironmentGuard;
    use QueryAutopsy\Laravel\QueryAutopsyServiceProvider;
    use QueryAutopsy\Laravel\Trace\BindingSanitizer;
    use QueryAutopsy\Laravel\Trace\CallerLocator;
    use QueryAutopsy\Laravel\Trace\JsonlTraceWriter;
    use RuntimeException;

    $rootDir = dirname(__DIR__);
    require_once $rootDir . '/src/EnvironmentGuard.php';
    require_once $rootDir . '/src/Trace/BindingSanitizer.php';
    require_once $rootDir . '/src/Trace/CallerLocator.php';
    require_once $rootDir . '/src/Trace/JsonlTraceWriter.php';
    require_once $rootDir . '/src/Console/QueryAutopsyCommand.php';
    require_once $rootDir . '/src/QueryAutopsyServiceProvider.php';

    function assertTrue(bool $cond, string $message): void
    {
        if (!$cond) {
            throw new RuntimeException("Assertion failed: {$message}");
        }
    }

    function assertSame(mixed $expected, mixed $actual, string $message): void
    {
        if ($expected !== $actual) {
            throw new RuntimeException(
                "Assertion failed ({$message}): expected " .
                var_export($expected, true) .
                ', got ' .
                var_export($actual, true),
            );
        }
    }

    function removeDirRecursive(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $items = scandir($dir);
        if (!is_array($items)) {
            return;
        }
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $path = $dir . DIRECTORY_SEPARATOR . $item;
            if (is_link($path) || is_file($path)) {
                @unlink($path);
            } elseif (is_dir($path)) {
                removeDirRecursive($path);
            }
        }
        @rmdir($dir);
    }

    final class FakeConfigRepository
    {
        /** @var array<string, mixed> */
        private array $items = [];

        /** @param array<string, mixed> $defaults */
        public function merge(string $key, array $defaults): void
        {
            $existing = is_array($this->items[$key] ?? null) ? $this->items[$key] : [];
            $this->items[$key] = array_merge($defaults, $existing);
        }

        public function get(string $key, mixed $default = null): mixed
        {
            return $this->items[$key] ?? $default;
        }
    }

    final class FakeDbManager
    {
        /** @var list<callable> */
        public array $listeners = [];

        public function listen(callable $callback): void
        {
            $this->listeners[] = $callback;
        }

        public function emitQuery(string $sql, array $bindings, float $time, string $driver = 'pgsql'): void
        {
            $connection = new class($driver) {
                public function __construct(private readonly string $driver)
                {
                }

                public function getDriverName(): string
                {
                    return $this->driver;
                }
            };
            $event = (object) [
                'sql' => $sql,
                'bindings' => $bindings,
                'time' => $time,
                'connection' => $connection,
            ];
            foreach ($this->listeners as $listener) {
                $listener($event);
            }
        }
    }

    final class FakeEventsDispatcher
    {
        /** @var array<string, list<callable>> */
        public array $listeners = [];

        public function listen(string $event, callable $listener): void
        {
            $this->listeners[$event][] = $listener;
        }
    }

    final class FakeLaravelApp
    {
        public FakeConfigRepository $configRepo;
        public FakeDbManager $db;
        public FakeEventsDispatcher $events;

        /** @var list<callable> */
        public array $terminatingCallbacks = [];

        /** @var array<string, mixed> */
        private array $instances = [];

        private bool $dbResolved = false;

        /** @var list<callable> */
        private array $afterDbResolvers = [];

        public function __construct(
            private readonly string $env,
            private readonly string $basePathDir,
        ) {
            $this->configRepo = new FakeConfigRepository();
            $this->db = new FakeDbManager();
            $this->events = new FakeEventsDispatcher();
            $this->instances['config'] = $this->configRepo;
            $this->instances['events'] = $this->events;
        }

        /** @param array<string, mixed> $defaults */
        public function mergeConfig(string $key, array $defaults): void
        {
            $this->configRepo->merge($key, $defaults);
        }

        public function environment(string|array|null $check = null): string|bool
        {
            if ($check === null) {
                return $this->env;
            }
            if (is_array($check)) {
                return in_array($this->env, $check, true);
            }
            return $this->env === $check;
        }

        public function runningInConsole(): bool
        {
            return true;
        }

        public function basePath(string $suffix = ''): string
        {
            return $suffix === ''
                ? $this->basePathDir
                : $this->basePathDir . DIRECTORY_SEPARATOR . ltrim($suffix, '/');
        }

        public function configPath(string $file = ''): string
        {
            return $this->basePath('config/' . $file);
        }

        public function singleton(string $abstract, ?callable $factory = null): void
        {
            if ($factory === null) {
                $this->instances[$abstract] = new $abstract();
                return;
            }
            $this->instances[$abstract] = $factory($this);
        }

        public function bound(string $abstract): bool
        {
            return $abstract === 'db' || array_key_exists($abstract, $this->instances);
        }

        public function resolved(string $abstract): bool
        {
            if ($abstract === 'db') {
                return $this->dbResolved;
            }
            return array_key_exists($abstract, $this->instances);
        }

        public function afterResolving(string $abstract, callable $callback): void
        {
            if ($abstract === 'db') {
                $this->afterDbResolvers[] = $callback;
            }
        }

        public function make(string $abstract): mixed
        {
            if ($abstract === 'db') {
                if (!$this->dbResolved) {
                    $this->dbResolved = true;
                    foreach ($this->afterDbResolvers as $cb) {
                        $cb($this->db);
                    }
                }
                return $this->db;
            }

            if (!array_key_exists($abstract, $this->instances)) {
                $this->instances[$abstract] = new $abstract();
            }

            return $this->instances[$abstract];
        }

        public function terminating(callable $callback): void
        {
            $this->terminatingCallbacks[] = $callback;
        }
    }

    $tempRoot = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'qa-laravel-test-' . bin2hex(random_bytes(6));
    mkdir($tempRoot, 0755, true);

    try {
        // 1. Config loads cleanly outside Laravel container with secure defaults
        $config = require $rootDir . '/config/query-autopsy.php';
        assertSame(true, $config['redact_bindings'], 'redact_bindings default must be true');
        assertSame(false, $config['allow_production'], 'allow_production default must be false');
        assertSame(['local', 'testing'], $config['allowed_environments'], 'default allowed envs');

        // 2. EnvironmentGuard safety matrix
        assertSame(false, EnvironmentGuard::shouldEnable(true, false, 'production', ['local', 'testing']), 'production must always be blocked when allow_production=false');
        assertSame(false, EnvironmentGuard::shouldEnable(null, false, 'staging', ['local', 'testing']), 'staging disabled under auto mode');
        assertSame(true, EnvironmentGuard::shouldEnable(null, false, 'local', ['local', 'testing']), 'local enabled under auto mode');
        assertSame(true, EnvironmentGuard::shouldEnable(null, false, 'testing', ['local', 'testing']), 'testing enabled under auto mode');
        assertSame(false, EnvironmentGuard::shouldEnable(false, false, 'local', ['local', 'testing']), 'explicit disabled overrides local');

        // 3. BindingSanitizer scrubbing & typed scalar serialization
        $sanitizer = new BindingSanitizer();
        $scrubbedSql = $sanitizer->scrubSqlLiterals(
            "SELECT * FROM users WHERE email = 'alice@corp.com' AND note = 'O\\'Reilly' AND code = 'a''b' AND id = ?",
            true,
        );
        assertSame(
            "SELECT * FROM users WHERE email = '[REDACTED]' AND note = '[REDACTED]' AND code = '[REDACTED]' AND id = ?",
            $scrubbedSql,
            'inline SQL string literals must be redacted accurately',
        );
        assertSame([], $sanitizer->sanitizeBindings(['secret@corp.com', 42], true), 'redacted bindings omitted');
        $rawBindings = $sanitizer->sanitizeBindings([42, new DateTimeImmutable('2026-11-20T12:00:00+00:00'), str_repeat('x', 300), fopen('php://memory', 'rb')], false);
        assertSame(42, $rawBindings[0], 'int binding preserved when redaction disabled');
        assertSame('2026-11-20T12:00:00+00:00', $rawBindings[1], 'DateTimeInterface formatted to ATOM');
        assertTrue(str_ends_with((string) $rawBindings[2], '...(truncated)'), 'long string binding bounded');
        assertSame('[NON_SCALAR]', $rawBindings[3], 'resource binding masked cleanly');

        // 4. JsonlTraceWriter capture, ignore patterns, symlink protection, and rotation
        $tracePath = $tempRoot . DIRECTORY_SEPARATOR . 'project' . DIRECTORY_SEPARATOR . '.query-autopsy' . DIRECTORY_SEPARATOR . 'traces.jsonl';
        mkdir($tempRoot . DIRECTORY_SEPARATOR . 'project', 0755, true);

        $writer = new JsonlTraceWriter(
            tracePath: $tracePath,
            redactBindings: true,
            maxTraceBytes: 4096,
            maxBufferEntries: 50,
            ignorePatterns: ['migrations', 'horizon_%'],
            basePath: $tempRoot . DIRECTORY_SEPARATOR . 'project',
        );
        $writer->setRequestId("req-abc\nINJECTED");
        assertSame('req-abcINJECTED', $writer->getRequestId(), 'newline characters stripped from requestId');

        $writer->record('SELECT * FROM migrations', [], 1.2, 'pgsql');
        $writer->record("SELECT * FROM users WHERE email = 'bob@corp.com'", ['bob@corp.com'], 6.42, 'pgsql', ['file' => 'app/Http/Controllers/UserController.php', 'line' => 27]);
        assertSame(1, $writer->getBufferedCount(), 'migrations query ignored cleanly');
        $writer->flush();

        assertTrue(file_exists($tracePath), 'trace file created on flush');
        $gitignore = file_get_contents(dirname($tracePath) . DIRECTORY_SEPARATOR . '.gitignore');
        assertTrue(is_string($gitignore) && str_contains($gitignore, '*.jsonl'), '.query-autopsy/.gitignore created automatically');

        $lines = file($tracePath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        assertTrue(is_array($lines) && count($lines) === 1, 'exactly 1 flushed line');
        $decoded = json_decode((string) $lines[0], true);
        assertTrue(is_array($decoded), 'flushed line is valid JSON');
        assertSame('postgresql', $decoded['engine'], 'pgsql mapped to postgresql');
        assertSame("SELECT * FROM users WHERE email = '[REDACTED]'", $decoded['sql'], 'SQL literals scrubbed before flush');
        assertSame([], $decoded['bindings'], 'bindings redacted on flush');
        assertSame('app/Http/Controllers/UserController.php', $decoded['file'], 'caller file captured');
        assertSame(27, $decoded['line'], 'caller line captured');

        // Anti-symlink overwrite test
        $symlinkDir = $tempRoot . DIRECTORY_SEPARATOR . 'symlink-project' . DIRECTORY_SEPARATOR . '.query-autopsy';
        mkdir($symlinkDir, 0755, true);
        $outsideFile = $tempRoot . DIRECTORY_SEPARATOR . 'outside.txt';
        file_put_contents($outsideFile, 'keep');
        symlink($outsideFile, $symlinkDir . DIRECTORY_SEPARATOR . 'traces.jsonl');
        $symlinkWriter = new JsonlTraceWriter($symlinkDir . DIRECTORY_SEPARATOR . 'traces.jsonl');
        $symlinkWriter->record('SELECT 1', [], 1.0, 'sqlite');
        $threwOnSymlink = false;
        try {
            $symlinkWriter->flush();
        } catch (RuntimeException) {
            $threwOnSymlink = true;
        }
        assertTrue($threwOnSymlink, 'JsonlTraceWriter must refuse writing to a symlink trace file');

        // Log rotation test beyond maxTraceBytes (min clamped to 4096 bytes)
        $rotateTracePath = $tempRoot . DIRECTORY_SEPARATOR . 'rotate' . DIRECTORY_SEPARATOR . '.query-autopsy' . DIRECTORY_SEPARATOR . 'traces.jsonl';
        $rotateWriter = new JsonlTraceWriter($rotateTracePath, true, 4096, 100);
        for ($i = 0; $i < 35; $i++) {
            $rotateWriter->record("SELECT id, payload_{$i} FROM big_audit_table WHERE idx = ?", [$i], 2.0, 'mysql');
        }
        $rotateWriter->flush();
        $rotateWriter->record('SELECT 999', [], 1.0, 'mysql');
        $rotateWriter->flush();
        assertTrue(file_exists($rotateTracePath . '.1'), 'oversized traces.jsonl rotated to traces.jsonl.1');

        // 5. QueryAutopsyServiceProvider zero overhead in production vs auto hook in local
        $prodProject = $tempRoot . DIRECTORY_SEPARATOR . 'prod-app';
        mkdir($prodProject, 0755, true);
        $prodApp = new FakeLaravelApp('production', $prodProject);
        $prodProvider = new QueryAutopsyServiceProvider($prodApp);
        $prodProvider->register();
        $prodProvider->boot();
        $prodApp->make('db')->emitQuery('SELECT * FROM secrets', [], 5.0, 'pgsql');
        assertSame(false, $prodProvider->isCollectionEnabled(), 'production app must disable trace collection');
        assertSame(0, count($prodApp->db->listeners), 'production app must attach ZERO db listeners');

        $localProject = $tempRoot . DIRECTORY_SEPARATOR . 'local-app';
        mkdir($localProject, 0755, true);
        $localApp = new FakeLaravelApp('local', $localProject);
        $localProvider = new QueryAutopsyServiceProvider($localApp);
        $localProvider->register();
        $localProvider->boot();
        assertSame(true, $localProvider->isCollectionEnabled(), 'local app enables trace collection automatically');
        // Resolve lazy 'db' binding now -> afterResolving attaches listener without eager boot
        $localApp->make('db')->emitQuery("SELECT * FROM orders WHERE email = 'dev@local.test'", ['dev@local.test'], 14.5, 'pgsql');
        foreach ($localApp->terminatingCallbacks as $cb) {
            $cb();
        }
        $localTraceFile = $localProject . DIRECTORY_SEPARATOR . '.query-autopsy' . DIRECTORY_SEPARATOR . 'traces.jsonl';
        assertTrue(file_exists($localTraceFile), 'local terminating hook flushes DB::listen events to .query-autopsy/traces.jsonl');
        $localTraceContent = (string) file_get_contents($localTraceFile);
        assertTrue(!str_contains($localTraceContent, 'dev@local.test'), 'local trace content must scrub PII');

        // 6. QueryAutopsyCommand safe argv + env-isolated DSN + validation
        $cmd = new QueryAutopsyCommand();
        $inv = $cmd->buildCommandInvocation(
            action: 'trace',
            basePath: $localProject,
            defaultTracePath: $localTraceFile,
            file: null,
            dir: null,
            uri: 'postgresql://user:supersecret@127.0.0.1:5432/app',
            engine: 'postgresql',
            thresholdN1: 4,
            slowMs: 150,
            explainTop: 2,
            format: 'sarif',
            failOn: 'warning',
            redact: true,
        );
        assertTrue(!in_array('postgresql://user:supersecret@127.0.0.1:5432/app', $inv['argv'], true), 'DSN password must NOT appear in CLI argv');
        assertSame('postgresql://user:supersecret@127.0.0.1:5432/app', $inv['env']['QUERY_AUTOPSY_URI'], 'DSN forwarded securely in child process env');
        assertTrue(in_array('--redact', $inv['argv'], true), '--redact enabled by default in Artisan wrapper');
        assertTrue(in_array('--explain-top', $inv['argv'], true), '--explain-top forwarded cleanly');

        // Reject invalid Artisan inputs
        $cmd->capturedArguments = ['action' => 'drop_db'];
        $cmd->capturedOptions = ['format' => 'json', 'fail-on' => 'none', 'engine' => null, 'threshold-n1' => '3', 'slow-ms' => '200', 'explain-top' => '0', 'no-redact' => false];
        assertSame(QueryAutopsyCommand::FAILURE, $cmd->handle($localApp->make(JsonlTraceWriter::class)), 'disallowed action rejected cleanly');

        // 7. Real SQLite PDO N+1 trace generation sanity check
        $pdo = new PDO('sqlite::memory:');
        $pdo->exec('CREATE TABLE items (id INTEGER PRIMARY KEY, order_id INTEGER, name TEXT)');
        $pdo->exec("INSERT INTO items (order_id, name) VALUES (1, 'A'), (1, 'B'), (2, 'C')");
        $pdoTraceFile = $tempRoot . DIRECTORY_SEPARATOR . 'pdo-n1.jsonl';
        $pdoWriter = new JsonlTraceWriter($pdoTraceFile, true);
        $pdoWriter->setRequestId('req-pdo-1');
        foreach ([1, 2, 1, 2] as $orderId) {
            $t0 = hrtime(true);
            $stmt = $pdo->prepare('SELECT id, name FROM items WHERE order_id = ?');
            $stmt->execute([$orderId]);
            $stmt->fetchAll(PDO::FETCH_ASSOC);
            $elapsedMs = (hrtime(true) - $t0) / 1_000_000;
            $pdoWriter->record('SELECT id, name FROM items WHERE order_id = ?', [$orderId], $elapsedMs, 'sqlite');
        }
        $pdoWriter->flush();
        $pdoLines = file($pdoTraceFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        assertTrue(is_array($pdoLines) && count($pdoLines) === 4, 'real SQLite PDO N+1 trace flushed 4 entries');

        echo "LARAVEL_BRIDGE_PHP_TESTS_OK\n";
    } finally {
        removeDirRecursive($tempRoot);
    }
}
