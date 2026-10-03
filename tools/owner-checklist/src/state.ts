import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ChecklistLayout } from './layout.js'

export const ClaudeRegistration = z.enum(['marketplace', 'plugin-dir'])
export type ClaudeRegistration = z.infer<typeof ClaudeRegistration>

export const CodexRegistration = z.strictObject({
  codexHome: z.string(),
  hooksFile: z.string(),
  command: z.string(),
  createdFile: z.boolean(),
  createdEvents: z.array(z.string()),
  backup: z.string().nullable(),
})
export type CodexRegistration = z.infer<typeof CodexRegistration>

export const ChecklistState = z.strictObject({
  version: z.literal(1),
  createdAt: z.string(),
  platform: z.string(),
  dir: z.string(),
  leaseExpiresAt: z.string(),
  claude: z.strictObject({
    mode: ClaudeRegistration,
    command: z.string(),
    configDir: z.string().nullable(),
    registered: z.boolean(),
  }),
  codex: CodexRegistration.nullable(),
  outsideDir: z.string().nullable(),
})
export type ChecklistState = z.infer<typeof ChecklistState>

export const writeState = async (layout: ChecklistLayout, state: ChecklistState): Promise<void> => {
  const staged = `${layout.state}.tmp`
  await writeFile(staged, `${JSON.stringify(state, null, 2)}\n`)
  await rename(staged, layout.state)
}

export const readState = async (layout: ChecklistLayout): Promise<ChecklistState> => {
  let text: string
  try {
    text = await readFile(layout.state, 'utf8')
  } catch {
    throw new Error(`${layout.state} не найден: каталог не подготовлен командой prepare или уже очищен`)
  }
  return ChecklistState.parse(JSON.parse(text))
}
