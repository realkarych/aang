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
  'claimed-done': { live: phase([script('claimed-done')]) },
  'attention-zone': { live: phase([script('attention')]) },
  'since-last-view': { before: phase([script('map')]), after: phase([script('revision')]) },
  chat: { live: phase([script('map')], [script('chat-answer'), script('chat-collapse-reviewers')]) },
  'llm-failure': {
    healthy: phase([script('map')]),
    failing: phase([{ kind: 'limit' }]),
    recovered: phase([script('map')]),
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, ObserverScenarioPhase>>>>

export type ObserverScenarioName = keyof typeof observerScenarios
