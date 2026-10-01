import { afterAll, beforeAll, describe, test } from 'vitest'
import { createLintWorkspace, type Findings, type LintWorkspace } from './lint.js'

interface DirectionCase {
  readonly name: string
  readonly path: string
  readonly code: readonly string[]
  readonly errors: readonly (readonly [line: number, message: string])[]
}

const daemonDependencies =
  '@aang/contract, @aang/store, @aang/collector, @aang/adapter-claude, @aang/adapter-codex, @aang/engine, @aang/observer, @aang/hook'

const violations: readonly DirectionCase[] = [
  {
    name: 'engine product code may not import an adapter',
    path: 'packages/engine/src/registry.ts',
    code: ["import '@aang/adapter-claude'"],
    errors: [[1, '@aang/engine product code may not import @aang/adapter-claude; allowed: @aang/contract, @aang/store']],
  },
  {
    name: 'store product code may not import engine against the direction',
    path: 'packages/store/src/journal.ts',
    code: ["import '@aang/engine'"],
    errors: [[1, '@aang/store product code may not import @aang/engine; allowed: @aang/contract']],
  },
  {
    name: 'contract product code may not import any package, subpaths included',
    path: 'packages/contract/src/schema.ts',
    code: ["import '@aang/store'", "import '@aang/web/client'"],
    errors: [
      [1, '@aang/contract product code may not import @aang/store; allowed: none'],
      [2, '@aang/contract product code may not import @aang/web; allowed: none'],
    ],
  },
  {
    name: 'web product code may not import daemon',
    path: 'packages/web/src/app.ts',
    code: ["import '@aang/daemon'"],
    errors: [[1, '@aang/web product code may not import @aang/daemon; allowed: @aang/contract']],
  },
  {
    name: 'daemon product code may not import cli',
    path: 'packages/daemon/src/compose.ts',
    code: ["import '@aang/cli'"],
    errors: [[1, `@aang/daemon product code may not import @aang/cli; allowed: ${daemonDependencies}`]],
  },
  {
    name: 'cli product code may not import testkit',
    path: 'packages/cli/src/main.ts',
    code: ["import '@aang/testkit'"],
    errors: [[1, '@aang/cli product code may not import @aang/testkit; allowed: @aang/contract, @aang/hook']],
  },
  {
    name: 'a relative import from engine into store is reported although engine may depend on store',
    path: 'packages/engine/src/ingest.ts',
    code: ["import '../../store/src/index.js'"],
    errors: [
      [
        1,
        "@aang/engine product code may not reach @aang/store through the relative path '../../store/src/index.js'; import other packages by name; allowed: @aang/contract, @aang/store",
      ],
    ],
  },
  {
    name: 'a relative import leaving the packages directory is reported',
    path: 'packages/cli/src/checker.ts',
    code: ["import '../../../tools/check-comments/src/main.js'"],
    errors: [
      [
        1,
        "@aang/cli product code may not reach tools/check-comments/src/main.js through the relative path '../../../tools/check-comments/src/main.js'; import other packages by name; allowed: @aang/contract, @aang/hook",
      ],
    ],
  },
  {
    name: 'tests may not import their own package source or build output by a relative path',
    path: 'packages/engine/test/relative.test.ts',
    code: ["import '../src/index.js'", "import '../dist/index.js'"],
    errors: [
      [
        1,
        "@aang/engine test code may not reach packages/engine/src/index.js through the relative path '../src/index.js'; import @aang/engine by name",
      ],
      [
        2,
        "@aang/engine test code may not reach packages/engine/dist/index.js through the relative path '../dist/index.js'; import @aang/engine by name",
      ],
    ],
  },
  {
    name: 'package-root configs may not import their own package source by a relative path',
    path: 'packages/web/vite.config.ts',
    code: ["import './src/app.js'"],
    errors: [
      [
        1,
        "@aang/web test code may not reach packages/web/src/app.js through the relative path './src/app.js'; import @aang/web by name",
      ],
    ],
  },
  {
    name: 'relative paths are resolved like module URLs: backslashes, percent-encoding and queries',
    path: 'packages/engine/src/disguised.ts',
    code: [
      "import './..\\\\..\\\\adapter-claude/dist/index.js'",
      "import './%2e%2e/%2e%2e/%61dapter-codex/dist/index.js'",
      "import '../../store/dist/index.js?/../../../engine/src/index.js'",
    ],
    errors: [
      [
        1,
        "@aang/engine product code may not reach @aang/adapter-claude through the relative path './..\\..\\adapter-claude/dist/index.js'; import other packages by name; allowed: @aang/contract, @aang/store",
      ],
      [
        2,
        "@aang/engine product code may not reach @aang/adapter-codex through the relative path './%2e%2e/%2e%2e/%61dapter-codex/dist/index.js'; import other packages by name; allowed: @aang/contract, @aang/store",
      ],
      [
        3,
        "@aang/engine product code may not reach @aang/store through the relative path '../../store/dist/index.js?/../../../engine/src/index.js'; import other packages by name; allowed: @aang/contract, @aang/store",
      ],
    ],
  },
  {
    name: 'tests may not reach their own package source or build output through backslash paths',
    path: 'packages/engine/test/backslash.test.ts',
    code: ["import './..\\\\src\\\\index.js'", "import '..\\\\dist\\\\index.js'"],
    errors: [
      [
        1,
        "@aang/engine test code may not reach packages/engine/src/index.js through the relative path './..\\src\\index.js'; import @aang/engine by name",
      ],
      [
        2,
        "@aang/engine test code may not reach packages/engine/dist/index.js through the relative path '..\\dist\\index.js'; import @aang/engine by name",
      ],
    ],
  },
  {
    name: 'require and require.resolve created by createRequire are checked, including aliases',
    path: 'packages/engine/src/loader.ts',
    code: [
      "import { createRequire } from 'node:module'",
      '',
      'const require = createRequire(import.meta.url)',
      'const load = require',
      "require('../../adapter-claude/dist/index.js')",
      "require.resolve('@aang/adapter-codex')",
      "load('@aang/daemon')",
      "createRequire(import.meta.url)('@aang/observer')",
    ],
    errors: [
      [
        5,
        "@aang/engine product code may not reach @aang/adapter-claude through the relative path '../../adapter-claude/dist/index.js'; import other packages by name; allowed: @aang/contract, @aang/store",
      ],
      [6, '@aang/engine product code may not import @aang/adapter-codex; allowed: @aang/contract, @aang/store'],
      [7, '@aang/engine product code may not import @aang/daemon; allowed: @aang/contract, @aang/store'],
      [8, '@aang/engine product code may not import @aang/observer; allowed: @aang/contract, @aang/store'],
    ],
  },
  {
    name: 'createRequire is recognized when renamed or reached as a module member',
    path: 'packages/store/src/loader.ts',
    code: [
      "import { createRequire as makeRequire } from 'node:module'",
      '',
      "makeRequire(import.meta.url).resolve('@aang/engine')",
      "process.getBuiltinModule('node:module').createRequire(import.meta.url)('@aang/engine/journal')",
    ],
    errors: [
      [3, '@aang/store product code may not import @aang/engine; allowed: @aang/contract'],
      [4, '@aang/store product code may not import @aang/engine; allowed: @aang/contract'],
    ],
  },
  {
    name: 'import.meta.resolve is checked',
    path: 'packages/web/src/locate.ts',
    code: ["export const daemon = import.meta.resolve('@aang/daemon')"],
    errors: [[1, '@aang/web product code may not import @aang/daemon; allowed: @aang/contract']],
  },
  {
    name: 'the CommonJS require is checked, including backslash package specifiers',
    path: 'packages/cli/src/legacy.cjs',
    code: ["require('@aang\\\\daemon')", "require.resolve('../../web/src/index.js')"],
    errors: [
      [1, '@aang/cli product code may not import @aang/daemon; allowed: @aang/contract, @aang/hook'],
      [
        2,
        "@aang/cli product code may not reach @aang/web through the relative path '../../web/src/index.js'; import other packages by name; allowed: @aang/contract, @aang/hook",
      ],
    ],
  },
  {
    name: 'a type-only import is checked',
    path: 'packages/observer/src/session.ts',
    code: ["import type { Session } from '@aang/daemon'", '', 'export type ObservedSession = Session'],
    errors: [
      [1, '@aang/observer product code may not import @aang/daemon; allowed: @aang/contract, @aang/store, @aang/engine'],
    ],
  },
  {
    name: 'named and star re-exports are checked',
    path: 'packages/hook/src/install.ts',
    code: ["export { install } from '@aang/cli'", "export * from '@aang/store'"],
    errors: [
      [1, '@aang/hook product code may not import @aang/cli; allowed: @aang/contract'],
      [2, '@aang/hook product code may not import @aang/store; allowed: @aang/contract'],
    ],
  },
  {
    name: 'dynamic imports with a string or a plain template literal are checked',
    path: 'packages/collector/src/lazy.ts',
    code: ["export const loadEngine = () => import('@aang/engine')", 'export const loadObserver = () => import(`@aang/observer`)'],
    errors: [
      [1, '@aang/collector product code may not import @aang/engine; allowed: @aang/contract'],
      [2, '@aang/collector product code may not import @aang/observer; allowed: @aang/contract'],
    ],
  },
  {
    name: 'type-level import() is checked',
    path: 'packages/web/src/api.ts',
    code: ["export type Daemon = typeof import('@aang/daemon')"],
    errors: [[1, '@aang/web product code may not import @aang/daemon; allowed: @aang/contract']],
  },
  {
    name: 'engine tests may not import packages beyond adapters and testkit',
    path: 'packages/engine/test/daemon.test.ts',
    code: ["import '@aang/daemon'"],
    errors: [
      [
        1,
        '@aang/engine test code may not import @aang/daemon; allowed: @aang/contract, @aang/store, @aang/testkit, @aang/adapter-claude, @aang/adapter-codex',
      ],
    ],
  },
  {
    name: 'tests of other packages may not import adapters',
    path: 'packages/observer/test/adapter.test.ts',
    code: ["import '@aang/adapter-codex'"],
    errors: [
      [
        1,
        '@aang/observer test code may not import @aang/adapter-codex; allowed: @aang/contract, @aang/store, @aang/engine, @aang/testkit',
      ],
    ],
  },
  {
    name: 'a package directory missing from the dependency table is reported',
    path: 'packages/extra/src/index.ts',
    code: ['export {}'],
    errors: [[1, 'packages/extra is not in the ADR-0011 dependency table']],
  },
]

