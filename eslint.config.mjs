import tseslint from 'typescript-eslint'

// Ported from the AllisonIPTV desktop app's own eslint.config.mjs — deliberately minimal, not
// a general style-linting pass. no-floating-promises/no-misused-promises are the one rule pair
// that caught a real crash there (a Promise-returning Electron API call fired fire-and-forget,
// becoming an unhandled rejection that crashed the main process) — this server has the exact
// same shape of risk (Express handlers, child_process/fs promises), so it's worth carrying
// forward rather than re-deriving the same lesson the hard way a second time.
  //
  // `no-duplicate-case` and `no-unreachable` were added on 2026-09-20 after a second class of miss:
  // a conversion branch pasted *below* an existing `case` in the same switch. JavaScript dispatches to
  // the first matching label, so it was unreachable dead code — and it type-checked, linted and passed
  // all 447 tests, because this config carried only the two promise rules and so had no opinion on it.
  // A minimal config is still a config that should catch code which cannot run. Verified zero-violation
  // across `src/` before enabling.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  {
    files: ['src/server/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error'
    }
  },
  {
    files: ['src/client/src/**/*.ts', 'src/client/src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.client.json', tsconfigRootDir: import.meta.dirname }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      'no-duplicate-case': 'error',
      'no-unreachable': 'error'
    }
  }
)
