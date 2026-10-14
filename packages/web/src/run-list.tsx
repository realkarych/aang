import type { RunSummary, WatchState } from '@catacomb/contract'
import type { ReactElement } from 'react'
import { ExecutionBadge } from './badges.js'
import { dayTime } from './format.js'
import { LevelGlyph } from './glyphs.js'
import { runtimeLabel } from './labels.js'
import { Moment } from './moment.js'
import { runHref, useNavigate } from './route.js'

export const runTitle = ({ goal, brief }: Pick<RunSummary, 'goal' | 'brief'>): string | null => goal ?? brief

export const untitledRun = ({ runtime, created_at: created }: Pick<RunSummary, 'runtime' | 'created_at'>): string =>
  `${runtimeLabel[runtime]}, started ${dayTime(created)}`

const EmptyList = ({ watch }: { readonly watch: WatchState | null }): ReactElement => (
  <div className="empty">
    <h2>No runs yet</h2>
    {watch === null ? null : watch.all ? (
      <p>catacomb watches all directories. Start Claude Code or Codex, and the run will appear here.</p>
    ) : watch.roots.length === 0 ? (
      <p>
        No directory is being watched. Add a project with <code>catacomb watch &lt;directory&gt;</code> and start
        Claude Code or Codex in it.
      </p>
    ) : (
      <>
        <p>Start Claude Code or Codex in a watched directory, and the run will appear here.</p>
        <ul className="roots">
          {watch.roots.map((root) => (
            <li key={root}>
              <code>{root}</code>
            </li>
          ))}
        </ul>
      </>
    )}
  </div>
)

const folderOf = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || cwd

const newestFirst = (left: RunSummary, right: RunSummary): number =>
  Math.sign(Number(right.last_event_at - left.last_event_at))

const ChatRow = ({ run, now }: { readonly run: RunSummary; readonly now: bigint }): ReactElement => {
  const navigate = useNavigate()
  const title = runTitle(run)
  const waiting = run.attention.open
  return (
    <li className="chat-row">
      <a className="chat-row-link" href={runHref(run.id)} onClick={navigate} title={title ?? undefined}>
        <span className="chat-row-goal">{title ?? <span className="untitled">{untitledRun(run)}</span>}</span>
        {run.cwd === null ? null : (
          <span className="chat-row-folder" title={run.cwd}>
            {folderOf(run.cwd)}
          </span>
        )}
        <ExecutionBadge execution={run.execution} />
        {waiting === 0 ? null : (
          <span className="chat-row-waiting">
            <span className="visually-hidden">Waiting for you: </span>
            <LevelGlyph level="caution" />
            {waiting}
          </span>
        )}
        <span className="chat-row-time">
          <Moment at={run.last_event_at} now={now} />
        </span>
      </a>
    </li>
  )
}

const ListTrouble = ({ children }: { readonly children: string }): ReactElement => (
  <p className="list-trouble" role="status">
    <LevelGlyph level="warning" />
    <span>{children}</span>
  </p>
)

const ChatRows = ({ runs, now }: { readonly runs: readonly RunSummary[]; readonly now: bigint }): ReactElement => (
  <ul className="chats" aria-label="Chats">
    {[...runs].sort(newestFirst).map((run) => (
      <ChatRow key={run.id} run={run} now={now} />
    ))}
  </ul>
)

export interface RunListProps {
  readonly runs: readonly RunSummary[] | null
  readonly failing: boolean
  readonly watch: WatchState | null
  readonly now: bigint
}

export const RunList = ({ runs, failing, watch, now }: RunListProps): ReactElement => {
  if (runs === null) {
    return failing ? (
      <ListTrouble>Could not load the run list. catacomb keeps retrying.</ListTrouble>
    ) : (
      <p className="loading">Loading runs…</p>
    )
  }
  return (
    <>
      {failing ? (
        <ListTrouble>Could not refresh the run list. Showing earlier data, which may be stale.</ListTrouble>
      ) : null}
      {runs.length === 0 ? <EmptyList watch={watch} /> : <ChatRows runs={runs} now={now} />}
    </>
  )
}
