import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { basename, delimiter, join } from 'node:path'
import { hookRecords, hooksNamed } from '../hooks.js'
import type { ScenarioSession } from '../scenario.js'
import { check, type Definition, present } from './definition.js'
import { elicitationConfig, elicitationServer, greetingOf, greetingTool, linkTool, resultOf, serverLog } from './elicitation.js'
import { spawnTeammate, teamEnv } from './teammates.js'
import { findTranscript, transcriptFiles } from './transcripts.js'

const executable = async (path: string, content: string): Promise<string> => {
  await writeFile(path, content)
  await chmod(path, 0o755)
  return path
}

const terminalTools = async (session: ScenarioSession): Promise<{ readonly path: string; readonly shell: string; readonly browser: string }> => {
  const directory = join(session.work, 'bin')
  await mkdir(directory, { recursive: true })
  await executable(join(directory, 'tmux'), '#!/bin/sh\n[ "$1" = "-V" ] && echo "tmux 3.5a" && exit 0\nexit 1\n')
  await executable(join(directory, 'it2'), '#!/bin/sh\nexit 1\n')
  const shell = await executable(join(directory, 'login-shell'), '#!/bin/sh\nif [ "$1" = "-lc" ]; then shift; set -- -c "$@"; fi\nexec /bin/sh "$@"\n')
  const browser = await executable(join(directory, 'browser'),
    `#!/bin/sh\nexec '${process.execPath}' -e 'fetch(process.argv[1]).then((response) => response.text())' "$1"\n`)
  return { path: `${directory}${delimiter}${process.env['PATH'] ?? ''}`, shell, browser }
}

export const inputDialogs: Definition = {
  name: 'input-dialogs',
  models: ['stub'],
  surfaces: ['claude_cli'],
  os: ['macos', 'linux'],
  expectedFacts: [
    'An interactive CLI session shows the form of the MCP server aang-elicitation; after ~6 s it notifies elicitation_dialog and the user picks Hello and accepts',
    'The server then asks to open a link; after ~6 s the session notifies elicitation_url_dialog, the user accepts and the opened link is confirmed',
    'Spawning the teammate helper in iTerm2 without the it2 CLI asks for teammate setup; after ~6 s the session notifies agent_needs_input and the user cancels, so the spawn fails',
  ],
  script: () => ({
    dialogs: [
      [{ tool: greetingTool, input: {} }],
      [{ tool: linkTool, input: {} }],
      [spawnTeammate],
      [{ text: 'The greeting is Hello, the link is confirmed and the teammate was not started.' }],
    ],
  }),
  run: async ({ session, tui }) => {
    const { path, shell, browser } = await terminalTools(session)
    await tui('dialogs', {
      args: ['--teammate-mode', 'auto', '--allowedTools', `${greetingTool},${linkTool}`, '--mcp-config', elicitationConfig(session)],
      env: { ...teamEnv, TERM_PROGRAM: 'iTerm.app', PATH: path, SHELL: shell, BROWSER: browser },
      steps: [
        { hook: 'SessionStart' },
        { prompt: `[aang:dialogs] Call the choose_greeting tool of the ${elicitationServer} MCP server, then its confirm_link tool, then spawn the teammate helper with the Agent tool.` },
        { notification: 'elicitation_dialog' },
        { press: 'right' },
        { press: 'enter' },
        { press: 'enter' },
        { notification: 'elicitation_url_dialog' },
        { press: 'enter' },
        { notification: 'agent_needs_input' },
        { press: 'escape' },
        { hook: 'Stop' },
        { idle: 2 },
      ],
    })
    const roots = await transcriptFiles(session)
    check(roots.length === 1, `The interactive session wrote ${String(roots.length)} root transcripts`)
    const sessionId = basename(present(roots[0], 'No root transcript'), '.jsonl')
    const transcript = await findTranscript(session, sessionId)
    const greeting = resultOf(transcript, greetingTool)
    const confirmation = resultOf(transcript, linkTool)
    const spawn = resultOf(transcript, 'Agent')
    check(!greeting.isError && greeting.text.includes('Hello'), `The form answer did not reach the greeting action: ${greeting.text}`)
    check(!confirmation.isError && confirmation.text.includes('confirmed'), `The link was not confirmed: ${confirmation.text}`)
    check(spawn.isError && spawn.text.includes('cancelled'), `The teammate spawn was not cancelled: ${spawn.text}`)
    const log = await serverLog(session)
    check(greetingOf(log.answered('form')?.content) === 'Hello', 'The MCP server did not receive the greeting Hello')
    const link = present(log.answered('url'), 'The MCP server got no answer to the link')
    check(link.action === 'accept' && log.confirmed(present(link.elicitationId ?? undefined, 'The link has no elicitation id')), 'The opened link was not confirmed')
    const hooks = await hookRecords(session.spool)
    const notified = new Set(hooksNamed(hooks, 'Notification').map((hook) => String(hook['notification_type'])))
    check(['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].every((type) => notified.has(type)), `Missing dialog notifications: ${[...notified].join(', ')}`)
    check(hooksNamed(hooks, 'ElicitationResult').some((hook) => hook['mode'] === 'form' && hook['action'] === 'accept' && greetingOf(hook['content']) === 'Hello'),
      'ElicitationResult does not record the accepted form')
    await session.checkpoint('form-dialog', { hook: { event: 'Notification', sessionId, notificationType: 'elicitation_dialog' } },
      'The MCP form has waited for ~6 s; the session needs the user to choose a greeting')
    await session.checkpoint('link-dialog', { hook: { event: 'Notification', sessionId, notificationType: 'elicitation_url_dialog' } },
      'The MCP server asks the user to open a link; the session needs input again')
    await session.checkpoint('teammate-setup', { hook: { event: 'Notification', sessionId, notificationType: 'agent_needs_input' } },
      'Spawning the teammate helper waits for the user to set up iTerm2 split panes; the session needs input')
  },
}
