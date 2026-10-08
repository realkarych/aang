import { existsSync, globSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defineConfig } from 'vitest/config'

const workspaceGroups = ['packages', 'tools']

const projects = globSync(workspaceGroups.map((group) => `${group}/*/package.json`), { cwd: import.meta.dirname })
  .map((manifest) => dirname(manifest).replaceAll('\\', '/'))
  .sort()
  .map((dir) => ({
    test: {
      name: dir,
      include: [`${dir}/test/**/*.test.ts`],
      globalSetup: [`${dir}/test/global-setup.ts`].filter((setup) => existsSync(join(import.meta.dirname, setup))),
    },
  }))

const testFilesOnDisk = globSync(
  workspaceGroups.map((group) => `${group}/**/*.test.ts`),
  { cwd: import.meta.dirname, exclude: ['**/node_modules/**'] },
)

export default defineConfig({
  test: {
    ...(process.platform === 'win32' ? { fileParallelism: false, maxConcurrency: 1 } : {}),
    projects,
    tags: [
      { name: 'benchmark', description: 'strict local benchmarks, excluded from the default run' },
      { name: 'runtime', description: 'scenarios on installed runtime CLIs and SDKs, run by the Scenarios workflow' },
      { name: 'docker', description: 'smoke of the Docker image and a derived solver image, run by the docker job in CI' },
      { name: 'package', description: 'the packed npm package installed into a temporary prefix, run by the package CI job' },
    ],
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
