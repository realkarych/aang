import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, test, type TestContext } from 'vitest'
import { createWorkspace, git, runCli } from './cli.js'

const comment = '// comment\n'

describe.concurrent('inside a git repository the files known to git are checked', () => {
  const createRepository = async (onTestFinished: TestContext['onTestFinished']): Promise<string> => {
    const root = await createWorkspace(onTestFinished, {
      '.gitignore': 'ignored.ts\ndist/\n',
      'tracked.ts': comment,
      'untracked.ts': comment,
      'ignored.ts': comment,
      'docs/research/samples/recorded.json': comment,
      'docs/research/notes.ts': 'export {}\n',
      'sub/clean.ts': 'export {}\n',
      'sub/dist/clean.js': '//# sourceMappingURL=clean.js.map\n',
      'sub/dist/clean.d.ts': '//# sourceMappingURL=clean.d.ts.map\n',
    })
    await git(root, ['init', '--quiet'])
    await git(root, ['add', '.gitignore', 'tracked.ts', 'docs/research/samples/recorded.json', 'sub/clean.ts'])
    return root
  }

  test('tracked and untracked files are checked, ignored files and samples are not', async ({ expect, onTestFinished }) => {
    const root = await createRepository(onTestFinished)

    expect(await runCli(root)).toEqual({
      status: 1,
      stdout: ['tracked.ts:1:1: TypeScript comment', 'untracked.ts:1:1: TypeScript comment'],
      stderr: [],
    })
  })

  test('the whole repository is checked from a subdirectory with paths relative to it', async ({
    expect,
    onTestFinished,
  }) => {
    const root = await createRepository(onTestFinished)

    expect(await runCli(join(root, 'sub'))).toEqual({
      status: 1,
      stdout: ['../tracked.ts:1:1: TypeScript comment', '../untracked.ts:1:1: TypeScript comment'],
      stderr: [],
    })
  })

  test('a tracked path that cannot be read is reported with the distinct exit code', async ({
    expect,
    onTestFinished,
  }) => {
    const root = await createRepository(onTestFinished)
    await rm(join(root, 'tracked.ts'))
    await mkdir(join(root, 'tracked.ts'))

    expect(await runCli(root)).toEqual({
      status: 2,
      stdout: ['untracked.ts:1:1: TypeScript comment'],
      stderr: ['tracked.ts: cannot read: EISDIR'],
    })
  })

  test('a failing git command is reported with the distinct exit code', async ({ expect, onTestFinished }) => {
    const root = await createRepository(onTestFinished)
    await writeFile(join(root, '.git', 'index'), 'corrupt')

    const result = await runCli(root)

    expect(result.status).toBe(2)
    expect(result.stdout).toEqual([])
    expect(result.stderr[0]).toMatch(/^check-comments: Command failed: git ls-files/)
  })

  test('directory arguments skip what git ignores, such as build output, while explicit files are checked', async ({
    expect,
    onTestFinished,
  }) => {
    const root = await createRepository(onTestFinished)

    expect(await runCli(root, ['.'])).toEqual({
      status: 1,
      stdout: ['tracked.ts:1:1: TypeScript comment', 'untracked.ts:1:1: TypeScript comment'],
      stderr: [],
    })
    expect(await runCli(join(root, 'sub'), ['.'])).toEqual({ status: 0, stdout: [], stderr: [] })
    expect(await runCli(root, ['sub', 'ignored.ts'])).toEqual({
      status: 1,
      stdout: ['ignored.ts:1:1: TypeScript comment'],
      stderr: [],
    })
  })

  test('samples are skipped relative to the repository root when paths are given', async ({
    expect,
    onTestFinished,
  }) => {
    const root = await createRepository(onTestFinished)

    expect(await runCli(join(root, 'docs'), ['research'])).toEqual({ status: 0, stdout: [], stderr: [] })
  })
})

describe.concurrent('with path arguments outside a git repository', () => {
  const createDirectory = async (
    onTestFinished: TestContext['onTestFinished'],
  ): Promise<{ root: string; env: NodeJS.ProcessEnv }> => {
    const root = await createWorkspace(onTestFinished, {
      'src/a.ts': comment,
      'nested/deep/b.go': comment,
      'node_modules/pkg/index.js': comment,
      '.git/hooks/hook.js': comment,
      'docs/research/samples/recorded.json': comment,
      'docs/other.json': comment,
      'notes.md': '<!-- not checked -->\n',
    })
    return { root, env: { GIT_CEILING_DIRECTORIES: dirname(root) } }
  }

  test('directories are walked recursively, skipping .git, node_modules, samples and other extensions', async ({
    expect,
    onTestFinished,
  }) => {
    const { root, env } = await createDirectory(onTestFinished)

    expect(await runCli(root, ['.'], env)).toEqual({
      status: 1,
      stdout: ['docs/other.json:1:1: JSON comment', 'nested/deep/b.go:1:1: Go comment', 'src/a.ts:1:1: TypeScript comment'],
      stderr: [],
    })
  })

  test('explicit files are checked, while samples and other extensions are skipped', async ({
    expect,
    onTestFinished,
  }) => {
    const { root, env } = await createDirectory(onTestFinished)

    expect(await runCli(root, ['docs/research/samples/recorded.json', 'notes.md', 'src/a.ts'], env)).toEqual({
      status: 1,
      stdout: ['src/a.ts:1:1: TypeScript comment'],
      stderr: [],
    })
  })

  test('a missing path is reported with the distinct exit code even when comments are found', async ({
    expect,
    onTestFinished,
  }) => {
    const { root, env } = await createDirectory(onTestFinished)

    expect(await runCli(root, ['src', 'missing.ts'], env)).toEqual({
      status: 2,
      stdout: ['src/a.ts:1:1: TypeScript comment'],
      stderr: ['missing.ts: cannot read: ENOENT'],
    })
  })

  test('without path arguments a missing git repository is reported', async ({ expect, onTestFinished }) => {
    const { root, env } = await createDirectory(onTestFinished)

    expect(await runCli(root, [], env)).toEqual({
      status: 2,
      stdout: [],
      stderr: ['check-comments: not inside a git repository; pass files or directories to check'],
    })
  })
})
