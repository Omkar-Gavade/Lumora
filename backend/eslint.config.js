import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'scripts'] },
  {
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Discriminated-union narrowing makes this noisy without adding safety in
      // a codebase with no `any`. Matches the frontend's configuration.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false },
      ],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { boolean: true } },
      ],
      // A floating promise in a request handler is a request that never
      // answers and an error that never surfaces.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      /*
        docs/03-backend.md §6: "No console.log anywhere." Console output
        bypasses the logger's redaction rules, which is how a document's text
        or a bearer token ends up in a log aggregator. The one exception is
        the config loader, which must be able to report a fatal misconfiguration
        before a logger exists.
      */
      'no-console': 'error',
    },
  },

  /*
    docs/03-backend.md §5: "Nothing else in the codebase reads `process.env` —
    a lint rule forbids it outside this file, so every configuration value is
    typed and its existence is proven."

    Without this the Zod schema becomes advisory: someone reaches for
    `process.env.SOMETHING` in a service, it is `string | undefined`, and the
    fail-fast guarantee quietly stops being true.
  */
  {
    files: ['src/**/*.ts'],
    ignores: ['src/config/env.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration from src/config/index.ts. Only src/config/env.ts may touch process.env (docs/03-backend.md §5).',
        },
      ],
    },
  },

  /*
    docs/03-backend.md §1: "The rule that makes this real: services never
    import from `express`."

    Encoded now, while the folders are still empty. A boundary added after the
    code exists is a refactor; a boundary added before it is a constraint the
    code grows inside. The same applies downward — repositories own SQL and
    know nothing about HTTP, and providers know nothing about Lumora's domain.
  */
  {
    files: ['src/services/**/*.ts', 'src/repositories/**/*.ts', 'src/providers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'express',
              message:
                'Services, repositories, and providers must not depend on the HTTP layer (docs/03-backend.md §1). Take plain arguments; throw an AppError.',
            },
          ],
          patterns: [
            {
              group: ['**/api/**'],
              message:
                'Dependencies point one way: HTTP → Controller → Service → Repository (docs/03-backend.md §1).',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
