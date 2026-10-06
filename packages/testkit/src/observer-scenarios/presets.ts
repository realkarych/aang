import type { ScenarioScript } from './scripts.js'

export type ObserverScenarioReply =
  | { readonly kind: 'script'; readonly script: ScenarioScript }
  | { readonly kind: 'limit' }

export interface ObserverScenarioPhase {
  readonly replies: ObserverScenarioReply[]
  readonly chatReplies: ObserverScenarioReply[]
}

const script = (name: ScenarioScript): ObserverScenarioReply => ({ kind: 'script', script: name })

const phase = (replies: ObserverScenarioReply[], chatReplies: ObserverScenarioReply[] = []): ObserverScenarioPhase => ({
  replies,
  chatReplies,
})

export const observerScenarios = {
  'live-map': { live: phase([script('map')]) },
  'map-layout': { live: phase([script('map-layout')]) },
  'map-branches': { live: phase([script('map-branches')]) },
  'map-nested': { live: phase([script('map-nested')]) },
  'claimed-done': { live: phase([script('claimed-done')]) },
  'since-last-view': { before: phase([script('map')]), after: phase([script('revision')]) },
  report: { live: phase([script('report')]) },
  'rejected-answer': { live: phase([script('map'), script('rejected'), script('map')]) },
  'revised-decisions': { before: phase([script('outline')]), after: phase([script('reshape')]) },
  'stage-succession': {
    live: phase([script('map')]),
    revised: phase([script('revision')]),
    split: phase([script('split')]),
    merged: phase([script('merge')]),
  },
  chat: { live: phase([script('map')], [script('chat-answer'), script('chat-collapse-reviewers')]) },
  'old-ground': { live: phase([script('map')], [script('chat-old-ground')]) },
  'llm-failure': {
    healthy: phase([script('map')]),
    failing: phase([{ kind: 'limit' }]),
    recovered: phase([script('map')]),
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, ObserverScenarioPhase>>>>

export type ObserverScenarioName = keyof typeof observerScenarios
