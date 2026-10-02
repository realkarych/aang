import type { Surface, SurfaceBasis, SurfaceClaim } from '@aang/contract'

interface OriginatorSurface {
  readonly surface: Surface
  readonly basis: SurfaceBasis
  readonly source: string | null
}

const execSource = 'exec'

const originatorSurfaces: ReadonlyMap<string, OriginatorSurface> = new Map([
  ['codex_exec', { surface: 'codex_exec', basis: 'observed', source: execSource }],
  ['codex_sdk_ts', { surface: 'codex_sdk', basis: 'observed', source: execSource }],
  ['codex-tui', { surface: 'codex_tui', basis: 'assumed', source: null }],
  ['Codex Desktop', { surface: 'codex_desktop', basis: 'assumed', source: null }],
])

export const surfaceOf = (originator: string | null, source: unknown): SurfaceClaim | null => {
  const known = originator === null ? undefined : originatorSurfaces.get(originator)
  if (known === undefined || (known.source !== null && known.source !== source)) {
    return null
  }
  return { surface: known.surface, basis: known.basis }
}
