import { join, sep } from 'node:path'
import type { Anonymize } from './anonymize.js'
import {
  callsOf,
  type ChecklistEvent,
  type FieldValue,
  isBatchCalls,
  isoTime,
  numberField,
  textField,
} from './events.js'
import type { ClaudeTranscript, CodexRollout, SessionFiles } from './files.js'
import { type EnvProbeRecord, probedEnvNames } from './probe-env.js'
import {
  countEvents,
  distinctEnv,
  distinctText,
  idleChains,
  permissionChains,
  type Session,
  surfaceOf,
  toolChains,
  toolPairs,
} from './sessions.js'
import type { ChecklistState } from './state.js'

export interface SummaryInput {
  readonly generatedAt: string
  readonly state: ChecklistState
  readonly events: readonly ChecklistEvent[]
  readonly scope: { readonly droppedEvents: number; readonly droppedSessions: number } | null
  readonly sessions: readonly Session[]
  readonly envProbes: readonly EnvProbeRecord[]
  readonly files: SessionFiles
  readonly codexHome: string
  readonly anonymize: Anonymize
}

interface Labeled {
  readonly label: string
  readonly session: Session
}

const detailFields = [
  'tool_name',
  'tool_use_id',
  'notification_type',
  'source',
  'reason',
  'agent_id',
  'agent_type',
  'trigger',
  'subagent_type',
  'run_in_background',
  'response_agent_id',
  'response_status',
  'questions',
  'answers',
  'afk_timeout_ms',
  'plan_length',
  'plan_file_path',
  'background_tasks',
  'permission_mode',
] as const

const cell = (value: string): string => value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ')

const code = (value: string): string => `\`${value.replaceAll('`', "'")}\``

const row = (values: readonly string[]): string => `| ${values.map(cell).join(' | ')} |`

const table = (header: readonly string[], rows: readonly (readonly string[])[], empty: string): string[] =>
  rows.length === 0 ? [empty] : [row(header), row(header.map(() => '---')), ...rows.map(row)]

const seconds = (milliseconds: number | null): string => (milliseconds === null ? 'none' : (milliseconds / 1000).toFixed(2))

