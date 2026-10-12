import type {
  Action,
  Agent,
  AttentionItem,
  FactId,
  RunId,
  RunSnapshot,
  Stage,
  StageId,
  StageInspector as Inspected,
  UsageTotals,
} from '@aang/contract'
import { type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { ActionBadge, DecisionBadge, ExecutionBadge } from './badges.js'
import { inputDetail } from './fact-excerpt.js'
import { absoluteTime, clockTime, plural } from './format.js'
import { useGeneration } from './generation.js'
import { AttentionGlyph, LevelGlyph } from './glyphs.js'
import { BasisLine, Grounds, Groundwork, shortId } from './grounds.js'
import { agentRoleLabel, attentionAuthorLabel, attentionKindLabel, executionLabel } from './labels.js'
import { agentTitle } from './objects.js'
import { stageHref, useSelect } from './route.js'
import { fullHint, shortIds, useKnownAgents } from './short-ids.js'
import { StageArtifacts } from './stage-artifacts.js'
import { StageCriteria } from './stage-criteria.js'
import { RejectedCalls, StageHistory } from './stage-history.js'
import { priorityLabel, resolutionLabel, stageOriginLabel } from './stage-labels.js'
import { useRead } from './use-read.js'
import type { RunFeed } from './use-run-feed.js'
import { useStage } from './use-stage.js'
import './inspector.css'

export interface StageInspectorProps {
  readonly run: RunId
  readonly stage: StageId
  readonly feed: RunFeed
  readonly onSignedOut: () => void
  readonly onClose: () => void
}

const recentActions = 8

const actionForms = { one: 'early action', other: 'early actions' } as const

const tokenFormat = new Intl.NumberFormat('en-US')

const tokens = (value: number): string => tokenFormat.format(value)

const costFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })

