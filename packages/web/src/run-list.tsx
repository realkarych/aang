import type { RunSummary, WatchState } from '@aang/contract'
import type { ReactElement } from 'react'
import { AttentionBadge, ExecutionBadge, FreshnessBadge } from './badges.js'
import { dayTime } from './format.js'
import { LevelGlyph } from './glyphs.js'
import { runtimeLabel, supportModeLabel } from './labels.js'
import { Moment } from './moment.js'
import { runHref, useNavigate } from './route.js'

export const runTitle = ({ goal, brief }: Pick<RunSummary, 'goal' | 'brief'>): string | null => goal ?? brief

export const untitledRun = ({ runtime, created_at: created }: Pick<RunSummary, 'runtime' | 'created_at'>): string =>
  `${runtimeLabel[runtime]}, started ${dayTime(created)}`

const EmptyList = ({ watch }: { readonly watch: WatchState | null }): ReactElement => (
  <div className="empty">
    <h2>No runs yet</h2>
    {watch === null ? null : watch.all ? (
      <p>aang watches all directories. Start Claude Code or Codex, and the run will appear here.</p>
    ) : watch.roots.length === 0 ? (
      <p>
        No directory is being watched. Add a project with <code>aang watch &lt;directory&gt;</code> and start
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

const forkOrigin = (source: RunSummary | undefined): string =>
  source === undefined ? 'fork' : `fork of "${runTitle(source) ?? untitledRun(source)}"`

interface RunRowProps {
  readonly run: RunSummary
  readonly runs: readonly RunSummary[]
  readonly now: bigint
}

const RunRow = ({ run, runs, now }: RunRowProps): ReactElement => {
  const navigate = useNavigate()
  const title = runTitle(run)
  return (
    <tr>
      <td data-label="State">
        <ExecutionBadge execution={run.execution} />
      </td>
      <td className="run-cell">
        <a className="run-link" href={runHref(run.id)} onClick={navigate} title={title ?? undefined}>
          <span className="run-name">{title ?? <span className="untitled">{untitledRun(run)}</span>}</span>
        </a>
        <span className="run-origin">
          {title === null ? <span>goal unknown</span> : <span>{runtimeLabel[run.runtime]}</span>}
          {run.forked_from === null ? null : (
            <span>{forkOrigin(runs.find(({ id }) => id === run.forked_from))}</span>
          )}
          {run.start_pruned ? <span>start pruned</span> : null}
        </span>
      </td>
      <td data-label="Attention">
        <AttentionBadge attention={run.attention} />
      </td>
      <td data-label="Freshness">
        <FreshnessBadge freshness={run.freshness} />
      </td>
      <td data-label="Mode">{run.support_modes.map((mode) => supportModeLabel[mode]).join(', ')}</td>
      <td data-label="Sessions" className="number">
        {run.sessions}
      </td>
      <td data-label="Agents" className="number">
        {run.agents}
      </td>
      <td data-label="Last event">
        <Moment at={run.last_event_at} now={now} />
      </td>
    </tr>
  )
}

const ListTrouble = ({ children }: { readonly children: string }): ReactElement => (
  <p className="list-trouble" role="status">
    <LevelGlyph level="warning" />
    <span>{children}</span>
  </p>
)

const RunTable = ({ runs, now }: { readonly runs: readonly RunSummary[]; readonly now: bigint }): ReactElement => (
  <table className="runs">
    <caption className="visually-hidden">Runs</caption>
    <thead>
      <tr>
        <th scope="col">State</th>
        <th scope="col">Run</th>
        <th scope="col">Attention</th>
        <th scope="col">Freshness</th>
        <th scope="col">Mode</th>
        <th scope="col" className="number">
          Sessions
        </th>
        <th scope="col" className="number">
          Agents
        </th>
        <th scope="col">Last event</th>
      </tr>
    </thead>
    <tbody>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} runs={runs} now={now} />
      ))}
    </tbody>
  </table>
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
      <ListTrouble>Could not load the run list. aang keeps retrying.</ListTrouble>
    ) : (
      <p className="loading">Loading runs…</p>
    )
  }
  return (
    <>
      {failing ? (
        <ListTrouble>Could not refresh the run list. Showing earlier data, which may be stale.</ListTrouble>
      ) : null}
      {runs.length === 0 ? <EmptyList watch={watch} /> : <RunTable runs={runs} now={now} />}
    </>
  )
}
