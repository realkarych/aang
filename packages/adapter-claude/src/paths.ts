export type SnapshotFile =
  | { readonly kind: 'agent_meta'; readonly session: string; readonly agent: string }
  | { readonly kind: 'workflow'; readonly session: string }
  | { readonly kind: 'team'; readonly team: string }
  | { readonly kind: 'tool_result'; readonly session: string }

export interface WorkflowJournal {
  readonly session: string
  readonly run: string
}

const agentMetaPath = /(?:^|[\\/])([^\\/]+)[\\/]subagents[\\/](?:workflows[\\/][^\\/]+[\\/])?agent-([^\\/]+)\.meta\.json$/

const workflowPath = /(?:^|[\\/])(?!subagents[\\/])([^\\/]+)[\\/]workflows[\\/]wf_[^\\/]+\.json$/

const teamPath = /(?:^|[\\/])teams[\\/]([^\\/]+)[\\/]config\.json$/

const toolResultPath = /(?:^|[\\/])([^\\/]+)[\\/]tool-results[\\/][^\\/]+$/

const workflowJournalPath = /(?:^|[\\/])([^\\/]+)[\\/]subagents[\\/]workflows[\\/]([^\\/]+)[\\/]journal\.jsonl$/

export const snapshotFile = (path: string): SnapshotFile | null => {
  const session = toolResultPath.exec(path)?.[1]
  if (session !== undefined) {
    return { kind: 'tool_result', session }
  }
  const meta = agentMetaPath.exec(path)
  if (meta?.[1] !== undefined && meta[2] !== undefined) {
    return { kind: 'agent_meta', session: meta[1], agent: meta[2] }
  }
  const workflow = workflowPath.exec(path)?.[1]
  if (workflow !== undefined) {
    return { kind: 'workflow', session: workflow }
  }
  const team = teamPath.exec(path)?.[1]
  return team === undefined ? null : { kind: 'team', team }
}

export const workflowJournal = (path: string): WorkflowJournal | null => {
  const [, session, run] = workflowJournalPath.exec(path) ?? []
  return session === undefined || run === undefined ? null : { session, run }
}
