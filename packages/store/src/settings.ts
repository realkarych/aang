import type { DatabaseSync } from 'node:sqlite'
import type { EpochNs } from '@aang/contract'
import { decodeJson, encodeJson } from './codec.js'
import { prepareStatement, upsertInto, type WriteContext } from './context.js'

export interface SettingReader {
  readonly get: (key: string) => unknown
}

export interface SettingWriter extends SettingReader {
  readonly save: (key: string, value: unknown, updatedAt: EpochNs) => void
  readonly remove: (key: string) => void
}

export interface SettingRepository {
  readonly reader: SettingReader
  readonly writer: (context: WriteContext) => SettingWriter
}

const columns = ['key', 'value', 'updated_at']

export const createSettings = (database: DatabaseSync): SettingRepository => {
  const selectValue = prepareStatement(database, 'SELECT value FROM settings WHERE key = ?')
  const upsertSetting = prepareStatement(database, upsertInto('settings', 'key', columns))
  const deleteSetting = prepareStatement(database, 'DELETE FROM settings WHERE key = ?')

  const reader: SettingReader = {
    get: (key) => {
      const row = selectValue.get(key) as { readonly value: string } | undefined
      return row === undefined ? undefined : decodeJson(row.value)
    },
  }

  const writer = (context: WriteContext): SettingWriter => ({
    ...reader,
    save: (key, value, updatedAt) => {
      context.assertActive()
      upsertSetting.run({ key, value: encodeJson(value), updated_at: updatedAt })
    },
    remove: (key) => {
      context.assertActive()
      deleteSetting.run(key)
    },
  })

  return { reader, writer }
}
