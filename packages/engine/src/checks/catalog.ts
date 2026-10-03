import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { type CheckContract, compilePattern } from '@aang/contract'
import { contains, type WatchedRoots } from '../ingest/scope.js'

export interface Contract {
  readonly name: string
  readonly root: string
  readonly command: RegExp
  readonly successExitCodes: readonly number[]
  readonly inputMasks: readonly string[]
  readonly commitPattern: RegExp | null
}

export interface ContractCatalog {
  readonly empty: boolean
  readonly contractsFor: (cwd: string) => readonly Contract[]
}

interface Root {
  readonly path: string
  readonly contracts: readonly Contract[]
}

const compiled = (
  root: string,
  { name, command, successExitCodes, inputMasks, commitPattern }: CheckContract,
): Contract => ({
  name,
  root,
  command: compilePattern(command),
  successExitCodes,
  inputMasks,
  commitPattern: commitPattern === null ? null : new RegExp(compilePattern(commitPattern).source, 'gu'),
})

const canonicalPath = (path: string): string => {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

const byDepth = (left: Root, right: Root): number => right.path.length - left.path.length

export const createContractCatalog = (watch: WatchedRoots): ContractCatalog => {
  const configured = watch.roots.filter(({ contracts = [] }) => contracts.length > 0)
  const directories = new Map<string, string>()
  let roots: readonly Root[] | undefined

  const canonical = (path: string): string => {
    const known = directories.get(path)
    if (known !== undefined) {
      return known
    }
    const directory = canonicalPath(path)
    directories.set(path, directory)
    return directory
  }

  const contractsFor = (cwd: string): Contract[] => {
    roots ??= configured
      .map(({ path, contracts = [] }) => {
        const root = canonicalPath(path)
        return { path: root, contracts: contracts.map((contract) => compiled(root, contract)) }
      })
      .sort(byDepth)
    const directory = canonical(cwd)
    const named = new Map<string, Contract>()
    for (const root of roots.filter(({ path }) => contains(path, directory))) {
      for (const contract of root.contracts) {
        if (!named.has(contract.name)) {
          named.set(contract.name, contract)
        }
      }
    }
    return [...named.values()]
  }

  return { empty: configured.length === 0, contractsFor }
}
