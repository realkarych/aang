import { openStore } from '@catacomb/store'
import { takeSnapshot } from '@catacomb/support'
import type { RecordCount } from './observe.js'

export const daemonRecords = (catacombHome: string, base: string): RecordCount[] => {
  const store = openStore({ home: catacombHome })
  try {
    return [...takeSnapshot(store, base).records]
  } finally {
    store.close()
  }
}