const offset = (session: Session, event: ChecklistEvent): string => {
  const first = session.events[0]
  return first === undefined ? '' : (Number(event.receivedNs - first.receivedNs) / 1e9).toFixed(2)
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no')

const formatValue = (value: FieldValue): string =>
  isBatchCalls(value)
    ? `[${value.map((call) => `${call.tool_name ?? '?'} ${call.tool_use_id ?? '?'} ${call.response}`).join('; ')}]`
    : String(value)

const numberText = (event: ChecklistEvent, name: string): string => {
  const value = numberField(event, name)
  return value === null ? 'none' : String(value)
}

const details = (event: ChecklistEvent): string =>
  [
    ...detailFields.flatMap((name) => {
      const value = event.fields[name]
      return value === undefined ? [] : [`${name}=${formatValue(value)}`]
    }),
    ...(callsOf(event).length > 0 ? [`tool_calls=${formatValue(callsOf(event))}`] : []),
    ...(event.problem === null ? [] : [`problem: ${event.problem}`]),
  ].join(', ')

const json = (value: unknown, anonymize: Anonymize): string => anonymize(JSON.stringify(value))

const sessionLabels = (sessions: readonly Session[]): Labeled[] =>
  [...sessions]
    .sort((left, right) => {
      const a = left.events[0]?.receivedNs ?? 0n
      const b = right.events[0]?.receivedNs ?? 0n
      return a === b ? 0 : a < b ? -1 : 1
    })
    .map((session, index) => ({ label: `S${String(index + 1)}`, session }))

const isClaudeWorktree = (cwd: string): boolean =>
  cwd.includes(`${sep}.claude${sep}worktrees${sep}`) || cwd.includes('/.claude/worktrees/')

const scopeLine = (scope: SummaryInput['scope']): string =>
  scope === null
    ? 'All sessions from the spool are included (`collect --all-sessions`).'
    : `Included are sessions whose \`cwd\` is in the working directory or in \`$CODEX_HOME/worktrees\`; the rest were dropped: events ${String(scope.droppedEvents)}, sessions ${String(scope.droppedSessions)}.`

const header = ({ generatedAt, state, events, scope, sessions, anonymize }: SummaryInput): string[] => [
  '# Owner checklist D.7: summary',
  '',
  `Collected by \`collect\` at ${generatedAt}. OS: ${process.platform}. Working directory: ${code(anonymize(state.dir))} (shown as \`<dir>\` in paths; the home directory is \`~\`).`,
  `Claude registration: \`${state.claude.mode}\`. Codex hooks: ${state.codex === null ? 'not registered' : 'registered'}.`,
  '',
  `Events: ${String(events.length)}, with a parse problem: ${String(events.filter((event) => event.problem !== null).length)}. Sessions: ${String(sessions.length)}.`,
  scopeLine(scope),
  '',
  'The script does not check items marked "filled in by the owner": their result is written into the report by hand.',
  '',
]

const sessionFacts = (session: Session): (readonly [string, readonly string[]])[] => [
  ['cwd', distinctText(session, null, 'cwd')],
  ['transcript_path', distinctText(session, null, 'transcript_path')],
  ...(['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_HOST_SESSION_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'] as const).map(
    (name) => [name, distinctEnv(session, name)] as const,
  ),
]

const sessionsOverview = (labeled: readonly Labeled[], anonymize: Anonymize): string[] => [
  '## Sessions',
  '',
  ...table(
    ['Session', 'Runtime', 'Surface', 'Registration', 'Start (UTC)', 'Events', 'session_id'],
    labeled.map(({ label, session }) => [
      label,
      session.runtime,
      surfaceOf(session),
      [...new Set(session.events.map((event) => event.registration))].join(', '),
      session.events[0] === undefined ? '' : isoTime(session.events[0].receivedNs),
      String(session.events.length),
      session.sessionId ?? '(none)',
    ]),
    'The spool has no events.',
  ),
  '',
  ...labeled.flatMap(({ label, session }) => [
    `### ${label} — ${session.runtime}, ${surfaceOf(session)}`,
    '',
    ...sessionFacts(session).flatMap(([name, values]) =>
      values.length === 0 ? [] : [`- ${name}: ${values.map((value) => code(anonymize(value))).join(', ')}`],
    ),
    '',
    ...table(
      ['+t, s', 'Event', 'Details'],
      session.events.map((event) => [offset(session, event), event.event ?? '(none)', anonymize(details(event))]),
      'No events.',
    ),
    '',
  ]),
]

const permissionSection = (claude: readonly Labeled[]): string[] => [
  '### (a) Notification(permission_prompt) after PermissionRequest',
  '',
  'Expected in the TUI: about 6 s without input; every keystroke delays the notification. The outcome is taken from the `tool_use_id` of the preceding PreToolUse with the same tool.',
  '',
  ...table(
    ['Session', 'Surface', 'PermissionRequest, +t s', 'Tool', 'tool_use_id', 'permission_prompt delay, s', 'Outcome'],
    claude.flatMap(({ label, session }) =>
      permissionChains(session).map((chain) => [
        label,
        surfaceOf(session),
        offset(session, chain.request),
        chain.toolName ?? '?',
        chain.toolUseId ?? '?',
        seconds(chain.promptDelayMs),
        chain.outcome,
      ]),
    ),
    'No PermissionRequest.',
  ),
  '',
]

const idleSection = (claude: readonly Labeled[]): string[] => [
  '### (b) Notification(idle_prompt) after Stop',
  '',
  'Expected: about 60 s after the response if the user typed nothing. The first `idle_prompt` before the next UserPromptSubmit or SessionEnd counts.',
  '',
  ...table(
    ['Session', 'Surface', 'Stop, +t s', 'background_tasks', 'idle_prompt delay, s'],
    claude.flatMap(({ label, session }) =>
      idleChains(session).map((chain) => [
        label,
        surfaceOf(session),
        offset(session, chain.stop),
        chain.backgroundTasks === null ? '' : String(chain.backgroundTasks),
        seconds(chain.idleDelayMs),
      ]),
    ),
    'No Stop.',
  ),
  '',
]

const toolSection = (title: string, toolName: string, claude: readonly Labeled[], planColumns: boolean): string[] => [
  title,
  '',
  ...table(
    [
      'Session',
      'Surface',
      'tool_use_id',
      ...(planColumns ? ['plan length', 'planFilePath'] : ['Questions']),
      'PermissionRequest',
      'Notification before PostToolUse',
      'PostToolUse',
      ...(planColumns ? [] : ['answers']),
      'PreToolUse → PostToolUse, s',
    ],
    claude.flatMap(({ label, session }) =>
      toolChains(session, toolName).map((chain) => [
        label,
        surfaceOf(session),
        chain.toolUseId ?? '?',
        ...(planColumns
          ? [
              numberText(chain.pre, 'plan_length'),
              yesNo(chain.pre.fields.plan_file_path === true || chain.post?.fields.plan_file_path === true),
            ]
          : [numberText(chain.pre, 'questions')]),
        yesNo(chain.permission),
        chain.notifications.join(', ') || 'none',
        chain.post === null ? (chain.deniedInBatch ? 'no, denied in PostToolBatch' : 'no') : (chain.post.event ?? ''),
        ...(planColumns ? [] : [yesNo(chain.post?.fields.answers === true)]),
        seconds(chain.durationMs),
      ]),
    ),
    `No PreToolUse(${toolName}).`,
  ),
  '',
]

const sessionEndSection = (claude: readonly Labeled[]): string[] => [
  '### (e) SessionEnd.reason',
  '',
  'For comparison, the owner records how each session ended (`/exit`, double Ctrl+C, Ctrl+D, `/clear`, closing the window).',
  '',
  ...table(
    ['Session', 'Surface', 'SessionEnd, +t s', 'reason'],
    claude.flatMap(({ label, session }) =>
      session.events
        .filter((event) => event.event === 'SessionEnd')
        .map((event) => [label, surfaceOf(session), offset(session, event), textField(event, 'reason') ?? '(none)']),
    ),
    'No SessionEnd.',
  ),
  '',
]

const envProbeSection = (probes: readonly EnvProbeRecord[], labeled: readonly Labeled[]): string[] => {
  const labelOf = (sessionId: string | null): string =>
    labeled.find(({ session }) => session.runtime === 'claude' && session.sessionId === sessionId)?.label ??
    sessionId ??
    '(none)'
  return [
    '### (f) Hook process environment (`results/env-probe.jsonl`)',
    '',
    'Written by the `probes/env-settings.json` probe on SessionStart; enabled with the `--settings` flag.',
    '',
    ...table(
      ['Session', 'Time (UTC)', 'Event', 'source', ...probedEnvNames],
      probes.map((probe) => [
        labelOf(probe.session_id),
        probe.received_at,
        probe.hook_event_name ?? '',
        probe.source ?? '',
        ...probedEnvNames.map((name) => probe.env[name] ?? '(none)'),
      ]),
      'No probe records: the TUI was not started with `--settings probes/env-settings.json`.',
    ),
    '',
  ]
}

const notificationSection = (labeled: readonly Labeled[]): string[] => {
  const types = new Map<string, Set<string>>()
  const counts = new Map<string, number>()
  for (const { label, session } of labeled) {
    for (const event of session.events.filter((item) => item.event === 'Notification')) {
      const type = textField(event, 'notification_type') ?? '(none)'
      types.set(type, (types.get(type) ?? new Set()).add(`${label} (${surfaceOf(session)})`))
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
  }
  return [
    '### (g) Notification types',
    '',
    ...table(
      ['notification_type', 'Count', 'Sessions'],
      [...types].map(([type, sessions]) => [type, String(counts.get(type) ?? 0), [...sessions].join(', ')]),
      'No Notification.',
    ),
    '',
    ...['elicitation_dialog', 'agent_needs_input'].map(
      (type) => `- \`${type}\`: ${types.has(type) ? 'seen' : 'not seen'}.`,
    ),
    '',
  ]
}

const pairsLine = (session: Session): string => {
  const pairs = toolPairs(session)
  const unpaired = pairs.unpaired.map(
    (item) => `${item.toolName ?? '?'} ${item.toolUseId}${item.deniedInBatch ? ' (denied in PostToolBatch)' : ''}`,
  )
  return `- PreToolUse → PostToolUse by \`tool_use_id\`: pairs ${String(pairs.paired)}, PostToolUseFailure ${String(pairs.failed)}, without Post*: ${unpaired.length === 0 ? 'none' : unpaired.join('; ')}`
}

const permissionLine = (session: Session): string => {
  const chains = permissionChains(session)
  return `- PermissionRequest: ${chains.length === 0 ? 'none' : chains.map((chain) => `${chain.toolName ?? '?'} → ${chain.outcome}`).join('; ')}`
}

const transcriptLines = (transcript: ClaudeTranscript | undefined, anonymize: Anonymize): string[] =>
  transcript === undefined || transcript.path === null
    ? ['- Transcript: not found']
    : [
        `- Transcript: ${code(anonymize(transcript.path))}, project directory ${code(anonymize(transcript.projectDir ?? ''))}`,
        `- entrypoint in records: ${Object.entries(transcript.entrypoints).map(([name, count]) => `${name} ×${String(count)}`).join(', ') || 'none'}; versions: ${transcript.versions.join(', ') || 'none'}`,
        `- compact_boundary: ${String(transcript.compactBoundaries)}; \`subagents/**/*.jsonl\` files: ${String(transcript.subagentFiles)}`,
      ]

const desktopSection = (input: SummaryInput, labeled: readonly Labeled[]): string[] => {
  const { files, anonymize } = input
  const desktop = labeled.filter(({ session }) => session.runtime === 'claude' && surfaceOf(session) === 'claude-desktop')
  return [
    '## Claude Desktop (spike section 11, steps 1–6)',
    '',
    ...(desktop.length === 0 ? ['No sessions with `CLAUDE_CODE_ENTRYPOINT=claude-desktop`.', ''] : []),
    ...desktop.flatMap(({ label, session }) => {
      const cwds = distinctText(session, null, 'cwd')
      return [
        `### ${label}`,
        '',
        `- CLAUDE_CODE_ENTRYPOINT: ${distinctEnv(session, 'CLAUDE_CODE_ENTRYPOINT').join(', ') || 'none'}; CLAUDE_CODE_HOST_SESSION_ID: ${distinctEnv(session, 'CLAUDE_CODE_HOST_SESSION_ID').join(', ') || 'none'}`,
        `- SessionStart.source: ${distinctText(session, 'SessionStart', 'source').join(', ') || 'no SessionStart'}`,
        `- PreCompact: ${String(countEvents(session, 'PreCompact'))}, PostCompact: ${String(countEvents(session, 'PostCompact'))}`,
        `- SubagentStart: ${String(countEvents(session, 'SubagentStart'))}, SubagentStop: ${String(countEvents(session, 'SubagentStop'))}`,
        `- cwd in \`.claude/worktrees\`: ${yesNo(cwds.some(isClaudeWorktree))}`,
        pairsLine(session),
        permissionLine(session),
        ...transcriptLines(
          files.claudeTranscripts.find((transcript) => transcript.sessionId === session.sessionId),
          anonymize,
        ),
        '',
      ]
    }),
    '### Desktop metadata (`claude-code-sessions/**/local_*.json`)',
    '',
    'Only files of sessions from the spool. Per ADR-0004 (decision 4), values are shown only for `cliSessionId`, `spawnSeed` and `lastSpawnRootDetected`; other keys show only their type. Strings in `spawnSeed` and `lastSpawnRootDetected`, except UUIDs and `local_<uuid>` identifiers, are replaced by their length.',
    '',
    ...(files.desktopSessions.length === 0 ? ['No metadata files for sessions from the spool.', ''] : []),
    ...files.desktopSessions.flatMap((meta) => [
      `#### ${code(meta.file)}`,
      '',
      `- sessionId: ${meta.sessionId ?? '(none)'}; cliSessionId: ${meta.cliSessionId ?? '(none)'}; session in spool: ${labeled.find(({ session }) => session.sessionId === meta.cliSessionId)?.label ?? 'none'}`,
      `- lastSpawnRootDetected: ${json(meta.lastSpawnRootDetected, anonymize)}`,
      `- spawnSeed: ${code(json(meta.spawnSeed, anonymize))}`,
      '',
      '```json',
      JSON.stringify(meta.shape, null, 1),
      '```',
      '',
    ]),
    '### Deletion markers `deleted_<uuid>`',
    '',
    ...table(
      ['File', 'Desktop session', 'Content'],
      files.desktopDeleted.map((marker) => [marker.file, marker.hostSessionId, marker.content]),
      'No deletion markers for sessions from the spool.',
    ),
    '',
  ]
}

const rolloutLines = (rollout: CodexRollout | undefined, anonymize: Anonymize): string[] =>
  rollout === undefined || rollout.path === null
    ? ['- Rollout: not found']
    : [
        `- Rollout: ${code(anonymize(rollout.path))}`,
        `- session_meta: originator ${code(json(rollout.originator, anonymize))}, source ${code(json(rollout.source, anonymize))}, thread_source ${code(json(rollout.thread_source, anonymize))}, parent_thread_id ${code(json(rollout.parent_thread_id, anonymize))}, cli_version ${code(json(rollout.cli_version, anonymize))}`,
        ...rollout.turnContexts.map(
          (context) =>
            `- turn_context: approval_policy ${code(json(context.approval_policy, anonymize))}, sandbox_policy ${code(json(context.sandbox_policy, anonymize))}, workspace_roots ${code(json(context.workspace_roots, anonymize))}; \`~/catacomb-desktop-probe-outside\` among writable roots: ${yesNo(context.outside_probe_writable)}`,
        ),
      ]

const subagentLines = (rollout: CodexRollout, anonymize: Anonymize): string[] => [
  `- Subagent ${code(rollout.sessionId)}: parent_thread_id matches the session_id of the session: ${yesNo(rollout.parent_thread_id === rollout.subagentOf)}`,
  ...rolloutLines(rollout, anonymize).map((line) => `  ${line}`),
]

const codexSection = (input: SummaryInput, labeled: readonly Labeled[]): string[] => {
  const codex = labeled.filter(({ session }) => session.runtime === 'codex')
  const worktrees = join(input.codexHome, 'worktrees')
  return [
    '## Codex (spike section 11, steps 7–10)',
    '',
    ...(codex.length === 0 ? ['No Codex events.', ''] : []),
    ...codex.flatMap(({ label, session }) => [
      `### ${label}`,
      '',
      `- SessionStart.source: ${distinctText(session, 'SessionStart', 'source').join(', ') || 'no SessionStart'}`,
      `- SubagentStart: ${String(countEvents(session, 'SubagentStart'))}, SubagentStop: ${String(countEvents(session, 'SubagentStop'))}`,
      `- cwd in \`$CODEX_HOME/worktrees\`: ${yesNo(distinctText(session, null, 'cwd').some((cwd) => cwd.startsWith(worktrees)))}`,
      pairsLine(session),
      permissionLine(session),
      ...rolloutLines(
        input.files.codexRollouts.find(
          (rollout) => rollout.subagentOf === null && rollout.sessionId === session.sessionId,
        ),
        input.anonymize,
      ),
      ...input.files.codexRollouts
        .filter((rollout) => rollout.subagentOf !== null && rollout.subagentOf === session.sessionId)
        .flatMap((rollout) => subagentLines(rollout, input.anonymize)),
      '',
    ]),
  ]
}

const transcriptsSection = (input: SummaryInput, labeled: readonly Labeled[]): string[] => [
  '## Claude transcripts',
  '',
  ...table(
    ['Session', 'File', 'Records', 'entrypoint', 'Versions', 'compact_boundary', 'subagents'],
    input.files.claudeTranscripts.map((transcript) => [
      labeled.find(({ session }) => session.runtime === 'claude' && session.sessionId === transcript.sessionId)?.label ?? '',
      transcript.path === null ? 'not found' : input.anonymize(transcript.path),
      String(transcript.lines),
      Object.entries(transcript.entrypoints).map(([name, count]) => `${name} ×${String(count)}`).join(', '),
      transcript.versions.join(', '),
      String(transcript.compactBoundaries),
      String(transcript.subagentFiles),
    ]),
    'No Claude sessions.',
  ),
  '',
]

const ownerSection = (): string[] => [
  '## Filled in by the owner',
  '',
  '- (d) How the TUI showed a hook error with exit code 1 on PreToolUse (text, where it appears, whether the tool ran) and a hung hook on UserPromptSubmit (spinner, `statusMessage`, timeout cancellation message after 2 s).',
  '- (a), (b) Whether the terminal was focused while waiting; when the last keystroke happened in the variant with input.',
  '- (e) How each session ended.',
  '- (g) Whether `elicitation_dialog` and `agent_needs_input` could be triggered, and how.',
  '- Desktop, step 3a: whether spawn task or Dispatch is available; the link to the parent in the metadata.',
  '- Desktop, step 4: closing and reopening the app, continuing the same session.',
  '- Desktop, step 6: what happened to the transcript after archiving and deletion.',
  '- Codex, step 7: how trust was granted in the UI, `trustStatus` in the `~/Library/Logs/com.openai.codex/` logs.',
  '- Codex, step 8a: whether an approval request appeared; whether the file was created.',
  '- Codex, step 10: Cloud chat — whether any new rollouts or spool events appeared.',
  '- Desktop limitations for the owner until stage 2 (RFC §4).',
  '',
]

export const renderSummary = (input: SummaryInput): string => {
  const labeled = sessionLabels(input.sessions)
  const claude = labeled.filter(({ session }) => session.runtime === 'claude')
  return [
    ...header(input),
    ...sessionsOverview(labeled, input.anonymize),
    '## Interactive Claude TUI (spike section 6, items a–h)',
    '',
    'All Claude sessions are included; the surface is shown in a column. Time is when `catacomb-hook` received the event (mtime of the spool file).',
    '',
    ...permissionSection(claude),
    ...idleSection(claude),
    ...toolSection('### (c) AskUserQuestion', 'AskUserQuestion', claude, false),
    '### (d) Hook errors and a hung hook — filled in by the owner',
    '',
    'Probes `probes/failure-settings.json`: PreToolUse exits with code 1, UserPromptSubmit hangs longer than `timeout: 2`. The script sees only catacomb events; the owner records what the TUI showed.',
    '',
    ...sessionEndSection(claude),
    ...envProbeSection(input.envProbes, labeled),
    ...notificationSection(claude),
    ...toolSection('### (h) ExitPlanMode', 'ExitPlanMode', claude, true),
    ...desktopSection(input, labeled),
    ...codexSection(input, labeled),
    ...transcriptsSection(input, labeled),
    ...ownerSection(),
  ].join('\n')
}
