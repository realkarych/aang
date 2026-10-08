import type { AppliedViewRule, RunSnapshot, ViewRuleId } from '@aang/contract'
import { type ReactElement, useId, useState } from 'react'
import { failureText, revokeViewRule, SignedOut } from './api.js'
import { plural } from './format.js'
import { agentForms } from './labels.js'
import { Moment } from './moment.js'
import { elementForms, ruleSourceLabel, ruleText } from './view-labels.js'
import './view.css'

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

const RuleItem = ({
  applied,
  snapshot,
  revoking,
  onRevoke,
  now,
}: {
  readonly applied: AppliedViewRule
  readonly snapshot: RunSnapshot
  readonly revoking: boolean
  readonly onRevoke: () => void
  readonly now: bigint
}): ReactElement => {
  const { rule, affected } = applied
  const text = capitalized(ruleText(rule, snapshot.model.stages))
  return (
    <li className="rule">
      <p className="rule-text">{text}</p>
      <p className="rule-meta">
        <span>{ruleSourceLabel[rule.source]}</span>
        <span>{`затронуто: ${plural(affected.length, elementForms)}`}</span>
        <Moment at={rule.created_at} now={now} />
      </p>
      <button
        type="button"
        className="rule-revoke"
        aria-label={`Отменить правило: ${text}`}
        disabled={revoking}
        onClick={onRevoke}
      >
        {revoking ? 'Отменяется…' : 'Отменить'}
      </button>
    </li>
  )
}

export const ViewRules = ({
  snapshot,
  now,
  onSignedOut,
}: {
  readonly snapshot: RunSnapshot
  readonly now: bigint
  readonly onSignedOut: () => void
}): ReactElement => {
  const heading = useId()
  const [revoking, setRevoking] = useState<ReadonlySet<ViewRuleId>>(() => new Set())
  const [failure, setFailure] = useState<string | null>(null)
  const { rules, placements } = snapshot.view
  const folded = placements.filter(
    ({ element, visibility }) => element.kind === 'agent' && visibility?.state === 'collapsed' && visibility.rule === null,
  ).length
  const revoke = async (id: ViewRuleId): Promise<void> => {
    setFailure(null)
    setRevoking((current) => new Set(current).add(id))
    try {
      await revokeViewRule(snapshot.summary.id, id)
    } catch (error) {
      setRevoking((current) => new Set([...current].filter((known) => known !== id)))
      if (error instanceof SignedOut) {
        onSignedOut()
        return
      }
      setFailure(failureText(error))
    }
  }
  return (
    <section className="rules" aria-labelledby={heading}>
      <h2 id={heading} className="section-title">
        Правила вида
      </h2>
      {rules.length === 0 ? (
        <p className="rules-empty">
          Активных правил нет. Попросите чат свернуть, скрыть или сгруппировать агентов, этапы или действия — правило
          появится здесь.
        </p>
      ) : (
        <ol className="rules-list" aria-label="Активные правила">
          {rules.map((applied) => (
            <RuleItem
              key={applied.rule.id}
              applied={applied}
              snapshot={snapshot}
              revoking={revoking.has(applied.rule.id)}
              onRevoke={() => {
                void revoke(applied.rule.id)
              }}
              now={now}
            />
          ))}
        </ol>
      )}
      {failure === null ? null : (
        <p className="rules-error" role="alert">
          {`Правило не отменено: ${failure}`}
        </p>
      )}
      <p className="rules-note">
        Правила меняют только вид: модель, журнал и расход остаются прежними, а вопросы скрытых элементов остаются в
        зоне внимания. {`Служебные агенты свёрнуты по умолчанию${folded === 0 ? '' : ` (${plural(folded, agentForms)})`}.`}
      </p>
    </section>
  )
}
