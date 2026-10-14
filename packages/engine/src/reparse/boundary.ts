import { ChangeSeq, type EpochNs } from '@catacomb/contract'
import type { SettingReader, SettingWriter } from '@catacomb/store'

const reparseBoundarySetting = 'reparse_boundary'

export const reparseBoundary = (settings: SettingReader): ChangeSeq | null => {
  const stored = settings.get(reparseBoundarySetting)
  return stored === undefined ? null : ChangeSeq.parse(stored)
}

export const saveReparseBoundary = (settings: SettingWriter, boundary: ChangeSeq, at: EpochNs): void => {
  settings.save(reparseBoundarySetting, boundary, at)
}
