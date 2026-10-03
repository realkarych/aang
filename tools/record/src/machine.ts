import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'

export type MachineKind = 'HOST' | 'MACHINE'

export interface MachineIdentity {
  readonly kind: MachineKind
  readonly names: readonly string[]
}

const hostLabel = /^([^.]+)\./

const hostIdentity = (name: string): MachineIdentity => {
  const names = [name, ...hostLabel.exec(name)?.slice(1) ?? []]
  return { kind: 'HOST', names: name === '' || names.some((each) => /^localhost$/i.test(each)) ? [] : names }
}

export const machineIdentities = async (): Promise<MachineIdentity[]> => {
  const ids = await Promise.all(['/etc/machine-id', '/var/lib/dbus/machine-id'].map((path) => readFile(path, 'utf8').then((text) => text.trim(), () => '')))
  return [
    hostIdentity(hostname()),
    hostIdentity(process.env['COMPUTERNAME'] ?? ''),
    ...ids.map((id): MachineIdentity => ({ kind: 'MACHINE', names: id === '' ? [] : [id] })),
  ].filter(({ names }) => names.length > 0)
}

const nameCharacter = String.raw`[\p{L}\p{N}]`
const afterEscape = String.raw`(?<=\\[bfnrt]|\\u[\da-f]{4}|%[\da-f]{2})`

const mention = (name: string): RegExp => new RegExp(`(?:(?<!${nameCharacter})|${afterEscape})${RegExp.escape(name)}(?!${nameCharacter})`, 'iu')

export const assertNoMachineNames = (files: ReadonlyMap<string, string>, machines: readonly MachineIdentity[]): void => {
  for (const { kind, names } of machines) {
    for (const name of names) {
      const pattern = mention(name)
      for (const [file, content] of files) {
        if (!pattern.test(content)) continue
        const [what, remedy] = kind === 'HOST' ? ['host name', 'keep it out of the scenario or give the machine another host name'] : ['machine id', 'keep it out of the scenario']
        throw new Error(`Recording file ${file} contains the ${what} "${name}" of this machine, which anonymization replaces only in machine name fields and never in free text or other values; ${remedy}, then record again`)
      }
    }
  }
}
