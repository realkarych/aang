import { afterAll, beforeAll, describe, test } from 'vitest'
import { createLintWorkspace, type Findings, type LintWorkspace } from './lint.js'

interface EsmCase {
  readonly name: string
  readonly path: string
  readonly code: readonly string[]
  readonly errors: readonly (readonly [line: number, message: string])[]
}

const ruleId = 'aang/esm-only'
const remedy = 'the project is ESM-only, load modules with import and import()'
const moduleImport = (source: string): string => `package code may not import '${source}'; ${remedy}`
const commonJsGlobal = (name: string): string => `package code may not use the CommonJS global ${name}; ${remedy}`
const builtinModuleLoader = `package code may not use process.getBuiltinModule; ${remedy}`
const forbiddenModuleImport = "import { createRequire } from 'node:module'"

const violations: readonly EsmCase[] = [
  {
    name: 'node:module and module may not be imported in any form',
    path: 'packages/engine/src/loader.ts',
    code: [
      forbiddenModuleImport,
      "import * as builtins from 'module'",
      "import type { Module } from 'node:module'",
      "export { register } from 'module'",
      "export * from 'node:module'",
      "export const load = (): Promise<unknown> => import('node:module')",
      'export const loadTemplate = (): Promise<unknown> => import(`module`)',
      "export type Builtins = typeof import('node:module') | typeof builtins | Module | typeof createRequire",
    ],
    errors: [
      [1, moduleImport('node:module')],
      [2, moduleImport('module')],
      [3, moduleImport('node:module')],
      [4, moduleImport('module')],
      [5, moduleImport('node:module')],
      [6, moduleImport('node:module')],
      [7, moduleImport('module')],
      [8, moduleImport('node:module')],
    ],
  },
  {
    name: 'the CommonJS globals require and module may not be used, aliased or not',
    path: 'packages/store/src/legacy.ts',
    code: [
      "require('@aang/contract')",
      'const load = require',
      "load.resolve('./index.js')",
      "module.require('@aang/contract')",
    ],
    errors: [
      [1, commonJsGlobal('require')],
      [2, commonJsGlobal('require')],
      [4, commonJsGlobal('module')],
    ],
  },
  {
    name: 'import = require() may not be used',
    path: 'packages/hook/src/legacy.ts',
    code: ["import contract = require('@aang/contract')", '', 'export { contract }'],
    errors: [[1, `package code may not use import = require(); ${remedy}`]],
  },
  {
    name: 'getBuiltinModule may not be used, whether reached by name, string or template',
    path: 'packages/web/src/builtin.ts',
    code: [
      "export const direct: unknown = process.getBuiltinModule('node:module')",
      'const { getBuiltinModule } = process',
      "export const computed: unknown = process['getBuiltinModule']",
      'export const template: unknown = process[`getBuiltinModule`]',
      "export const reflected: unknown = Reflect.get(process, 'getBuiltinModule')",
      'export { getBuiltinModule }',
    ],
    errors: [
      [1, builtinModuleLoader],
      [2, builtinModuleLoader],
      [3, builtinModuleLoader],
      [4, builtinModuleLoader],
      [5, builtinModuleLoader],
      [6, builtinModuleLoader],
    ],
  },
  {
    name: 'CommonJS .cjs files may not be package code',
    path: 'packages/cli/src/legacy.cjs',
    code: ["const contract = require('@aang/contract')", '', 'module.exports = contract'],
    errors: [
      [1, 'package code may not be a CommonJS .cjs file; the project is ESM-only'],
      [1, commonJsGlobal('require')],
      [3, commonJsGlobal('module')],
    ],
  },
  {
    name: 'CommonJS .cts files may not be package code',
    path: 'packages/daemon/src/legacy.cts',
    code: ['export const legacy = true'],
    errors: [[1, 'package code may not be a CommonJS .cts file; the project is ESM-only']],
  },
  {
    name: 'tool source code is under the same ban',
    path: 'tools/helper/src/load.ts',
    code: [forbiddenModuleImport],
    errors: [[1, moduleImport('node:module')]],
  },
]

const allowed: readonly EsmCase[] = [
  {
    name: 'ordinary static and dynamic imports pass, and so do module names in plain strings',
    path: 'packages/engine/src/plain.ts',
    code: [
      "import { join } from 'node:path'",
      "import '@aang/contract'",
      "export * from './index.js'",
      "export const lazy = (): Promise<unknown> => import('node:fs')",
      'export const computed = (specifier: string): Promise<unknown> => import(specifier)',
      "export const located = import.meta.resolve('./index.js')",
      "export const names = ['node:module', 'module', 'require', 'getBuiltinModules']",
      "export const joined = join('a', 'b')",
      'namespace Shapes {',
      '  export const circle = 1',
      '}',
      'import circle = Shapes.circle',
      'export { circle }',
    ],
    errors: [],
  },
  {
    name: 'local bindings and properties named require or module are not the CommonJS globals',
    path: 'packages/contract/src/callbacks.ts',
    code: [
      "export const call = (require: (id: string) => unknown): unknown => require('./index.js')",
      "export const settings = { require: true, module: 'esm' }",
      "export const read = (loader: { require: (id: string) => unknown }): unknown => loader.require('x')",
      "const module = { name: 'engine' }",
      'export const moduleName = module.name',
    ],
    errors: [],
  },
  {
    name: 'package tests may use node:module',
    path: 'packages/engine/test/require.test.ts',
    code: [forbiddenModuleImport],
    errors: [],
  },
  {
    name: 'package-root configs may use node:module',
    path: 'packages/web/vite.config.ts',
    code: [forbiddenModuleImport],
    errors: [],
  },
  {
    name: 'tool tests may use node:module',
    path: 'tools/helper/test/load.test.ts',
    code: [forbiddenModuleImport],
    errors: [],
  },
  {
    name: 'code outside packages and tools may use node:module',
    path: 'e2e/smoke.ts',
    code: [forbiddenModuleImport],
    errors: [],
  },
]

const ruleMessages = (findings: Findings | undefined, path: string) =>
  findings?.get(path)?.filter((finding) => finding.ruleId === ruleId)

describe('the repository ESLint configuration keeps package source code ESM-only', () => {
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
    expect(ruleMessages(findings, row.path)).toEqual(row.errors.map(([line, message]) => ({ ruleId, line, message })))
  })
})

test('source files outside a pnpm workspace are not checked', async ({ expect, onTestFinished }) => {
  const path = 'packages/engine/src/loader.ts'
  const outside = await createLintWorkspace({ [path]: `${forbiddenModuleImport}\n` }, { pnpmWorkspace: false })
  onTestFinished(() => outside.remove())

  const findings = await outside.lint()

  expect(ruleMessages(findings, path)).toEqual([])
}, 120_000)
