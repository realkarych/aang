import { chmod, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spoolLayout } from '@aang/contract'
import { aangHomePaths, leaseFileName } from '@aang/contract/home'
import { isWindows } from './process.js'

export interface Profile {
  readonly home: string
  readonly claudeConfigDir: string
  readonly codexHome: string
  readonly aangHome: string
  readonly hook: string
  readonly spool: string
  readonly project: string
}

const profileDirectoryName = 'Имя Фамилия'

const projectDirectoryName = 'проект с пробелами'

export const stubApiKey = 'sk-ant-api03-aang-runtime-check-stub'

const hookExecutable = isWindows ? 'aang-hook.exe' : 'aang-hook'

const strippedPrefixes: readonly string[] = [
  'ANTHROPIC_',
  'CLAUDE',
  'CODEX_',
  'OPENAI_',
  'AANG_',
  'AI_AGENT',
  'HERDR',
  'GITHUB_TOKEN',
  'ACTIONS_',
  'GOCOVERDIR',
]

export const inheritedEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !strippedPrefixes.some((prefix) => name.toUpperCase().startsWith(prefix)),
    ),
  )

export const spoolReady = (spool: string): string => join(spool, spoolLayout.readyDirectory)

export const createSpool = async (spool: string): Promise<void> => {
  await rm(spool, { recursive: true, force: true })
  await mkdir(spoolReady(spool), { recursive: true })
  await mkdir(join(spool, spoolLayout.temporaryDirectory), { recursive: true })
  await writeFile(join(spool, leaseFileName(Date.now() / 1000 + 86_400)), '')
}

export const createProfile = async (base: string, hookBinary: string): Promise<Profile> => {
  const home = join(base, 'Users', profileDirectoryName)
  const aangHome = join(home, '.aang')
  const profile: Profile = {
    home,
    claudeConfigDir: join(home, '.claude'),
    codexHome: join(home, '.codex'),
    aangHome,
    hook: join(aangHome, 'bin', hookExecutable),
    spool: aangHomePaths(aangHome).spool,
    project: join(home, projectDirectoryName),
  }
  for (const directory of [profile.claudeConfigDir, profile.codexHome, join(aangHome, 'bin'), profile.project]) {
    await mkdir(directory, { recursive: true })
  }
  await copyFile(hookBinary, profile.hook)
  await chmod(profile.hook, 0o755)
  await createSpool(profile.spool)
  await writeFile(join(profile.project, 'note.txt'), 'aang runtime check\n')
  return profile
}

export const runtimeEnv = (profile: Profile, anthropicUrl: string | null): NodeJS.ProcessEnv => ({
  ...inheritedEnv(),
  HOME: profile.home,
  USERPROFILE: profile.home,
  CLAUDE_CONFIG_DIR: profile.claudeConfigDir,
  CODEX_HOME: profile.codexHome,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  ...(anthropicUrl === null ? {} : { ANTHROPIC_BASE_URL: anthropicUrl, ANTHROPIC_API_KEY: stubApiKey }),
})

export const filesUnder = async (directory: string): Promise<string[]> => {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()
  } catch {
    return []
  }
}

export const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
