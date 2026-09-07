// Shared root-level Prettier configuration.
// Both workspaces re-export this file so `prettier` picks up identical
// formatting whether it is run from the repo root or from inside a workspace.
/** @type {import("prettier").Config} */
const config = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  arrowParens: 'always',
  endOfLine: 'lf',
};

export default config;
