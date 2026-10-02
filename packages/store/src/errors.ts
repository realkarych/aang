export class StoreLockedError extends Error {
  override readonly name = 'StoreLockedError'
  readonly home: string

  constructor(home: string) {
    super(`another writer holds the aang store in ${home}`)
    this.home = home
  }
}

export class StoreVersionError extends Error {
  override readonly name = 'StoreVersionError'
  readonly found: number
  readonly supported: number

  constructor(found: number, supported: number) {
    super(`aang store schema version ${String(found)} is newer than the supported version ${String(supported)}`)
    this.found = found
    this.supported = supported
  }
}
