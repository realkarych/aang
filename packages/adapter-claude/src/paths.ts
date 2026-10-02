export type SnapshotFile =
  | { readonly kind: 'agent_meta'; readonly session: string; readonly agent: string; readonly workflow: boolean }
  | { readonly kind: 'workflow'; readonly session: string }
  | { readonly kind: 'team'; readonly team: string }

export interface WorkflowJournal {
  readonly session: string
}

const agentMetaPath = /(?:^|[\\/])([^\\/]+)[\\/]subagents[\\/](workflows[\\/][^\\/]+[\\/])?agent-([^\\/]+)\.meta\.json$/

const workflowPath = /(?:^|[\\/])(?!subagents[\\/])([^\\/]+)[\\/]workflows[\\/]wf_[^\\/]+\.json$/

const teamPath = /(?:^|[\\/])teams[\\/]([^\\/]+)[\\/]config\.json$/

const workflowJournalPath = /(?:^|[\\/])([^\\/]+)[\\/]subagents[\\/]workflows[\\/][^\\/]+[\\/]journal\.jsonl$/

export const snapshotFile = (path: string): SnapshotFile | null => {
  const meta = agentMetaPath.exec(path)
  if (meta?.[1] !== undefined && meta[3] !== undefined) {
    return { kind: 'agent_meta', session: meta[1], agent: meta[3], workflow: meta[2] !== undefined }
  }
  const workflow = workflowPath.exec(path)?.[1]
  if (workflow !== undefined) {
    return { kind: 'workflow', session: workflow }
  }
  const team = teamPath.exec(path)?.[1]
  return team === undefined ? null : { kind: 'team', team }
}

export const workflowJournal = (path: string): WorkflowJournal | null => {
  const session = workflowJournalPath.exec(path)?.[1]
  return session === undefined ? null : { session }
}
