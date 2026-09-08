import tseslint from 'typescript-eslint'

// Ported from the AllisonIPTV desktop app's own eslint.config.mjs — deliberately minimal, not
// a general style-linting pass. no-floating-promises/no-misused-promises are the one rule pair
// that caught a real crash there (a Promise-returning Electron API call fired fire-and-forget,
// becoming an unhandled rejection that crashed the main process) — this server has the exact
// same shape of risk (Express handlers, child_process/fs promises), so it's worth carrying
// forward rather than re-deriving the same lesson the hard way a second time.
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
      '@typescript-eslint/no-misused-promises': 'error'
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
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }]
    }
  }
)
