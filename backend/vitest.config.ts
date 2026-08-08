import { defineConfig } from 'vitest/config';

/**
 * Two projects, because unit and integration tests have opposite requirements.
 *
 * **unit** touches no database and no socket, so it runs fully parallel — that
 * is what keeps the fast feedback loop fast.
 *
 * **integration** shares one Postgres database and truncates between tests, so
 * file-level parallelism is disabled. Two files truncating each other's rows
 * mid-request is the classic source of a suite that passes locally and fails
 * in CI, and no amount of retry logic fixes it. Per-worker schemas would allow
 * parallelism here; that is a real option if the suite ever gets slow enough
 * to justify the complexity, and it is not close yet.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['./tests/setup/setup-env.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['./tests/setup/setup-env.ts', './tests/setup/setup-integration.ts'],
          globalSetup: ['./tests/setup/global-setup.ts'],

          /*
            One fork, files run one at a time.

            The integration project shares a single Postgres database and
            truncates between tests, so two files in flight at once means one
            of them deletes `users` rows while the other's request is midway
            through issuing a refresh token — surfacing as a foreign-key
            violation and a 500 in a test that has nothing to do with either.

            `singleFork` rather than the root-level `fileParallelism: false`,
            because that option is only honoured at the root and would
            serialize the unit project too — which needs no database and has
            no reason to be slow.
          */
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          /*
            Argon2id at production parameters costs ~50ms per hash, and a
            signup test pays it twice. The default 5s is enough until a machine
            is loaded; 20s removes the class of failure where CI is slow rather
            than broken. Deliberately not achieved by weakening the hash — a
            test that exercises different parameters than production is testing
            something that does not ship.
          */
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        // Process lifecycle: signal handlers, listen, graceful shutdown. Only
        // meaningfully exercised by starting and killing a real process.
        'src/server.ts',
        // A CLI entry point that calls `process.exit`.
        'src/db/migrate.ts',
        // Type-only.
        'src/db/schema.d.ts',
        'src/types/**',
      ],
      /*
        Set just below what the suite currently achieves (87/88/90/88), so
        they are a ratchet rather than decoration.

        A threshold well under the real number protects nothing — code can be
        added untested for months before it trips. A threshold set *at* the
        current number fails on an unrelated refactor that happens to remove a
        covered line. A couple of points of headroom is the difference between
        a guard and an annoyance.
      */
      thresholds: {
        statements: 85,
        lines: 85,
        functions: 88,
        branches: 85,
      },
    },
  },
});
