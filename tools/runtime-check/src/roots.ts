import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CheckContext } from './context.js'
import { filesUnder, inheritedEnv, stubApiKey } from './profile.js'
import { isWindows, outcome, run } from './process.js'

const countUnder = async (directory: string): Promise<number> => (await filesUnder(directory)).length

const placement = async (
  candidates: Readonly<Record<string, string>>,
  relative: string,
): Promise<Record<string, number>> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(candidates).map(async ([name, root]) => [name, await countUnder(join(root, relative))] as const),
    ),
  )

export const defaultRoots = async (context: CheckContext, disposableProfile: boolean): Promise<Record<string, unknown>> => {
  if (!isWindows) {
    return { skipped: 'the HOME and USERPROFILE split matters only on Windows' }
  }
  if (!disposableProfile) {
    return { skipped: 'default-root probing writes to the OS account profile; requires --disposable-profile in a dedicated disposable account or CI runner' }
  }
  const base = join(context.work, 'default roots')
  const candidates = {
    HOME: join(base, 'home variable'),
    USERPROFILE: join(base, 'userprofile variable'),
    'os profile': homedir(),
  }
  await mkdir(candidates.HOME, { recursive: true })
  await mkdir(candidates.USERPROFILE, { recursive: true })
  const env = {
    ...inheritedEnv(),
    HOME: candidates.HOME,
    USERPROFILE: candidates.USERPROFILE,
    ANTHROPIC_BASE_URL: context.anthropic.url,
    ANTHROPIC_API_KEY: stubApiKey,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }
  const before = {
    claude: await placement(candidates, join('.claude', 'projects')),
    codex: await placement(candidates, join('.codex', 'sessions')),
  }
  context.anthropic.use({ steps: [], text: 'done' })
  const claude = await run(context.clis.claude.command, ['-p', 'Reply with done.', '--output-format', 'json'], {
    env,
    cwd: context.profile.project,
    timeoutMs: 120_000,
  })
  context.responses.use({ steps: [], text: 'done' })
  const codex = await run(
    context.clis.codex.command,
    [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'model_provider="aang_stub"',
      '-c',
      `model_providers.aang_stub={name="aang stub",base_url="${context.responses.url}",wire_api="responses",requires_openai_auth=false}`,
      '-c',
      'sandbox_mode="danger-full-access"',
      '-c',
      'approval_policy="never"',
      'Reply with done.',
    ],
    { env, cwd: context.profile.project, timeoutMs: 120_000 },
  )
  return {
    candidates,
    claude: {
      run: outcome(claude),
      transcriptsBefore: before.claude,
      transcriptsAfter: await placement(candidates, join('.claude', 'projects')),
      globalConfig: Object.fromEntries(
        Object.entries(candidates).map(([name, root]) => [name, existsSync(join(root, '.claude.json'))]),
      ),
    },
    codex: {
      run: outcome(codex),
      rolloutsBefore: before.codex,
      rolloutsAfter: await placement(candidates, join('.codex', 'sessions')),
    },
  }
}
