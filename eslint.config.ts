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
  {
    files: ['e2e/**/*.ts'],
    ignores: ['e2e/fixtures.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name=/^(delete|fetch|get|head|patch|post|put)$/]:matches([callee.object.name='request'], [callee.object.property.name='request'])",
          message:
            'Requests of an APIRequestContext go through getWithoutKeepAlive from e2e/fixtures.ts: a pooled keep-alive connection outlives the idle timeout of the daemon, which then resets the next request sent on it.',
        },
      ],
    },
  },
)
