export type PackageDirectory =
  | 'contract'
  | 'store'
  | 'collector'
  | 'adapter-claude'
  | 'adapter-codex'
  | 'engine'
  | 'observer'
  | 'hook'
  | 'daemon'
  | 'cli'
  | 'web'
  | 'testkit'
  | 'aang'

const productionDependencies: Readonly<Record<PackageDirectory, readonly PackageDirectory[]>> = {
  contract: [],
  store: ['contract'],
  collector: ['contract'],
  'adapter-claude': ['contract'],
  'adapter-codex': ['contract'],
  engine: ['contract', 'store'],
  observer: ['contract', 'store', 'engine'],
  hook: ['contract'],
  daemon: ['contract', 'store', 'collector', 'adapter-claude', 'adapter-codex', 'engine', 'observer', 'hook'],
  cli: ['contract', 'hook'],
  web: ['contract'],
  testkit: ['contract'],
  aang: ['cli', 'daemon', 'web'],
}

const testDependenciesOfEveryPackage: readonly PackageDirectory[] = ['testkit']

const testDependencies: Readonly<Partial<Record<PackageDirectory, readonly PackageDirectory[]>>> = {
  engine: ['adapter-claude', 'adapter-codex'],
}

export const isPackageDirectory = (name: string): name is PackageDirectory => Object.hasOwn(productionDependencies, name)

export const allowedDependencies = (directory: PackageDirectory, productCode: boolean): readonly PackageDirectory[] => {
  const testOnly = productCode ? [] : [...testDependenciesOfEveryPackage, ...(testDependencies[directory] ?? [])]
  return [...new Set([...productionDependencies[directory], ...testOnly])].filter(
    (dependency) => dependency !== directory,
  )
}
