// Shared root-level ESLint configuration.
// Both workspaces import `baseConfig` from here and append their own
// environment-specific rules (see client/eslint.config.mjs, server/eslint.config.mjs).
import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/** Paths that never need linting, in any workspace. */
export const ignores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.vite/**',
  '**/generated/**',
];

/** Rules shared by every workspace. Keep this list small and non-stylistic —
 *  formatting is Prettier's job (eslint-config-prettier turns the rest off). */
export const baseConfig = tseslint.config(
  { ignores },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  prettierConfig,
);

export default baseConfig;
