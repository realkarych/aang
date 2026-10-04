import aang from '@aang/eslint-plugin'
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default defineConfig(
  {
    ignores: [
      '**/dist/',
      'coverage/',
      'test-results/',
      'playwright-report/',
      'blob-report/',
      'playwright/.cache/',
      'packages/hook/bin/',
      'docs/research/samples/',
      '.superpowers/',
    ],
  },
  {
    linterOptions: { noInlineConfig: true },
  },
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  {
    plugins: { aang },
    rules: { 'aang/dependency-direction': 'error', 'aang/esm-only': 'error' },
  },
)
