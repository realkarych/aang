import type { CodexCli } from './codex-app-server.js'
import { type CodexHooksCheck, readCodexHooksFiles, readCodexHooksRecord, unchangedFingerprint } from './codex-files.js'
import { withCodexHooksLock } from './codex-hooks.js'
import { codexHooksState, type CodexHooksStateOptions } from './codex-state.js'

export interface CodexHooksCheckOptions extends Omit<CodexHooksStateOptions, 'codex'> {
  readonly codex: () => CodexCli
  readonly known: CodexHooksCheck | null
  readonly fresh: boolean
}

export const checkCodexHooks = async ({ codex, known, fresh, ...options }: CodexHooksCheckOptions): Promise<CodexHooksCheck> => {
  const { aangHome, codexHome, signal } = options
  const unlocked = await readCodexHooksFiles(aangHome, codexHome)
  if (unlocked.unregistered) {
    return { status: 'not_installed', fingerprint: unlocked.fingerprint }
  }
  return withCodexHooksLock(codexHome, signal, async () => {
    const files = await readCodexHooksFiles(aangHome, codexHome)
    if (files.unregistered) {
      return { status: 'not_installed', fingerprint: files.fingerprint }
    }
    if (!fresh) {
      for (const remembered of [known, await readCodexHooksRecord(aangHome, codexHome)]) {
        if (remembered?.fingerprint === files.fingerprint) {
          return remembered
        }
      }
    }
    const { status } = await codexHooksState({ ...options, codex: codex() })
    return { status, fingerprint: await unchangedFingerprint(aangHome, codexHome, files) }
  })
}
