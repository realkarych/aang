import { afterAll, beforeAll, describe, test } from 'vitest'
import { createLintWorkspace, type Findings, type LintWorkspace } from './lint.js'

interface DirectionCase {
  readonly name: string
  readonly path: string
  readonly code: readonly string[]
  readonly errors: readonly (readonly [line: number, message: string])[]
}

const daemonDependencies =
  '@catacomb/contract, @catacomb/store, @catacomb/collector, @catacomb/adapter-claude, @catacomb/adapter-codex, @catacomb/engine, @catacomb/observer, @catacomb/hook'

const violations: readonly DirectionCase[] = [
  {
    name: 'collector product code may not import an adapter',
    path: 'packages/collector/src/adapter.ts',
    code: ["import '@catacomb/adapter-codex'"],
    errors: [[1, '@catacomb/collector product code may not import @catacomb/adapter-codex; allowed: @catacomb/contract']],
  },
  {
    name: 'engine product code may not import an adapter',
    path: 'packages/engine/src/registry.ts',
    code: ["import '@catacomb/adapter-claude'"],
    errors: [[1, '@catacomb/engine product code may not import @catacomb/adapter-claude; allowed: @catacomb/contract, @catacomb/store']],
  },
  {
    name: 'store product code may not import engine against the direction',
    path: 'packages/store/src/journal.ts',
    code: ["import '@catacomb/engine'"],
    errors: [[1, '@catacomb/store product code may not import @catacomb/engine; allowed: @catacomb/contract']],
  },
  {
    name: 'contract product code may not import any package, subpaths included',
    path: 'packages/contract/src/schema.ts',
    code: ["import '@catacomb/store'", "import '@catacomb/web/client'"],
    errors: [
      [1, '@catacomb/contract product code may not import @catacomb/store; allowed: none'],
      [2, '@catacomb/contract product code may not import @catacomb/web; allowed: none'],
    ],
  },
  {
    name: 'web product code may not import daemon',
    path: 'packages/web/src/app.ts',
    code: ["import '@catacomb/daemon'"],
    errors: [[1, '@catacomb/web product code may not import @catacomb/daemon; allowed: @catacomb/contract']],
  },
  {
    name: 'daemon product code may not import cli',
    path: 'packages/daemon/src/compose.ts',
    code: ["import '@catacomb/cli'"],
    errors: [[1, `@catacomb/daemon product code may not import @catacomb/cli; allowed: ${daemonDependencies}`]],
  },
  {
    name: 'catacomb product code may not import packages beyond cli, daemon and web',
    path: 'packages/catacomb/src/main.ts',
    code: ["import '@catacomb/store'"],
    errors: [[1, '@catacomb/catacomb product code may not import @catacomb/store; allowed: @catacomb/cli, @catacomb/daemon']],
  },
  {
    name: 'catacomb code may locate web but may not import, re-export or type-import its code',
    path: 'packages/catacomb/src/static.ts',
    code: [
      "import '@catacomb/web'",
      "export const load = () => import('@catacomb/web/client')",
      "export * from '@catacomb/web'",
      "export type Web = typeof import('@catacomb/web')",
    ],
    errors: [
      [1, '@catacomb/catacomb product code may only locate @catacomb/web with import.meta.resolve; it may not import its code'],
      [2, '@catacomb/catacomb product code may only locate @catacomb/web with import.meta.resolve; it may not import its code'],
      [3, '@catacomb/catacomb product code may only locate @catacomb/web with import.meta.resolve; it may not import its code'],
      [4, '@catacomb/catacomb product code may only locate @catacomb/web with import.meta.resolve; it may not import its code'],
    ],
  },
  {
    name: 'subpath imports are checked against the packages they map to',
    path: 'packages/catacomb/src/subpath.ts',
    code: [
      "import '#web'",
      "export const store = import.meta.resolve('#store')",
      'export const engine = import.meta.resolve(`#engine-${process.arch}`)',
      'export const load = () => import(`#store-${process.arch}`)',
    ],
    errors: [
      [1, '@catacomb/catacomb product code may only locate @catacomb/web with import.meta.resolve; it may not import its code'],
      [2, '@catacomb/catacomb product code may not import @catacomb/store; allowed: @catacomb/cli, @catacomb/daemon'],
      [3, '@catacomb/catacomb product code may not import @catacomb/engine; allowed: @catacomb/cli, @catacomb/daemon'],
      [4, '@catacomb/catacomb product code may not import @catacomb/store; allowed: @catacomb/cli, @catacomb/daemon'],
      [4, '@catacomb/catacomb product code may not import @catacomb/observer; allowed: @catacomb/cli, @catacomb/daemon'],
    ],
  },
  {
    name: 'an overlapping subpath pattern with a longer key wins when it is listed after the shorter one',
    path: 'packages/catacomb/src/overlapping.ts',
    code: [
      "export const data = import.meta.resolve('#target-data.js')",
      "export const cli = import.meta.resolve('#target-data')",
    ],
    errors: [[1, '@catacomb/catacomb product code may not import @catacomb/store; allowed: @catacomb/cli, @catacomb/daemon']],
  },
  {
    name: 'an overlapping subpath pattern with a longer key wins when it is listed before the shorter one',
    path: 'packages/cli/src/overlapping.ts',
    code: [
      "export const data = import.meta.resolve('#target-data.js')",
      "export const contract = import.meta.resolve('#target-data')",
    ],
    errors: [[1, '@catacomb/cli product code may not import @catacomb/store; allowed: @catacomb/contract, @catacomb/hook']],
  },
  {
    name: 'cli product code may not import the catacomb entry that composes it',
    path: 'packages/cli/src/start.ts',
    code: ["import '@catacomb/catacomb'"],
    errors: [[1, '@catacomb/cli product code may not import @catacomb/catacomb; allowed: @catacomb/contract, @catacomb/hook']],
  },
  {
    name: 'cli product code may not import testkit',
    path: 'packages/cli/src/main.ts',
    code: ["import '@catacomb/testkit'"],
    errors: [[1, '@catacomb/cli product code may not import @catacomb/testkit; allowed: @catacomb/contract, @catacomb/hook']],
  },
  {
    name: 'a relative import from engine into store is reported although engine may depend on store',
    path: 'packages/engine/src/ingest.ts',
    code: ["import '../../store/src/index.js'"],
    errors: [
      [
        1,
        "@catacomb/engine product code may not reach @catacomb/store through the relative path '../../store/src/index.js'; import other packages by name; allowed: @catacomb/contract, @catacomb/store",
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
        "@catacomb/cli product code may not reach tools/check-comments/src/main.js through the relative path '../../../tools/check-comments/src/main.js'; import other packages by name; allowed: @catacomb/contract, @catacomb/hook",
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
        "@catacomb/engine test code may not reach packages/engine/src/index.js through the relative path '../src/index.js'; import @catacomb/engine by name",
      ],
      [
        2,
        "@catacomb/engine test code may not reach packages/engine/dist/index.js through the relative path '../dist/index.js'; import @catacomb/engine by name",
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
        "@catacomb/web test code may not reach packages/web/src/app.js through the relative path './src/app.js'; import @catacomb/web by name",
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
        "@catacomb/engine product code may not reach @catacomb/adapter-claude through the relative path './..\\..\\adapter-claude/dist/index.js'; import other packages by name; allowed: @catacomb/contract, @catacomb/store",
      ],
      [
        2,
        "@catacomb/engine product code may not reach @catacomb/adapter-codex through the relative path './%2e%2e/%2e%2e/%61dapter-codex/dist/index.js'; import other packages by name; allowed: @catacomb/contract, @catacomb/store",
      ],
      [
        3,
        "@catacomb/engine product code may not reach @catacomb/store through the relative path '../../store/dist/index.js?/../../../engine/src/index.js'; import other packages by name; allowed: @catacomb/contract, @catacomb/store",
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
        "@catacomb/engine test code may not reach packages/engine/src/index.js through the relative path './..\\src\\index.js'; import @catacomb/engine by name",
      ],
      [
        2,
        "@catacomb/engine test code may not reach packages/engine/dist/index.js through the relative path '..\\dist\\index.js'; import @catacomb/engine by name",
      ],
    ],
  },
  {
    name: 'import.meta.resolve is checked; with a parent URL only package names are checked',
    path: 'packages/web/src/locate.ts',
    code: [
      "export const daemon = import.meta.resolve('@catacomb/daemon')",
      "export const cli = import.meta.resolve('@catacomb/cli', import.meta.url)",
      "export const store = import.meta.resolve('../../store/src/index.js')",
    ],
    errors: [
      [1, '@catacomb/web product code may not import @catacomb/daemon; allowed: @catacomb/contract'],
      [2, '@catacomb/web product code may not import @catacomb/cli; allowed: @catacomb/contract'],
      [
        3,
        "@catacomb/web product code may not reach @catacomb/store through the relative path '../../store/src/index.js'; import other packages by name; allowed: @catacomb/contract",
      ],
    ],
  },
  {
    name: 'backslash package specifiers are checked',
    path: 'packages/cli/src/backslash.ts',
    code: ["import '@catacomb\\\\daemon'"],
    errors: [[1, '@catacomb/cli product code may not import @catacomb/daemon; allowed: @catacomb/contract, @catacomb/hook']],
  },
  {
    name: 'import = require() is checked',
    path: 'packages/engine/test/legacy.test.ts',
    code: ["import daemon = require('@catacomb/daemon')", '', 'export { daemon }'],
    errors: [
      [
        1,
        '@catacomb/engine test code may not import @catacomb/daemon; allowed: @catacomb/contract, @catacomb/store, @catacomb/testkit, @catacomb/adapter-claude, @catacomb/adapter-codex, @catacomb/collector',
      ],
    ],
  },
  {
    name: 'a type-only import is checked',
    path: 'packages/observer/src/session.ts',
    code: ["import type { Session } from '@catacomb/daemon'", '', 'export type ObservedSession = Session'],
    errors: [
      [1, '@catacomb/observer product code may not import @catacomb/daemon; allowed: @catacomb/contract, @catacomb/store, @catacomb/engine'],
    ],
  },
  {
    name: 'named and star re-exports are checked',
    path: 'packages/hook/src/install.ts',
    code: ["export { install } from '@catacomb/cli'", "export * from '@catacomb/store'"],
    errors: [
      [1, '@catacomb/hook product code may not import @catacomb/cli; allowed: @catacomb/contract'],
      [2, '@catacomb/hook product code may not import @catacomb/store; allowed: @catacomb/contract'],
    ],
  },
  {
    name: 'dynamic imports with a string or a plain template literal are checked',
    path: 'packages/collector/src/lazy.ts',
    code: ["export const loadEngine = () => import('@catacomb/engine')", 'export const loadObserver = () => import(`@catacomb/observer`)'],
    errors: [
      [1, '@catacomb/collector product code may not import @catacomb/engine; allowed: @catacomb/contract'],
      [2, '@catacomb/collector product code may not import @catacomb/observer; allowed: @catacomb/contract'],
    ],
  },
  {
    name: 'type-level import() is checked',
    path: 'packages/web/src/api.ts',
    code: ["export type Daemon = typeof import('@catacomb/daemon')"],
    errors: [[1, '@catacomb/web product code may not import @catacomb/daemon; allowed: @catacomb/contract']],
  },
  {
    name: 'engine tests may not import packages beyond adapters, collector and testkit',
    path: 'packages/engine/test/daemon.test.ts',
    code: ["import '@catacomb/daemon'"],
    errors: [
      [
        1,
        '@catacomb/engine test code may not import @catacomb/daemon; allowed: @catacomb/contract, @catacomb/store, @catacomb/testkit, @catacomb/adapter-claude, @catacomb/adapter-codex, @catacomb/collector',
      ],
    ],
  },
  {
    name: 'tests of other packages may not import adapters',
    path: 'packages/cli/test/adapter.test.ts',
    code: ["import '@catacomb/adapter-codex'"],
    errors: [
      [1, '@catacomb/cli test code may not import @catacomb/adapter-codex; allowed: @catacomb/contract, @catacomb/hook, @catacomb/testkit'],
    ],
  },
  {
    name: 'observer tests may not import collector',
    path: 'packages/observer/test/collector.test.ts',
    code: ["import '@catacomb/collector'"],
    errors: [
      [
        1,
        '@catacomb/observer test code may not import @catacomb/collector; allowed: @catacomb/contract, @catacomb/store, @catacomb/engine, @catacomb/testkit, @catacomb/adapter-claude, @catacomb/adapter-codex',
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
    name: 'collector integration tests may import both adapters',
    path: 'packages/collector/test/adapters.test.ts',
    code: ["import '@catacomb/adapter-claude'", "import '@catacomb/adapter-codex'"],
    errors: [],
  },
  {
    name: 'engine tests may import both adapters, collector and testkit',
    path: 'packages/engine/test/adapters.test.ts',
    code: [
      "import '@catacomb/adapter-claude'",
      "import '@catacomb/adapter-codex'",
      "import '@catacomb/collector'",
      "import '@catacomb/testkit'",
    ],
    errors: [],
  },
  {
    name: 'observer tests may import both adapters and testkit',
    path: 'packages/observer/test/scheduler.test.ts',
    code: ["import '@catacomb/adapter-claude'", "import '@catacomb/adapter-codex'", "import '@catacomb/testkit'"],
    errors: [],
  },
  {
    name: 'observer product code may import engine, store, contract and external modules',
    path: 'packages/observer/src/plan.ts',
    code: ["import 'node:path'", "import '@catacomb/contract'", "import '@catacomb/store'", "import '@catacomb/engine'"],
    errors: [],
  },
  {
    name: 'daemon product code may import hook',
    path: 'packages/daemon/src/hooks.ts',
    code: ["import '@catacomb/hook'"],
    errors: [],
  },
  {
    name: 'catacomb product code may import cli and daemon and locate web with import.meta.resolve',
    path: 'packages/catacomb/src/compose.ts',
    code: [
      "import '@catacomb/cli'",
      "import '@catacomb/daemon'",
      "export const web = import.meta.resolve('@catacomb/web')",
      "export const page = import.meta.resolve('@catacomb/web/index.html', import.meta.url)",
    ],
    errors: [],
  },
  {
    name: 'catacomb product code may locate web and the hook binary through its subpath imports',
    path: 'packages/catacomb/src/layout.ts',
    code: [
      "export const web = import.meta.resolve('#web')",
      'export const hook = import.meta.resolve(`#catacomb-hook-${process.platform}-${process.arch}`)',
      "export const windowsHook = import.meta.resolve('#catacomb-hook-win32-arm64')",
      "export const own = import.meta.resolve('#own')",
      "export const unmapped = import.meta.resolve('#unmapped')",
    ],
    errors: [],
  },
  {
    name: 'daemon tests may import testkit',
    path: 'packages/daemon/test/start.test.ts',
    code: ["import '@catacomb/testkit'"],
    errors: [],
  },
  {
    name: 'a package may import its own name and subpaths',
    path: 'packages/store/src/self.ts',
    code: ["import '@catacomb/store'", "import '@catacomb/store/migrations'"],
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
    name: 'computed specifiers and relative import.meta.resolve with a parent URL are not checked',
    path: 'packages/cli/src/plugins.ts',
    code: [
      'export const load = (specifier: string): Promise<unknown> => import(specifier)',
      'export const locate = (specifier: string): string => import.meta.resolve(specifier, import.meta.url)',
      'export const locateAll = (...specifiers: [string]): string => import.meta.resolve(...specifiers)',
      "export const sibling = import.meta.resolve('../../web/src/index.js', new URL('../../web/src/', import.meta.url))",
      'export const now = (): number => Date.now()',
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
    code: ["import '@catacomb/daemon'", "import '../packages/store/src/index.js'"],
    errors: [],
  },
  {
    name: 'tools outside packages are not checked',
    path: 'tools/helper/src/index.ts',
    code: ["import '@catacomb/daemon'"],
    errors: [],
  },
]

const catacombImports = {
  '#web': '@catacomb/web',
  '#own': './dist/own.js',
  '#store': '@catacomb/store',
  '#store-*': { node: '@catacomb/store/*', default: ['@catacomb/observer/fallback'] },
  '#engine-*': '@catacomb/engine/*',
  '#catacomb-hook-win32-*': '@catacomb/hook/bin/catacomb-hook.exe',
  '#catacomb-hook-*': '@catacomb/hook/bin/catacomb-hook',
  '#target-*': '@catacomb/cli/*',
  '#target-*.js': '@catacomb/store/*.js',
}

const cliImports = {
  '#target-*.js': '@catacomb/store/*.js',
  '#target-*': '@catacomb/contract/*',
}

describe('the repository ESLint configuration enforces the ADR-0011 dependency direction', () => {
  const cases = [...violations, ...allowed]
  let workspace: LintWorkspace | undefined
  let findings: Findings | undefined

  beforeAll(async () => {
    workspace = await createLintWorkspace({
      ...Object.fromEntries(cases.map((row) => [row.path, `${row.code.join('\n')}\n`])),
      'packages/catacomb/package.json': JSON.stringify({ name: '@catacomb/catacomb', private: true, type: 'module', imports: catacombImports }),
      'packages/cli/package.json': JSON.stringify({ name: '@catacomb/cli', private: true, type: 'module', imports: cliImports }),
    })
    findings = await workspace.lint()
  }, 120_000)

  afterAll(async () => {
    await workspace?.remove()
  })

  test.for(cases)('$name', (row, { expect }) => {
    expect(findings?.get(row.path)?.filter(({ ruleId }) => ruleId === 'catacomb/dependency-direction')).toEqual(
      row.errors.map(([line, message]) => ({ ruleId: 'catacomb/dependency-direction', line, message })),
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
  const outside = await createLintWorkspace({ [path]: "import '@catacomb/adapter-claude'\n" }, { pnpmWorkspace: false })
  onTestFinished(() => outside.remove())

  const findings = await outside.lint()

  expect(findings.get(path)).toEqual([])
}, 120_000)
