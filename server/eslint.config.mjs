// Server ESLint config: the shared root config plus Node-specific globals.
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { baseConfig } from '../eslint.config.mjs';

export default tseslint.config(
  ...baseConfig,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
      sourceType: 'module',
    },
  },
  {
    // Seeds and one-off scripts are CLI tools — printing to stdout is the point.
    files: ['prisma/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
