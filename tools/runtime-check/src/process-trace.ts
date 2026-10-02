import { z } from 'zod'

export const StartedProcess = z.object({
  pid: z.number(),
  ppid: z.number(),
  name: z.string(),
  parentName: z.string().nullable(),
  createdAt: z.string().regex(/^\d+$/),
  receivedAt: z.string().regex(/^\d+$/).optional(),
})
type StartedProcess = z.infer<typeof StartedProcess>

export interface ProcessTraceEvidence {
  readonly rootPid: number
  readonly rootName: string
  readonly harnessPid: number
  readonly observerPid: number
  readonly started: readonly StartedProcess[]
}

export const nameCounts = (processes: readonly { readonly name: string | null }[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const { name } of processes) {
    const key = name ?? '?'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export const describeProcessTrace = (evidence: ProcessTraceEvidence) => {
  const { rootPid, rootName, harnessPid, observerPid, started } = evidence
  const identities = new Map<string, StartedProcess>()
  for (const event of started) {
    const identity = `${String(event.pid)}:${String(BigInt(event.createdAt))}`
    const previous = identities.get(identity)
    if (previous !== undefined && (previous.ppid !== event.ppid || previous.name !== event.name)) {
      throw new Error(`Conflicting process trace identity: ${identity}`)
    }
    identities.set(identity, event)
  }
  const ordered = [...identities.values()].sort((left, right) => {
    const difference = BigInt(left.createdAt) - BigInt(right.createdAt)
    return difference < 0n ? -1 : difference > 0n ? 1 : 0
  })
  const roots = ordered.filter((event) => event.pid === rootPid && event.ppid === harnessPid &&
    event.name.toLowerCase() === rootName.toLowerCase())
  const root = roots[0]
  if (root === undefined || roots.length !== 1) {
    throw new Error(`Expected one root process trace event, received ${String(roots.length)}`)
  }
  const byPid = new Map<number, StartedProcess[]>()
  for (const event of ordered) {
    const instances = byPid.get(event.pid) ?? []
    instances.push(event)
    byPid.set(event.pid, instances)
  }
  const parentOf = (event: StartedProcess): StartedProcess | undefined => byPid.get(event.ppid)?.findLast(
    (candidate) => candidate !== event && BigInt(candidate.createdAt) <= BigInt(event.createdAt),
  )
  type Owner = 'cli' | 'harness' | 'outside'
  const owners = new Map<StartedProcess, Owner>([[root, 'cli']])
  const resolving = new Set<StartedProcess>()
  const ownerOf = (event: StartedProcess): Owner => {
    const known = owners.get(event)
    if (known !== undefined) return known
    if (resolving.has(event)) throw new Error(`Cyclic process trace at PID ${String(event.pid)}`)
    resolving.add(event)
    const parent = parentOf(event)
    const owner = event.pid === harnessPid || event.pid === observerPid
      ? 'harness'
      : parent !== undefined
        ? ownerOf(parent)
        : event.ppid === harnessPid || event.ppid === observerPid ? 'harness' : 'outside'
    resolving.delete(event)
    owners.set(event, owner)
    return owner
  }
  const tree = ordered.filter((event) => ownerOf(event) === 'cli')
  return {
    treeFromTrace: { processes: tree.length, names: nameCounts(tree.filter((event) => event !== root)) },
    startedOutsideTree: ordered
      .filter((event) => ownerOf(event) === 'outside')
      .map((event) => ({ pid: event.pid, name: event.name, ppid: event.ppid, createdAt: event.createdAt,
        parent: parentOf(event)?.name ?? event.parentName })),
  }
}
