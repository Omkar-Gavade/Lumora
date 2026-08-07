import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.app.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Without this the rule cannot see that <Checkbox> renders an <input>,
      // and reports every correctly-wrapped label as unassociated.
      'jsx-a11y/label-has-associated-control': [
        'error',
        { controlComponents: ['Checkbox', 'Input', 'PasswordInput'], depth: 3 },
      ],

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Discriminated-union narrowing makes these noisy without adding safety
      // in a codebase with no `any`.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false },
      ],
      // `onClick={() => setOpen(true)}` is the idiomatic React form; requiring
      // a braced body on every handler adds noise without catching bugs.
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // `??` is not a drop-in for `||` on booleans: `disabled || loading` must
      // be true when either is true, whereas `disabled ?? loading` ignores
      // `loading` whenever `disabled` is `false`. Applying the rule to booleans
      // silently inverts the logic it claims to make safer.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { boolean: true } },
      ],

      /*
        Design-system guardrails. These are the rules that keep the token layer
        from eroding: an arbitrary value is either a gap in the scale that should
        be fixed deliberately, or a mistake. A few intentional one-offs are
        allowed via an inline disable with a comment explaining why.
      */
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'JSXAttribute[name.name="className"] Literal[value=/(?:^|\\s)(?:bg|text|border|fill|stroke|ring|outline|shadow|from|to|via)-\\[#[0-9a-fA-F]{3,8}\\]/]',
          message:
            'No hex literals in classNames. Add a semantic token in globals.css and use it.',
        },
        {
          selector:
            'JSXAttribute[name.name="className"] Literal[value=/(?:^|\\s)(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|space-[xy])-\\[/]',
          message:
            'No arbitrary spacing. Use the 4px scale; extend it in globals.css if a step is genuinely missing.',
        },
      ],
    },
  },
  /*
    Auth screens autofocus their first field, deliberately.

    `jsx-a11y/no-autofocus` is correct as a general rule — autofocus on an
    arbitrary element inside a content page teleports a screen-reader user past
    everything above it. These screens are the exception the rule exists around:
    each renders one form and nothing else, so the first field IS the start of
    the page, and skipping the focus costs every keyboard user a tab press on a
    screen whose only purpose is typing. Scoped to this directory so the rule
    still applies everywhere else.
  */
  {
    files: ['src/pages/auth/**/*.tsx'],
    rules: { 'jsx-a11y/no-autofocus': 'off' },
  },
  // Config files and the token scripts legitimately contain raw values.
  {
    files: ['vite.config.ts', 'eslint.config.js', 'scripts/**'],
    ...tseslint.configs.disableTypeChecked,
  },
);
