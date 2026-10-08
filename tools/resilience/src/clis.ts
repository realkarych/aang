import { drivers } from '@aang/record'

export type CliName = 'claude' | 'codex'

export interface Cli {
  readonly name: CliName
  readonly command: string
  readonly version: string
}

export type Clis = Readonly<Record<CliName, Cli>>

const surfaces: Readonly<Record<CliName, string>> = { claude: 'claude_cli', codex: 'codex_exec' }

export const locateCli = async (name: CliName, override: string | undefined): Promise<Cli> => {
  const driver = drivers.find(({ surface }) => surface === surfaces[name])
  if (driver === undefined) throw new Error(`tools/record has no ${surfaces[name]} driver`)
  const { executable, version } = await driver.resolve(name === 'claude' ? { claude: override } : { codex: override })
  return { name, command: executable, version }
}