const Section = ({
  title,
  count,
  children,
}: {
  readonly title: string
  readonly count?: number
  readonly children: ReactNode
}): ReactElement => {
  const heading = useId()
  return (
    <section className="inspector-section" aria-labelledby={heading}>
      <h3 id={heading} className="inspector-section-title">
        {title}
        {count === undefined || count === 0 ? null : <span className="inspector-count">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

const StageLink = ({
  run,
  stage,
  titles,
}: {
  readonly run: RunId
  readonly stage: StageId
  readonly titles: ReadonlyMap<StageId, string>
}): ReactElement => {
  const select = useSelect()
  const agents = useKnownAgents()
  const title = titles.get(stage) ?? `stage ${shortId(stage)}`
  return (
    <a className="stage-link" href={stageHref(run, stage)} onClick={select} title={fullHint(title, agents)}>
      {shortIds(title, agents)}
    </a>
  )
}

const lifecycleNote = (stage: Stage): string | null => {
  switch (stage.lifecycle.state) {
    case 'active':
      return null
    case 'replaced':
      return 'Stage replaced'
    case 'merged':
      return 'Stage merged with others'
    case 'split':
      return 'Stage split'
  }
}

const Axes = ({ stage }: { readonly stage: Stage }): ReactElement => (
  <dl className="axes">
    <div>
      <dt>Execution</dt>
      <dd>
        <ExecutionBadge execution={stage.execution.value} />
        {stage.execution.basis.kind === 'observed' ? null : <BasisLine basis={stage.execution.basis} />}
      </dd>
    </div>
    <div>
      <dt>Basis</dt>
      <dd>
        <BasisLine basis={stage.basis} />
      </dd>
    </div>
    <div>
      <dt>Human decision</dt>
      <dd>
        <DecisionBadge decision={stage.decision.value} basis={stage.decision.basis} />
      </dd>
    </div>
  </dl>
)

const Warnings = ({ stage, attention }: { readonly stage: Stage; readonly attention: readonly AttentionItem[] }): ReactElement | null => {
  const claim = stage.execution_claim
  const conflict = claim !== null && claim.value.state !== stage.execution.value.state ? claim : null
  const failedCheck = attention.some(({ kind, resolution }) => kind === 'failed_check' && resolution === 'open')
  if (conflict === null && !failedCheck) {
    return null
  }
  return (
    <ul className="inspector-warnings">
      {conflict === null ? null : (
        <li>
          <LevelGlyph level="caution" />
          <span>
            The observer claims "{executionLabel(conflict.value)}", but events show the stage as "
            {executionLabel(stage.execution.value)}". Showing what was observed.
          </span>
        </li>
      )}
      {failedCheck ? (
        <li data-level="warning">
          <LevelGlyph level="warning" />
          <span>
            {stage.execution.value.state === 'done' ? 'Done, but a check failed' : 'A check failed'}
          </span>
        </li>
      ) : null}
    </ul>
  )
}

const Purpose = ({ stage }: { readonly stage: Stage }): ReactElement | null =>
  stage.expected_result === null && stage.summary === null ? null : (
    <dl className="purpose">
      {stage.expected_result === null ? null : (
        <div>
          <dt>Expected result</dt>
          <dd>{stage.expected_result}</dd>
        </div>
      )}
      {stage.summary === null ? null : (
        <div>
          <dt>Summary</dt>
          <dd>{stage.summary}</dd>
        </div>
      )}
    </dl>
  )

const AttentionEntry = ({ item }: { readonly item: AttentionItem }): ReactElement => (
  <li className="attention-entry" data-open={item.resolution === 'open'}>
    <p className="attention-kind">
      <AttentionGlyph kind={item.kind} />
      <span>{attentionKindLabel[item.kind]}</span>
      <span>{item.resolution === 'open' && item.runtime_wait === 'active' ? 'awaiting an answer' : resolutionLabel[item.resolution]}</span>
      <span>{attentionAuthorLabel[item.author]}</span>
      {item.priority === null ? null : <span>recommended: {priorityLabel[item.priority.value]} priority</span>}
    </p>
    <p className="attention-text">{item.text}</p>
    {item.likely_resolved === null ? null : <p className="attention-note">Probably already answered: the item stays open until dismissed.</p>}
    <Grounds basis={item.basis} evidence={item.evidence} label={`${attentionKindLabel[item.kind]}: ${item.text}`} />
  </li>
)

const AttentionList = ({ items }: { readonly items: readonly AttentionItem[] }): ReactElement => {
  const ordered = items.toSorted(
    (left, right) => Number(right.resolution === 'open') - Number(left.resolution === 'open') || Number(left.opened_at - right.opened_at),
  )
  return (
    <ul className="attention-list">
      {ordered.map((item) => (
        <AttentionEntry key={item.id} item={item} />
      ))}
    </ul>
  )
}

const activeTime = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) {
    return `${String(seconds)} s`
  }
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${String(minutes)} min ${String(seconds % 60)} s` : `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`
}

const UsageRow = ({ label, totals }: { readonly label: string; readonly totals: UsageTotals }): ReactElement => (
  <tr>
    <th scope="row">{label}</th>
    <td className="number">{tokens(totals.tokens.uncached_input_tokens)}</td>
    <td className="number">{tokens(totals.tokens.cache_read_input_tokens + totals.tokens.cache_write_input_tokens)}</td>
    <td className="number">
      {tokens(totals.tokens.output_tokens)}
      {totals.output_lower_bound ? <span className="lower-bound"> at least</span> : null}
    </td>
    <td className="number">{totals.records}</td>
  </tr>
)

const SolverUsage = ({ usage }: { readonly usage: Inspected['usage'] }): ReactElement => {
  const costs = [usage.stage.cost_usd, usage.unassigned_in_sessions.cost_usd].filter((cost): cost is number => cost !== null)
  if (usage.stage.records === 0 && usage.unassigned_in_sessions.records === 0) {
    return (
      <div className="usage-empty">
        <p className="usage-caption">Solver usage, tokens</p>
        <p className="section-empty">No usage records for this stage.</p>
      </div>
    )
  }
  return (
    <>
      <table className="usage">
        <caption>Solver usage, tokens</caption>
        <thead>
          <tr>
            <td />
            <th scope="col" className="number">
              Input
            </th>
            <th scope="col" className="number">
              Cache
            </th>
            <th scope="col" className="number">
              Output
            </th>
            <th scope="col" className="number">
              Records
            </th>
          </tr>
        </thead>
        <tbody>
          <UsageRow label="Stage" totals={usage.stage} />
          <UsageRow label="Not assigned to stages" totals={usage.unassigned_in_sessions} />
        </tbody>
      </table>
      <p className="usage-note">
        "Not assigned to stages" is usage from the stage’s sessions that cannot be attributed entirely to any one stage.
        {costs.length === 0 ? null : (
          <>
            {' '}
            Cost {costFormat.format(costs.reduce((sum, cost) => sum + cost, 0))} at list price; under a subscription it is not a
            charge.
          </>
        )}
      </p>
    </>
  )
}

const TimeAndUsage = ({ inspected }: { readonly inspected: Inspected }): ReactElement => {
  const { time, usage } = inspected
  return (
    <>
      {time.started_at === null ? (
        <p className="section-empty">No timed actions are assigned to the stage.</p>
      ) : (
        <dl className="figures">
          <div>
            <dt>Start</dt>
            <dd>{absoluteTime(time.started_at)}</dd>
          </div>
          <div>
            <dt>End</dt>
            <dd>{time.ended_at === null ? 'still running' : absoluteTime(time.ended_at)}</dd>
          </div>
          <div>
            <dt>Active time</dt>
            <dd>{time.active_ms === null ? '—' : activeTime(time.active_ms)}</dd>
          </div>
        </dl>
      )}
      <SolverUsage usage={usage} />
    </>
  )
}

const ActionDetail = ({ fact }: { readonly fact: FactId }): ReactElement | null => {
  const { facts } = useGeneration()
  const read = useRead(facts, fact)
  if (read.kind !== 'ready' || read.value.kind !== 'action_start') {
    return null
  }
  const detail = inputDetail(read.value.payload.input)
  return detail === null ? null : (
    <code className="action-detail" title={detail}>
      {detail}
    </code>
  )
}

const ActionEntry = ({ action }: { readonly action: Action }): ReactElement => {
  const at = action.started_at ?? action.ended_at
  return (
    <li className="action-entry">
      <span className="action-state">
        <ActionBadge action={action} />
      </span>
      <span className="action-tool">{action.tool}</span>
      <span className="action-body">
        {action.input_fact === null ? null : <ActionDetail fact={action.input_fact} />}
        {action.inherited ? <span className="action-note">inherited from the source session</span> : null}
      </span>
      {at === null ? <span /> : <time className="action-time">{clockTime(at)}</time>}
    </li>
  )
}

const compareStart = (left: Action, right: Action): number => {
  const a = left.started_at ?? left.ended_at
  const b = right.started_at ?? right.ended_at
  return a === b ? (left.id < right.id ? -1 : 1) : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1
}

const Participants = ({ agents, actions }: { readonly agents: readonly Agent[]; readonly actions: readonly Action[] }): ReactElement => {
  const [all, setAll] = useState(false)
  const ordered = actions.toSorted(compareStart)
  const hidden = all ? 0 : Math.max(0, ordered.length - recentActions)
  const shown = ordered.slice(hidden)
  if (agents.length === 0 && actions.length === 0) {
    return <p className="section-empty">The observer has not assigned agents or actions to the stage.</p>
  }
  return (
    <>
      {agents.length === 0 ? null : (
        <ul className="participants" aria-label="Stage agents">
          {agents.map((agent) => (
            <li key={agent.id}>
              <span className="participant-name">{agentTitle(agent)}</span>
              {agent.role === 'main' ? null : <span className="participant-role">{agentRoleLabel[agent.role]}</span>}
              <ExecutionBadge execution={agent.execution} />
            </li>
          ))}
        </ul>
      )}
      {actions.length === 0 ? null : (
        <ol className="action-list" aria-label="Stage actions">
          {hidden === 0 && !all ? null : (
            <li className="action-toggle">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setAll(!all)
                }}
              >
                {all ? 'Hide early actions' : `Show ${plural(hidden, actionForms)}`}
              </button>
            </li>
          )}
          {shown.map((action) => (
            <ActionEntry key={action.id} action={action} />
          ))}
        </ol>
      )}
    </>
  )
}

const RelationRow = ({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement => (
  <div>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
)

const StageLinks = ({
  run,
  stages,
  titles,
}: {
  readonly run: RunId
  readonly stages: readonly StageId[]
  readonly titles: ReadonlyMap<StageId, string>
}): ReactElement => (
  <ul className="stage-links">
    {stages.map((stage) => (
      <li key={stage}>
        <StageLink run={run} stage={stage} titles={titles} />
      </li>
    ))}
  </ul>
)

const successorLabel = (stage: Stage): string => {
  switch (stage.lifecycle.state) {
    case 'merged':
      return 'Merged into'
    case 'split':
      return 'Split into'
    default:
      return 'Replaced by'
  }
}

const Relations = ({
  run,
  inspected,
  titles,
}: {
  readonly run: RunId
  readonly inspected: Inspected
  readonly titles: ReadonlyMap<StageId, string>
}): ReactElement => {
  const { stage, children, predecessors, successors, dependencies } = inspected
  const needs = dependencies.flatMap((link) => (link.kind === 'dependency' && link.stage === stage.id ? [link.depends_on] : []))
  const neededBy = dependencies.flatMap((link) => (link.kind === 'dependency' && link.depends_on === stage.id ? [link.stage] : []))
  const rows: [string, readonly StageId[]][] = [
    ['Part of', stage.parent === null ? [] : [stage.parent]],
    ['Substages', children],
    ['Depends on', needs],
    ['Needed by', neededBy],
    ['Replaces', predecessors],
    [successorLabel(stage), successors],
  ]
  const present = rows.filter(([, stages]) => stages.length > 0)
  if (present.length === 0) {
    return <p className="section-empty">No links to other stages.</p>
  }
  return (
    <dl className="relations">
      {present.map(([label, stages]) => (
        <RelationRow key={label} label={label}>
          <StageLinks run={run} stages={stages} titles={titles} />
        </RelationRow>
      ))}
    </dl>
  )
}

const Statements = ({ stage }: { readonly stage: Stage }): ReactElement => {
  const claim = stage.execution_claim
  return (
    <ul className="statements">
      <li>
        <p className="statement">Stage and its description</p>
        <Grounds basis={stage.basis} evidence={stage.evidence} label="Stage and its description" />
      </li>
      <li>
        <p className="statement">Execution: {executionLabel(stage.execution.value)}</p>
        <Grounds basis={stage.execution.basis} evidence={stage.execution.evidence} label="Execution" />
      </li>
      {claim === null ? null : (
        <li>
          <p className="statement">Observer claim: {executionLabel(claim.value)}</p>
          <Grounds basis={claim.basis} evidence={claim.evidence} label="Observer claim" />
        </li>
      )}
      <li>
        <p className="statement">Human decision</p>
        <Grounds basis={stage.decision.basis} evidence={stage.decision.evidence} label="Human decision" />
      </li>
    </ul>
  )
}

const Body = ({
  run,
  inspected,
  titles,
  objects,
}: {
  readonly run: RunId
  readonly inspected: Inspected
  readonly titles: ReadonlyMap<StageId, string>
  readonly objects: RunSnapshot['objects'] | null
}): ReactElement => {
  const { stage, attention, criteria, inputs, outputs, history, evidence } = inspected
  const rejected = inspected.observer_calls.filter(({ outcome }) => outcome === 'rejected')
  return (
    <Groundwork value={{ objects, known: new Map(evidence.map((fact) => [fact.id, fact])) }}>
      <Axes stage={stage} />
      <Warnings stage={stage} attention={attention} />
      <Purpose stage={stage} />
      {attention.length === 0 ? null : (
        <Section title="Attention" count={attention.filter(({ resolution }) => resolution === 'open').length}>
          <AttentionList items={attention} />
        </Section>
      )}
      <Section title="Criteria" count={criteria.length}>
        <StageCriteria criteria={criteria} />
      </Section>
      <Section title="Inputs and outputs" count={inputs.length + outputs.length}>
        <StageArtifacts inputs={inputs} outputs={outputs} actions={objects?.actions ?? inspected.actions} />
      </Section>
      <Section title="Time and usage">
        <TimeAndUsage inspected={inspected} />
      </Section>
      <Section title="Participants and actions">
        <Participants agents={inspected.agents} actions={inspected.actions} />
      </Section>
      <Section title="Links">
        <Relations run={run} inspected={inspected} titles={titles} />
      </Section>
      <Section title="Grounds" count={evidence.length}>
        <Statements stage={stage} />
      </Section>
      <Section title="History" count={history.length}>
        <StageHistory history={history} />
      </Section>
      {rejected.length === 0 ? null : (
        <Section title="Rejected observer responses" count={rejected.length}>
          <RejectedCalls calls={rejected} />
        </Section>
      )}
    </Groundwork>
  )
}

const Inspection = ({
  run,
  stage,
  snapshot,
  onSignedOut,
}: {
  readonly run: RunId
  readonly stage: StageId
  readonly snapshot: RunSnapshot | null
  readonly onSignedOut: () => void
}): ReactElement => {
  const load = useStage(run, stage, snapshot?.change_seq ?? null, onSignedOut)
  const titles = new Map((snapshot?.model.stages ?? []).map(({ id, title }) => [id, title]))
  return (
    <>
      {load.kind === 'ready' && load.failing ? (
        <p className="inspector-trouble" role="status">
          Lost connection to the daemon: showing the last received state, retrying the update.
        </p>
      ) : null}
      {load.kind === 'ready' ? (
        <Body run={run} inspected={load.inspector} titles={titles} objects={snapshot?.objects ?? null} />
      ) : load.kind === 'missing' ? (
        <p className="inspector-trouble">
          This run has no stage <code>{shortId(stage)}</code>: the link is stale or the run was rebuilt.
        </p>
      ) : load.kind === 'failing' ? (
        <p className="inspector-trouble" role="status">
          Could not load the stage, retrying in a second.
        </p>
      ) : (
        <p className="loading">Loading stage…</p>
      )}
    </>
  )
}

export const StageInspector = ({ run, stage, feed, onSignedOut, onClose }: StageInspectorProps): ReactElement => {
  const { snapshot, generation } = feed
  const heading = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  const known = snapshot?.model.stages.find(({ id }) => id === stage) ?? null
  const title = known?.title ?? `Stage ${shortId(stage)}`
  const agents = useKnownAgents()

  useEffect(() => {
    heading.current?.focus()
  }, [])

  return (
    <aside
      className="inspector"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onClose()
        }
      }}
    >
      <header className="inspector-head">
        <div className="inspector-heading">
          <p className="inspector-kind">
            <span>Stage</span>
            {known === null ? null : <span>{stageOriginLabel[known.origin]}</span>}
            {known === null || lifecycleNote(known) === null ? null : <span className="inspector-lifecycle">{lifecycleNote(known)}</span>}
          </p>
          <h2 id={titleId} ref={heading} tabIndex={-1} className="inspector-title" title={fullHint(title, agents)}>
            {shortIds(title, agents)}
          </h2>
        </div>
        <button type="button" className="inspector-close" onClick={onClose}>
          Close
        </button>
      </header>
      <Inspection key={generation.ordinal} run={run} stage={stage} snapshot={snapshot} onSignedOut={onSignedOut} />
    </aside>
  )
}
