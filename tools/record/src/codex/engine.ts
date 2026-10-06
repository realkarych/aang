import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { type Engine, EngineUnavailableError } from '../scenario.js'

const run = promisify(execFile)
const windows = process.platform === 'win32'

const triples: Readonly<Record<string, string>> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
}

const isExecutable = async (path: string): Promise<boolean> => {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return false
  return windows || await access(path, constants.X_OK).then(() => true, () => false)
}

const onPath = async (name: string): Promise<string | undefined> => {
  for (const directory of (process.env['PATH'] ?? process.env['Path'] ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name)
    if (await isExecutable(candidate)) return resolve(candidate)
  }
  return undefined
}

const firstExecutable = async (paths: readonly string[]): Promise<string | undefined> => {
  for (const path of paths) if (await isExecutable(path)) return path
  return undefined
}

const vendoredCodex = (packages: string): string[] => {
  const key = `${process.platform}-${process.arch}`
  const triple = triples[key]
  if (triple === undefined) return []
  const binary = windows ? 'codex.exe' : 'codex'
  return [join(packages, '@openai', 'codex', 'node_modules', '@openai', `codex-${key}`), join(packages, '@openai', `codex-${key}`)]
    .flatMap((directory) => [join(directory, 'vendor', triple, 'bin', binary), join(directory, 'vendor', triple, 'codex', binary)])
}

const locateCodex = async (): Promise<string | undefined> => {
  if (!windows) return onPath('codex')
  const native = await onPath('codex.exe')
  if (native !== undefined) return native
  const shim = await onPath('codex.cmd')
  return shim === undefined ? undefined : firstExecutable(vendoredCodex(join(dirname(shim), 'node_modules')))
}

const versionOf = async (executable: string): Promise<string> => {
  const { stdout } = await run(executable, ['--version'], { timeout: 60_000, windowsHide: true })
  const version = /(\d+\.\d+\.\d+\S*)\s*$/.exec(stdout.trim())?.[1]
  if (version === undefined) throw new Error(`${executable} --version printed ${stdout.trim()}`)
  return version
}

export const resolveCodex = async (selected: string | undefined): Promise<Engine> => {
  const path = selected ?? process.env['AANG_RECORD_CODEX'] ?? await locateCodex()
  if (path === undefined) throw new EngineUnavailableError('Codex CLI is not on PATH; pass --codex or AANG_RECORD_CODEX')
  if (windows && /\.(cmd|bat|ps1)$/i.test(path)) throw new Error(`Codex CLI must be the native executable, not the ${path} shim`)
  const executable = resolve(path)
  if (!await isExecutable(executable)) throw new EngineUnavailableError(`Codex CLI is not an executable file: ${executable}`)
  return { executable, version: await versionOf(executable) }
}

const SdkManifest = z.looseObject({
  name: z.literal('@openai/codex-sdk'),
  version: z.string(),
  module: z.string().optional(),
  exports: z.looseObject({ '.': z.looseObject({ import: z.string() }) }).optional(),
})

const sdkPackage = async (directory: string): Promise<{ readonly directory: string; readonly manifest: z.infer<typeof SdkManifest> } | undefined> => {
  for (const candidate of [directory, join(directory, 'node_modules', '@openai', 'codex-sdk')]) {
    const text = await readFile(join(candidate, 'package.json'), 'utf8').catch(() => undefined)
    const manifest = text === undefined ? undefined : SdkManifest.safeParse(JSON.parse(text))
    if (manifest?.success === true) return { directory: candidate, manifest: manifest.data }
  }
  return undefined
}

export const resolveCodexSdk = async (selected: string | undefined): Promise<Engine> => {
  const given = selected ?? process.env['AANG_RECORD_CODEX_SDK']
  if (given === undefined) throw new EngineUnavailableError('Codex SDK package directory is not given (--codex-sdk or AANG_RECORD_CODEX_SDK)')
  const found = await sdkPackage(resolve(given))
  if (found === undefined) throw new EngineUnavailableError(`${given} does not contain @openai/codex-sdk`)
  const { directory, manifest } = found
  const binary = await firstExecutable([...vendoredCodex(join(directory, 'node_modules')), ...vendoredCodex(dirname(dirname(directory)))])
  if (binary === undefined) throw new EngineUnavailableError(`The Codex binary bundled with ${directory} is not installed`)
  const module = join(directory, manifest.exports?.['.'].import ?? manifest.module ?? join('dist', 'index.js'))
  return { executable: binary, version: await versionOf(binary), appVersion: manifest.version, module }
}

const desktopEngine = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'

const bundleVersion = async (executable: string): Promise<string | undefined> => {
  const bundle = /^(.*?\.app)\/Contents\//.exec(executable)?.[1]
  if (bundle === undefined) return undefined
  const { stdout } = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')], { timeout: 30_000 })
  return stdout.trim() || undefined
}

export const resolveCodexDesktop = async (selected: string | undefined): Promise<Engine> => {
  const executable = resolve(selected ?? process.env['AANG_RECORD_CODEX_DESKTOP'] ?? desktopEngine)
  if (!await isExecutable(executable)) throw new EngineUnavailableError(`Codex Desktop engine is not installed at ${executable}`)
  const appVersion = await bundleVersion(executable)
  return { executable, version: await versionOf(executable), ...appVersion === undefined ? {} : { appVersion } }
}