const allowed: readonly DirectionCase[] = [
  {
    name: 'engine tests may import both adapters and testkit',
    path: 'packages/engine/test/adapters.test.ts',
    code: ["import '@aang/adapter-claude'", "import '@aang/adapter-codex'", "import '@aang/testkit'"],
    errors: [],
  },
  {
    name: 'observer product code may import engine, store, contract and external modules',
    path: 'packages/observer/src/plan.ts',
    code: ["import 'node:path'", "import '@aang/contract'", "import '@aang/store'", "import '@aang/engine'"],
    errors: [],
  },
  {
    name: 'daemon product code may import hook',
    path: 'packages/daemon/src/hooks.ts',
    code: ["import '@aang/hook'"],
    errors: [],
  },
  {
    name: 'daemon tests may import testkit',
    path: 'packages/daemon/test/start.test.ts',
    code: ["import '@aang/testkit'"],
    errors: [],
  },
  {
    name: 'a package may import its own name and subpaths',
    path: 'packages/store/src/self.ts',
    code: ["import '@aang/store'", "import '@aang/store/migrations'"],
    errors: [],
  },
  {
    name: 'relative imports inside one package are allowed',
    path: 'packages/engine/src/scope.ts',
    code: ["import './index.js'", "import '../src/index.js'", "import '..'"],
    errors: [],
  },
  {
    name: 'relative paths with backslashes or encoded separators inside the package are allowed',
    path: 'packages/engine/src/inner.ts',
    code: ["import '.\\\\index.js'", "import './%2F..'"],
    errors: [],
  },
  {
    name: 'createRequire loaders may load allowed packages and their own package files',
    path: 'packages/observer/src/require.ts',
    code: [
      "import { createRequire } from 'node:module'",
      '',
      'const require = createRequire(import.meta.url)',
      "require('@aang/engine')",
      "require.resolve('./index.js')",
    ],
    errors: [],
  },
  {
    name: 'dynamic imports and loaders with a computed specifier are not checked',
    path: 'packages/cli/src/plugins.ts',
    code: [
      "import { createRequire } from 'node:module'",
      '',
      'export const load = (specifier: string) => import(specifier)',
      'export const loadSync = (specifier: string): unknown => createRequire(import.meta.url)(specifier)',
    ],
    errors: [],
  },
  {
    name: 'functions that are not module loaders are not checked',
    path: 'packages/contract/src/callbacks.ts',
    code: [
      "export const call = (require: (id: string) => unknown): unknown => require('@aang/daemon')",
      "export const lookup = (cache: Map<string, unknown>): unknown => cache.get('@aang/store')",
      "export const curried = (make: () => () => (id: string) => unknown): unknown => make()()('@aang/daemon')",
    ],
    errors: [],
  },
  {
    name: 'tests may import sibling test helpers by a relative path',
    path: 'packages/engine/test/scenario.test.ts',
    code: ["import './helpers.js'", "import '../test/fixtures/session.js'"],
    errors: [],
  },
  {
    name: 'e2e tests outside packages are not checked',
    path: 'e2e/smoke.ts',
    code: ["import '@aang/daemon'", "import '../packages/store/src/index.js'"],
    errors: [],
  },
  {
    name: 'tools outside packages are not checked',
    path: 'tools/helper/src/index.ts',
    code: ["import '@aang/daemon'"],
    errors: [],
  },
]

