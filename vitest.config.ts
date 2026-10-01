import { globSync } from 'node:fs'
import { dirname } from 'node:path'
import { defineConfig } from 'vitest/config'

const workspaceGroups = ['packages', 'tools']

const projects = globSync(workspaceGroups.map((group) => `${group}/*/package.json`), { cwd: import.meta.dirname })
  .map((manifest) => dirname(manifest).replaceAll('\\', '/'))
  .sort()
  .map((dir) => ({
    test: {
      name: dir,
      include: [`${dir}/test/**/*.test.ts`],
    },
  }))

const testFilesOnDisk = globSync(
  workspaceGroups.map((group) => `${group}/**/*.test.ts`),
  { cwd: import.meta.dirname, exclude: ['**/node_modules/**'] },
)

export default defineConfig({
  test: {
    projects,
    passWithNoTests: testFilesOnDisk.length === 0,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['vitest.setup.ts'],
    server: {
      deps: {
        external: [/\/(packages|tools)\/[^/]+\/dist\//],
      },
    },
  },
})
