import type { RunSnapshot, ViewRuleId } from '@aang/contract'
import { type ReactElement, useState } from 'react'
import { failureText, revokeViewRule, SignedOut } from './api.js'
import { fullHint, shortIds, useKnownAgents } from './short-ids.js'
import { changesStageMap, noStageMapEffect, ruleText } from './view-labels.js'

export const FilterChips = ({
  snapshot,
  onSignedOut,
}: {
  readonly snapshot: RunSnapshot
  readonly onSignedOut: () => void
}): ReactElement | null => {
  const agents = useKnownAgents()
  const [removing, setRemoving] = useState<ReadonlySet<ViewRuleId>>(() => new Set())
  const [failure, setFailure] = useState<string | null>(null)
  const { rules } = snapshot.view
  if (rules.length === 0 && failure === null) {
    return null
  }
  const remove = async (id: ViewRuleId): Promise<void> => {
    setFailure(null)
    setRemoving((current) => new Set(current).add(id))
    try {
      await revokeViewRule(snapshot.summary.id, id)
    } catch (error) {
      setRemoving((current) => new Set([...current].filter((known) => known !== id)))
      if (error instanceof SignedOut) {
        onSignedOut()
        return
      }
      setFailure(failureText(error))
    }
  }
  return (
    <div className="filters">
      <ul className="filter-chips" aria-label="Active filters">
        {rules.map(({ rule }) => {
          const full = ruleText(rule, snapshot.model.stages)
          const text = shortIds(full, agents)
          return (
            <li key={rule.id} className="filter-chip" title={fullHint(full, agents)}>
              <span>{changesStageMap(rule) ? `Filter: ${text}` : `Filter: ${text} · ${noStageMapEffect}`}</span>
              <button
                type="button"
                aria-label={`Remove filter: ${text}`}
                disabled={removing.has(rule.id)}
                onClick={() => {
                  void remove(rule.id)
                }}
              >
                ✕
              </button>
            </li>
          )
        })}
      </ul>
      {failure === null ? null : (
        <p className="filters-error" role="alert">
          {`Filter not removed: ${failure}`}
        </p>
      )}
    </div>
  )
}
