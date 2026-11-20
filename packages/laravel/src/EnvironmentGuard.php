<?php

declare(strict_types=1);

namespace QueryAutopsy\Laravel;

final class EnvironmentGuard
{
    /**
     * Determines whether QueryAutopsy DB::listen() hooks may attach.
     * Enforces zero impact in production by default even if misconfigured.
     *
     * @param list<string> $allowedEnvironments
     */
    public static function shouldEnable(
        mixed $enabledSetting,
        bool $allowProduction,
        string $currentEnvironment,
        array $allowedEnvironments = ['local', 'testing'],
    ): bool {
        if ($currentEnvironment === 'production' && !$allowProduction) {
            return false;
        }

        if ($enabledSetting !== null && $enabledSetting !== '') {
            if (is_bool($enabledSetting)) {
                return $enabledSetting;
            }

            if (is_string($enabledSetting)) {
                $parsed = filter_var($enabledSetting, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
                if ($parsed !== null) {
                    return $parsed;
                }
            }
        }

        return in_array($currentEnvironment, $allowedEnvironments, true);
    }
}
