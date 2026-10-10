import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, onTestFinished, test } from 'vitest'

interface Run {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const c8 = fileURLToPath(new URL('../node_modules/c8/bin/c8.js', import.meta.url))

const run = (cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Run> =>
  new Promise((resolve) => {
    execFile(process.execPath, args, { cwd, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ status: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr })
    })
  })

const workspace = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aang-coverage-')))
  onTestFinished(() => rm(base, { recursive: true, force: true, maxRetries: 3 }))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(base, path)), { recursive: true })
    await writeFile(join(base, path), text)
  }
  return join(base, 'workspace')
}

const c8Config = {
  include: ['packages/*/dist/**/*.js'],
  exclude: ['packages/excluded/**'],
  mergeAsync: true,
}

const project = {
  'workspace/package.json': JSON.stringify({ type: 'module' }),
  'workspace/.c8rc.json': JSON.stringify(c8Config),
  'workspace/packages/app/dist/branch.js': [
    'export const branch = (side) => {',
    "  if (side === 'left') {",
    "    return 'left'",
    '  }',
    "  return 'right'",
    '}',
    '',
    "export const unused = () => 'unused'",
    '',
  ].join('\n'),
  'workspace/packages/excluded/dist/excluded.js': "export const excluded = () => 'excluded'\n",
  'workspace/run.js': [
    "import { branch } from './packages/app/dist/branch.js'",
    "import { excluded } from './packages/excluded/dist/excluded.js'",
    "import { outside } from '../outside/outside.js'",
    'process.stdout.write(`${branch(process.argv[2])} ${excluded()} ${outside()}\\n`)',
    '',
  ].join('\n'),
  'outside/package.json': JSON.stringify({ type: 'module' }),
  'outside/outside.js': "export const outside = () => 'outside'\n",
}

const report = async (root: string, coverage: string, output: string): Promise<Readonly<Record<string, unknown>>> => {
  const result = await run(root, [c8, 'report', '--temp-directory', coverage, '--reporter', 'json', '--reports-dir', output])
  if (result.status !== 0) {
    throw new Error(`c8 report failed: ${result.stderr}`)
  }
  return JSON.parse(await readFile(join(root, output, 'coverage-final.json'), 'utf8')) as Readonly<Record<string, unknown>>
}

describe('merging the raw V8 coverage of one CI part', () => {
  test('the merged file of several processes gives the same c8 report as their raw files, unreadable files are skipped as c8 skips them', async ({
    expect,
  }) => {
    const root = await workspace(project)
    const raw = join(root, 'coverage', 'raw')
    for (const side of ['left', 'right']) {
      expect(await run(root, ['run.js', side], { NODE_V8_COVERAGE: raw })).toEqual({
        status: 0,
        stdout: `${side} excluded outside\n`,
        stderr: '',
      })
    }
    await writeFile(join(raw, 'coverage-truncated.json'), '{"result": [')
    await mkdir(join(raw, 'nested'))

    expect(await run(root, [cli, raw, 'coverage/part/v8.json'])).toEqual({
      status: 0,
      stdout: '2 V8 coverage files merged into coverage/part/v8.json, 1 unreadable skipped\n',
      stderr: '',
    })

    const merged = await report(root, 'coverage/part', 'coverage/report-part')
    expect(merged).toEqual(await report(root, raw, 'coverage/report-raw'))
    expect(Object.keys(merged)).toEqual([join(root, 'packages', 'app', 'dist', 'branch.js')])
  })

  test('a directory without coverage files is an error, and so are wrong arguments', async ({ expect }) => {
    const root = await workspace({ 'workspace/.c8rc.json': JSON.stringify(c8Config), 'workspace/coverage/raw/nested/x': '' })

    expect(await run(root, [cli, 'coverage/raw', 'coverage/part/v8.json'])).toEqual({
      status: 1,
      stdout: '',
      stderr: 'no V8 coverage files in coverage/raw\n',
    })
    expect(await run(root, [cli, 'coverage/raw'])).toEqual({
      status: 2,
      stdout: '',
      stderr: 'Usage: node tools/coverage/dist/main.js <raw coverage directory> <merged file>\n',
    })
  })
})
