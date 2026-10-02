import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { type Engine, EngineUnavailableError, type SurfaceDriver } from '../scenario.js'

const exec = promisify(execFile)
const windows = process.platform === 'win32'
const binaryName = windows ? 'claude.exe' : 'claude'

const isExecutable = async (path: string): Promise<boolean> => {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return false
  return windows || await access(path, constants.X_OK).then(() => true, () => false)
}

const onPath = async (name: string): Promise<string | undefined> => {
  for (const directory of (process.env['PATH'] ?? process.env['Path'] ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name)
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

const versionOf = async (executable: string): Promise<string> => {
  const { stdout } = await exec(executable, ['--version'], { timeout: 60_000, windowsHide: true })
  const version = stdout.trim().split(/\s+/)[0]
  if (version === undefined || !/^\d+\.\d+\.\d+/.test(version)) throw new Error(`${executable} --version printed ${stdout.trim()}`)
  return version
}

const executableEngine = async (path: string, label: string): Promise<Engine> => {
  if (windows && /\.(cmd|bat|ps1)$/i.test(path)) throw new Error(`${label} must be the native executable, not the ${path} shim`)
  if (!await isExecutable(path)) throw new EngineUnavailableError(`${label} is not an executable file: ${path}`)
  return { executable: path, version: await versionOf(path) }
}

const chosen = (selected: string | undefined, variable: string): string | undefined => selected ?? process.env[variable]

const compareVersions = (left: string, right: string): number => {
  const parts = (value: string): number[] => value.split('.').map(Number)
  const [a, b] = [parts(left), parts(right)]
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

const cliDriver: SurfaceDriver = {
  surface: 'claude_cli',
  runtime: 'claude',
  resolve: async (selection) => {
    const nativeInstall = join(homedir(), '.local', 'bin', binaryName)
    const path = chosen(selection.claude, 'AANG_RECORD_CLAUDE') ?? await onPath(binaryName) ?? (await isExecutable(nativeInstall) ? nativeInstall : undefined)
    if (path === undefined) throw new EngineUnavailableError(`Claude Code CLI (${binaryName}) is not on PATH`)
    return executableEngine(resolve(path), 'Claude Code CLI')
  },
}

const SdkPackage = z.looseObject({
  name: z.literal('@anthropic-ai/claude-agent-sdk'),
  version: z.string(),
  main: z.string().optional(),
  exports: z.looseObject({ '.': z.looseObject({ default: z.string() }) }).optional(),
  claudeCodeVersion: z.string().optional(),
})

const sdkPackage = async (directory: string): Promise<{ directory: string; manifest: z.infer<typeof SdkPackage> } | undefined> => {
  for (const candidate of [directory, join(directory, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')]) {
    const text = await readFile(join(candidate, 'package.json'), 'utf8').catch(() => undefined)
    const manifest = text === undefined ? undefined : SdkPackage.safeParse(JSON.parse(text))
    if (manifest?.success) return { directory: candidate, manifest: manifest.data }
  }
  return undefined
}

const bundledBinary = async (directory: string): Promise<string | undefined> => {
  const platform = `${process.platform}-${process.arch}`
  for (const variant of [platform, `${platform}-musl`]) {
    for (const root of [join(directory, 'node_modules', '@anthropic-ai'), dirname(directory)]) {
      const candidate = join(root, `claude-agent-sdk-${variant}`, binaryName)
      if (await isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

const sdkDriver: SurfaceDriver = {
  surface: 'claude_sdk',
  runtime: 'claude',
  resolve: async (selection) => {
    const given = chosen(selection.claudeSdk, 'AANG_RECORD_CLAUDE_SDK')
    if (given === undefined) throw new EngineUnavailableError('Claude Agent SDK package directory is not given (--claude-sdk or AANG_RECORD_CLAUDE_SDK)')
    const found = await sdkPackage(resolve(given))
    if (found === undefined) throw new EngineUnavailableError(`${given} does not contain @anthropic-ai/claude-agent-sdk`)
    const { directory, manifest } = found
    const module = join(directory, manifest.exports?.['.'].default ?? manifest.main ?? 'sdk.mjs')
    const binary = await bundledBinary(directory)
    const version = manifest.claudeCodeVersion ?? (binary === undefined ? undefined : await versionOf(binary))
    if (version === undefined) throw new EngineUnavailableError(`Cannot determine the Claude Code version bundled with ${directory}`)
    return { executable: binary ?? module, version, appVersion: manifest.version, module }
  },
}

const desktopRoot = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code')
const desktopApp = '/Applications/Claude.app'

const newestDesktopEngine = async (): Promise<string | undefined> => {
  const versions = (await readdir(desktopRoot).catch(() => [])).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort(compareVersions).reverse()
  for (const version of versions) {
    const builds = (await readdir(join(desktopRoot, version)).catch(() => [])).filter((name) => name !== 'claude.app')
    for (const build of ['', ...builds]) {
      const candidate = join(desktopRoot, version, build, 'claude.app', 'Contents', 'MacOS', 'claude')
      if (await isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

const desktopVersion = async (): Promise<string | undefined> => {
  const plist = join(desktopApp, 'Contents', 'Info.plist')
  if (await stat(plist).catch(() => undefined) === undefined) return undefined
  const { stdout } = await exec('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { timeout: 30_000 })
  return stdout.trim() || undefined
}

export const desktopSdkVersion = async (): Promise<string | undefined> => {
  const bundle = await readFile(join(desktopApp, 'Contents', 'Resources', 'app.asar')).catch(() => undefined)
  return bundle === undefined ? undefined : /CLAUDE_AGENT_SDK_VERSION\|\|="(\d+\.\d+\.\d+)"/.exec(bundle.toString('latin1'))?.[1]
}

const desktopDriver: SurfaceDriver = {
  surface: 'claude_desktop',
  runtime: 'claude',
  os: ['macos'],
  resolve: async (selection) => {
    const path = chosen(selection.claudeDesktop, 'AANG_RECORD_CLAUDE_DESKTOP') ?? await newestDesktopEngine()
    if (path === undefined) throw new EngineUnavailableError(`Claude Desktop engine is not installed under ${desktopRoot}`)
    const engine = await executableEngine(resolve(path), 'Claude Desktop engine')
    const appVersion = await desktopVersion()
    return appVersion === undefined ? engine : { ...engine, appVersion }
  },
}

export const claudeSurfaceDrivers: readonly SurfaceDriver[] = [cliDriver, sdkDriver, desktopDriver]
