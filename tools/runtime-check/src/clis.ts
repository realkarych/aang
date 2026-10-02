import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { inheritedEnv } from './profile.js'
import { excerpt, isWindows, run, type RunResult } from './process.js'

export type CliName = 'claude' | 'codex'

export interface CliInstall {
  readonly name: CliName
  readonly command: string
  readonly source: string
  readonly wrapper: readonly string[] | null
  readonly version: string
}

interface CliOverrides {
  readonly claude: string | null
  readonly codex: string | null
}

const codexTriples: Readonly<Record<string, string>> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
}

const executableSuffix = isWindows ? '.exe' : ''

const platformKey = `${process.platform}-${process.arch}`

const npmRoot = (): string | null => {
  try {
    return execSync('npm root -g', { encoding: 'utf8', windowsHide: true }).trim()
  } catch {
    return null
  }
}

const onPath = (name: string): string[] => {
  try {
    const output = isWindows
      ? execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
      : execFileSync('which', ['-a', name], { encoding: 'utf8' })
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch {
    return []
  }
}

interface Candidate {
  readonly source: string
  readonly path: string | null
}

const isRealBinary = (path: string): boolean => existsSync(path) && statSync(path).size > 64 * 1024

const describeCandidate = ({ source, path }: Candidate): string =>
  path === null
    ? `${source}: none`
    : `${source}: ${path} (${existsSync(path) ? `${String(statSync(path).size)} bytes` : 'missing'})`

const firstExisting = (paths: readonly string[]): string | null => paths.find((path) => existsSync(path)) ?? null

const firstOnPath = (name: string): string | null =>
  onPath(name).find((path) => !isWindows || path.toLowerCase().endsWith('.exe')) ?? null

const claudeCandidates = (root: string | null): Candidate[] => {
  const binary = `claude${executableSuffix}`
  const platformPackage = join('@anthropic-ai', `claude-code-${platformKey}`)
  const wrapper = root === null ? null : join(root, '@anthropic-ai', 'claude-code')
  return [
    { source: 'npm package bin/claude.exe', path: wrapper === null ? null : join(wrapper, 'bin', 'claude.exe') },
    {
      source: 'npm platform package',
      path:
        root === null || wrapper === null
          ? null
          : firstExisting([
              join(wrapper, 'node_modules', platformPackage, binary),
              join(root, platformPackage, binary),
            ]),
    },
    { source: 'native installer', path: join(homedir(), '.local', 'bin', binary) },
    { source: 'PATH', path: firstOnPath('claude') },
  ]
}

const codexCandidates = (root: string | null): Candidate[] => {
  const triple = codexTriples[platformKey]
  const codexPackage = root === null ? null : join(root, '@openai', 'codex')
  const platformPackage = join('@openai', `codex-${platformKey}`)
  return [
    {
      source: 'npm platform package',
      path:
        root === null || codexPackage === null || triple === undefined
          ? null
          : firstExisting(
              [join(codexPackage, 'node_modules', platformPackage), join(root, platformPackage)].map((directory) =>
                join(directory, 'vendor', triple, 'bin', `codex${executableSuffix}`),
              ),
            ),
    },
    { source: 'PATH', path: firstOnPath('codex') },
  ]
}

const versionOf = async (command: string, prefix: readonly string[] = []): Promise<RunResult> =>
  run(command, [...prefix, '--version'], { env: inheritedEnv(), timeoutMs: 60_000 })

const install = async (
  name: CliName,
  candidates: readonly Candidate[],
  wrapper: readonly string[] | null,
): Promise<CliInstall> => {
  const attempts: string[] = []
  for (const candidate of candidates) {
    if (candidate.path !== null && isRealBinary(candidate.path)) {
      const version = await versionOf(candidate.path)
      if (version.status === 0) {
        return { name, command: candidate.path, source: candidate.source, wrapper, version: version.stdout.trim() }
      }
      attempts.push(
        `${candidate.path} --version: ${excerpt(version.stderr || String(version.error ?? version.status))}`,
      )
    }
  }
  throw new Error(
    [
      `${name} was not found`,
      ...candidates.map(describeCandidate),
      ...attempts,
      `where: ${onPath(name).join(', ')}`,
    ].join('\n'),
  )
}

export const locateClis = async (overrides: CliOverrides): Promise<Readonly<Record<CliName, CliInstall>>> => {
  const root = npmRoot()
  const codexScript = root === null ? null : join(root, '@openai', 'codex', 'bin', 'codex.js')
  const override = (path: string | null): Candidate[] => (path === null ? [] : [{ source: 'override', path }])
  return {
    claude: await install('claude', [...override(overrides.claude), ...claudeCandidates(root)], null),
    codex: await install(
      'codex',
      [...override(overrides.codex), ...codexCandidates(root)],
      codexScript !== null && existsSync(codexScript) ? [process.execPath, codexScript] : null,
    ),
  }
}

const describeRun = (result: RunResult): string =>
  result.error ?? (result.status === 0 ? `exit 0: ${result.stdout.trim()}` : `exit ${String(result.status)}`)

const shimContent = (path: string): string | null =>
  /\.(cmd|ps1)$/i.test(path) ? excerpt(readFileSync(path, 'utf8').trim(), 800) : null

export const inspectExecutables = async (
  clis: Readonly<Record<CliName, CliInstall>>,
): Promise<Record<string, unknown>> => {
  const nativeClaude = join(homedir(), '.local', 'bin', `claude${executableSuffix}`)
  const entries = await Promise.all(
    (['claude', 'codex'] as const).map(async (name) => {
      const paths = onPath(name)
      const shims = paths.flatMap((path) => {
        const content = shimContent(path)
        return content === null ? [] : [{ path, content }]
      })
      const cli = clis[name]
      const spawnChecks: Record<string, string> = {
        [`spawn('${name}') without shell`]: describeRun(await versionOf(name)),
        [`spawn(real executable)`]: describeRun(await versionOf(cli.command)),
      }
      for (const shim of shims.filter(({ path }) => path.toLowerCase().endsWith('.cmd'))) {
        spawnChecks[`spawn('${shim.path}') without shell`] = describeRun(await versionOf(shim.path))
      }
      if (cli.wrapper !== null) {
        const [node = process.execPath, ...script] = cli.wrapper
        spawnChecks['spawn(node, package script)'] = describeRun(await versionOf(node, script))
      }
      const candidates = (name === 'claude' ? claudeCandidates : codexCandidates)(npmRoot()).map(describeCandidate)
      return [
        name,
        {
          onPath: paths,
          candidates,
          realExecutable: cli.command,
          source: cli.source,
          wrapper: cli.wrapper,
          shims,
          spawnChecks,
        },
      ] as const
    }),
  )
  return {
    npmRoot: npmRoot(),
    pathEntries: (process.env.PATH ?? process.env.Path ?? '')
      .split(delimiter)
      .filter((entry) => /npm|node|\.local/i.test(entry)),
    ...Object.fromEntries(entries),
    nativeClaudeInstall: existsSync(nativeClaude)
      ? { path: nativeClaude, version: describeRun(await versionOf(nativeClaude)) }
      : null,
  }
}
