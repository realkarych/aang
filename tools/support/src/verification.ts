import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Surface, SupportKey, supportKeyText } from '@aang/contract'
import { z } from 'zod'
import { parseFile, readOptional } from './files.js'

export const verificationFormat = 'aang-support-verification/1'

export const surfaceCheckFormat = 'aang-surface-check/1'

const Verdict = z.enum(['passed', 'failed'])

export const OwnerChecklistName = z.enum(['desktop', 'tui'])
export type OwnerChecklistName = z.infer<typeof OwnerChecklistName>

export const checklistSurfaces: Readonly<Record<OwnerChecklistName, readonly Surface[]>> = {
  desktop: ['claude_desktop', 'codex_desktop'],
  tui: ['claude_cli'],
}

export const PlacementCheck = z
  .strictObject({
    ...SupportKey.shape,
    result: Verdict,
    checked_on: z.iso.date(),
  })
  .refine(({ placement }) => placement !== 'local', { path: ['placement'], message: 'a placement check needs a placement other than local' })
export type PlacementCheck = z.infer<typeof PlacementCheck>

export const OwnerChecklist = z
  .strictObject({
    ...SupportKey.shape,
    checklist: OwnerChecklistName,
    result: Verdict,
    checked_on: z.iso.date(),
    report: z.string().min(1),
  })
  .superRefine(({ checklist, surface }, context) => {
    if (!checklistSurfaces[checklist].includes(surface)) {
      context.addIssue({
        code: 'custom',
        path: ['checklist'],
        message: `the ${checklist} checklist belongs to ${checklistSurfaces[checklist].join(', ')}, not to ${surface}`,
      })
    }
  })
export type OwnerChecklist = z.infer<typeof OwnerChecklist>

const lists = ['placements', 'owner_checklists'] as const

export const SupportVerification = z
  .strictObject({
    format: z.literal(verificationFormat),
    placements: z.array(PlacementCheck),
    owner_checklists: z.array(OwnerChecklist),
  })
  .superRefine((verification, context) => {
    for (const list of lists) {
      const seen = new Set<string>()
      verification[list].forEach((entry, index) => {
        const key = supportKeyText(entry)
        if (seen.has(key)) {
          context.addIssue({ code: 'custom', path: [list, index], message: `duplicate support key ${key} in ${list}` })
        }
        seen.add(key)
      })
    }
  })
export type SupportVerification = z.infer<typeof SupportVerification>

export const emptyVerification: SupportVerification = { format: verificationFormat, placements: [], owner_checklists: [] }

export const byKeyText = (left: SupportKey, right: SupportKey): number => {
  const [a, b] = [supportKeyText(left), supportKeyText(right)]
  return a < b ? -1 : a > b ? 1 : 0
}

export const sameKey = (left: SupportKey, right: SupportKey): boolean => supportKeyText(left) === supportKeyText(right)

const verificationFile = 'verification.json'

export const verificationPath = (support: string): string => join(support, verificationFile)

export const readVerification = async (support: string): Promise<SupportVerification> => {
  const path = verificationPath(support)
  const source = await readOptional(path)
  return source === null ? emptyVerification : parseFile(SupportVerification, path, source)
}

export const serializeVerification = (verification: SupportVerification): string =>
  `${JSON.stringify(
    {
      format: verification.format,
      placements: verification.placements.toSorted(byKeyText),
      owner_checklists: verification.owner_checklists.toSorted(byKeyText),
    },
    null,
    2,
  )}\n`

const SurfaceCheckReport = z.looseObject({
  format: z.literal(surfaceCheckFormat),
  finished_at: z.iso.datetime({ offset: true }),
  access: z.looseObject({ result: z.enum(['passed', 'failed', 'not_run']) }),
  results: z.array(
    z.looseObject({
      key: z.looseObject(SupportKey.shape).nullable(),
      emulated: z.boolean(),
      result: Verdict,
    }),
  ),
})
type SurfaceCheckReport = z.infer<typeof SurfaceCheckReport>

const placementChecksOf = ({ finished_at: finishedAt, access, results }: SurfaceCheckReport): PlacementCheck[] =>
  results.flatMap(({ key, emulated, result }): PlacementCheck[] =>
    key === null || key.placement === 'local' || emulated
      ? []
      : [
          {
            runtime: key.runtime,
            surface: key.surface,
            os: key.os,
            placement: key.placement,
            engine_version: key.engine_version,
            result: result === 'passed' && access.result === 'passed' ? 'passed' : 'failed',
            checked_on: new Date(finishedAt).toISOString().slice(0, 10),
          },
        ],
  )

export const withPlacementChecks = (verification: SupportVerification, checks: readonly PlacementCheck[]): SupportVerification => {
  const placements = new Map(verification.placements.map((entry) => [supportKeyText(entry), entry]))
  for (const check of checks) {
    placements.set(supportKeyText(check), check)
  }
  return { ...verification, placements: [...placements.values()].sort(byKeyText) }
}

export interface PlacementImport {
  readonly checks: readonly PlacementCheck[]
  readonly skipped: number
}

export const importPlacementChecks = async (support: string, files: readonly string[]): Promise<PlacementImport> => {
  const reports = await Promise.all(files.map(async (file) => parseFile(SurfaceCheckReport, file, await readFile(file, 'utf8'))))
  const checks = reports.flatMap(placementChecksOf)
  const verification = withPlacementChecks(await readVerification(support), checks)
  await mkdir(support, { recursive: true })
  await writeFile(verificationPath(support), serializeVerification(verification))
  return { checks, skipped: reports.reduce((total, { results }) => total + results.length, 0) - checks.length }
}

export const placementImportSummary = (reports: number, support: string, { checks, skipped }: PlacementImport): string => {
  const passed = checks.filter(({ result }) => result === 'passed').length
  return `placement checks of ${String(reports)} reports written to ${support}: ${String(passed)} passed, ${String(checks.length - passed)} failed, ${String(skipped)} skipped as local, emulated or without a key`
}