describe('the repository ESLint configuration enforces the ADR-0011 dependency direction', () => {
  const cases = [...violations, ...allowed]
  let workspace: LintWorkspace | undefined
  let findings: Findings | undefined

  beforeAll(async () => {
    workspace = await createLintWorkspace(
      Object.fromEntries(cases.map((row) => [row.path, `${row.code.join('\n')}\n`])),
    )
    findings = await workspace.lint()
  }, 120_000)

  afterAll(async () => {
    await workspace?.remove()
  })

  test.for(cases)('$name', (row, { expect }) => {
    expect(findings?.get(row.path)).toEqual(
      row.errors.map(([line, message]) => ({ ruleId: 'aang/dependency-direction', line, message })),
    )
  })

  test('running ESLint from a package directory gives the same findings as from the root', async ({ expect }) => {
    const packageDirectory = 'packages/engine'
    const fromRoot = [...(findings ?? [])].filter(([path]) => path.startsWith(`${packageDirectory}/`))

    const fromPackage = await workspace?.lint(packageDirectory)

    expect(fromRoot.some(([, messages]) => messages.length > 0)).toBe(true)
    expect(fromPackage).toEqual(new Map(fromRoot))
  }, 120_000)
})

test('files outside a pnpm workspace are not checked', async ({ expect, onTestFinished }) => {
  const path = 'packages/engine/src/registry.ts'
  const outside = await createLintWorkspace({ [path]: "import '@aang/adapter-claude'\n" }, { pnpmWorkspace: false })
  onTestFinished(() => outside.remove())

  const findings = await outside.lint()

  expect(findings.get(path)).toEqual([])
}, 120_000)
