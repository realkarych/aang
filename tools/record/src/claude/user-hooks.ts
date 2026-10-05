import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { bash, check, type Definition, present, sessionOf } from './definition.js'
import { attachments, commandOf, findTranscript, named, toolUses } from './transcripts.js'

const hookName = 'notes-guard'

const hookScript = [
  'let input = \'\'',
  'for await (const chunk of process.stdin) input += chunk',
  'const replies = {',
  `  SessionStart: () => process.stdout.write('${hookName}: the project notes greet the reader with Hello.\\n'),`,
  `  UserPromptSubmit: () => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '${hookName}: the notes reviewer is on duty.' } })),`,
  `  PostToolUse: () => process.stdout.write(JSON.stringify({ systemMessage: '${hookName} checked the command', hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '${hookName}: the command output was checked.' } })),`,
  '  Stop: () => {',
  `    process.stderr.write('${hookName} could not archive the turn\\n')`,
  '    process.exitCode = 1',
  '  },',
  '}',
  'replies[process.argv[2]]?.()',
  '',
].join('\n')

const events = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const

const expected = [
  'hook_success@SessionStart',
  'hook_additional_context@UserPromptSubmit',
  'hook_additional_context@PostToolUse',
  'hook_system_message@PostToolUse',
  'hook_non_blocking_error@Stop',
]

const StopSummary = z.looseObject({ hookInfos: z.array(z.looseObject({ command: z.string() })), hookErrors: z.array(z.unknown()) })

export const userHooks: Definition = {
  name: 'user-hooks',
  models: ['stub'],
  expectedFacts: [
    `The user hook ${hookName} comes from a settings file (--settings; the settings option of query() in the SDK) and runs on SessionStart, UserPromptSubmit, PostToolUse for Bash and Stop next to the aang hook`,
    'SessionStart prints plain text (hook_success); UserPromptSubmit and PostToolUse return additionalContext (hook_additional_context), PostToolUse also a systemMessage (hook_system_message)',
    `Stop exits with 1 (hook_non_blocking_error); stop_hook_summary lists the ${hookName} command with an error next to the aang hook`,
  ],
  script: () => ({ 'user-hooks': [[bash('echo hooked', 'Print hooked')], [{ text: 'The command printed hooked.' }]] }),
  run: async ({ session, stage }) => {
    const script = join(session.work, `${hookName}.mjs`)
    await writeFile(script, hookScript)
    const settings = join(session.work, `${hookName}.settings.json`)
    const hook = (event: string): unknown => ({ type: 'command', command: process.execPath, args: [script, event], timeout: 30 })
    await writeFile(settings, `${JSON.stringify({
      hooks: Object.fromEntries(events.map((event) => [event, [{ ...event === 'PostToolUse' ? { matcher: 'Bash' } : {}, hooks: [hook(event)] }]])),
    }, null, 2)}\n`)
    const summary = await stage('user-hooks', {
      settings,
      turns: [{ prompt: '[aang:user-hooks] Run `echo hooked` with the Bash tool and reply with its output.' }],
    })
    const sessionId = sessionOf(summary)
    const transcript = await findTranscript(session, sessionId)
    const action = present(named(toolUses(transcript), 'Bash').find((use) => commandOf(use).includes('echo hooked')), 'The session did not run echo hooked')
    const found = attachments(transcript).filter(({ type }) => type.startsWith('hook_')).filter((attachment) => JSON.stringify(attachment).includes(hookName))
      .map((attachment) => `${attachment.type}@${String(attachment['hookEvent'])}`)
    const missing = expected.filter((pair) => !found.includes(pair))
    check(missing.length === 0, `The transcript has no hook attachments ${missing.join(', ')} of ${hookName}; found: ${found.join(', ') || 'none'}`)
    const summaries = transcript.entries.filter((entry) => entry.type === 'system' && entry.subtype === 'stop_hook_summary').map((entry) => StopSummary.parse(entry))
    check(summaries.some(({ hookInfos, hookErrors }) => hookInfos.some(({ command }) => command.includes(hookName)) && hookErrors.length > 0),
      `No stop_hook_summary lists the failed ${hookName} hook: ${JSON.stringify(summaries.map(({ hookInfos }) => hookInfos.map(({ command }) => command)))}`)
    await session.checkpoint('session-started', { hook: { event: 'SessionStart', sessionId }, occurrence: 'first' },
      `The session starts; the user hook ${hookName} adds the greeting rule of the notes to the session`)
    await session.checkpoint('action-checked', { hook: { event: 'PostToolUse', toolUseId: action.id } },
      `The Bash action finishes and the user hook ${hookName} adds context and a message about it; the run context names the hook`)
    await session.checkpoint('stop-hook-failed', { hook: { event: 'Stop', sessionId } },
      `The turn ends; the Stop hook ${hookName} fails without blocking and the session shows the failed hook`)
  },
}
