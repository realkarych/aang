import { openStore } from '@aang/store'
import { takeSnapshot } from '@aang/support'
import type { RecordCount } from './observe.js'

export const daemonRecords = (aangHome: string, base: string): RecordCount[] => {
  const store = openStore({ home: aangHome })
  try {
    return [...takeSnapshot(store, base).records]
  } finally {
    store.close()
  }
}
