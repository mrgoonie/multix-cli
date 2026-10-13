/**
 * Per-test timeout for smoke tests that spawn `node`. Cold starts on slow CI
 * runners (notably Windows) and under a parallel full-suite run can exceed
 * vitest's 5 s default, so smoke suites set this on their `describe` blocks
 * instead of raising `testTimeout` for the unit tests.
 */
export const SPAWN_TIMEOUT = 30_000;

/** Kill a spawned child shortly before the test times out, so it never outlives the test. */
export const CHILD_TIMEOUT = SPAWN_TIMEOUT - 1_000;
