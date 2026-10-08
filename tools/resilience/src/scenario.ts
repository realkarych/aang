import type { ConfigInput } from '@aang/testkit'
import type { CliName } from './clis.js'
import type { Area } from './journal.js'
import type { Lab, LabPaths, Scripts } from './lab.js'

export interface Scenario {
  readonly name: string
  readonly area: Area
  readonly summary: string
  readonly runtimes: readonly CliName[]
  readonly scripts?: (paths: LabPaths) => Scripts
  readonly config?: ConfigInput
  readonly run: (lab: Lab) => Promise<void>
}
