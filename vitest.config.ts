import { globSync } from 'node:fs'
import { dirname } from 'node:path'
import { defineConfig } from 'vitest/config'

const workspaceGroups = ['packages', 'tools']

const projects = globSync(workspaceGroups.map((group) => `${group}/*/package.json`))
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
  { exclude: ['**/node_modules/**'] },
)

export default defineConfig({
  test: {
    projects,
    passWithNoTests: testFilesOnDisk.length === 0,
    setupFiles: ['vitest.setup.ts'],
    server: {
      deps: {
        external: [/\/(packages|tools)\/[^/]+\/dist\//],
      },
    },
  },
})
