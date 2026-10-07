import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type OperatingSystem, type SupportKey, type SupportRow, type SupportScenarios, supportKeyText, supportRowOf } from '@aang/contract'
import { readSupportMatrix } from '@aang/contract/support-file'
import { expect, test } from '@playwright/test'
import { runnerOs, variantRecordingOn } from './recordings.js'
import { afterIterationVariants, checkedOn, duringWorkVariants, type SurfaceVariant } from './variants.js'

interface Column {
  readonly field: keyof Pick<SupportScenarios, 'during_work' | 'after_iteration'>
  readonly name: string
  readonly variants: readonly SurfaceVariant[]
}

const columns: readonly Column[] = [
  { field: 'during_work', name: 'E2E 1', variants: duringWorkVariants },
  { field: 'after_iteration', name: 'E2E 4', variants: afterIterationVariants },
]

const matrixFile = fileURLToPath(new URL('../support/matrix.json', import.meta.url))

const matrixOs = (): OperatingSystem => {
  if (runnerOs === null) {
    throw new Error(`${process.platform} is not an OS of the support matrix`)
  }
  return runnerOs
}

const sameEngine = (variant: SurfaceVariant, row: SupportRow): boolean =>
  variant.runtime === row.runtime && variant.surface === row.surface && variant.version === row.engine_version

const playsRecordingOf = (variant: SurfaceVariant, os: OperatingSystem): boolean => checkedOn(variant, os) && variant.recordedOn.includes(os)

const localKey = ({ runtime, surface, version }: SurfaceVariant, os: OperatingSystem): SupportKey => ({
  runtime,
  surface,
  os,
  placement: 'local',
  engine_version: version,
})

const variantText = ({ runtime, surface, version }: SurfaceVariant, { name }: Column): string => `${name} ${runtime}/${surface}/${version}`

test.describe('the support matrix and the surface variants of E2E 1 and 4', () => {
  test.skip(runnerOs === null, `${process.platform} is not an OS of the support matrix`)

  test('every recording that a surface variant plays as a reference of its OS exists', () => {
    const missing = columns.flatMap((column) =>
      column.variants.flatMap((variant) =>
        variant.recordedOn.flatMap((os) =>
          variant.scenarios
            .map((scenario) => variantRecordingOn(variant, os, scenario))
            .filter((path) => !existsSync(path))
            .map((path) => `${variantText(variant, column)}: ${path}`),
        ),
      ),
    )

    expect(missing).toEqual([])
  })

  test('a local row of this OS claims E2E 1 or 4 passed only when a variant of its surface and engine version plays a recording of this OS on this runner', async () => {
    const os = matrixOs()
    const { rows } = await readSupportMatrix(matrixFile)

    const unbacked = columns.flatMap((column) =>
      rows
        .filter((row) => row.os === os && row.placement === 'local' && row.scenarios[column.field] === 'passed')
        .filter((row) => !column.variants.some((variant) => sameEngine(variant, row) && playsRecordingOf(variant, os)))
        .map((row) => `${column.name} ${supportKeyText(row)}`),
    )

    expect(unbacked).toEqual([])
  })

  test('every variant that plays a recording of this OS on this runner is claimed passed in the local row of its surface and engine version', async () => {
    const os = matrixOs()
    const matrix = await readSupportMatrix(matrixFile)

    const unclaimed = columns.flatMap((column) =>
      column.variants
        .filter((variant) => playsRecordingOf(variant, os))
        .filter((variant) => supportRowOf(matrix, localKey(variant, os))?.scenarios[column.field] !== 'passed')
        .map((variant) => variantText(variant, column)),
    )

    expect(unclaimed).toEqual([])
  })
})
