import { type Adapter, NormalizerVersion } from '@aang/contract'
import { owner } from './owner.js'
import { parse } from './parse.js'
import { rawKey } from './raw-key.js'
import { streamKey } from './stream.js'

export const codexAdapter: Adapter = {
  runtime: 'codex',
  normalizerVersion: NormalizerVersion.parse(1),
  streamKey,
  rawKey,
  parse,
  owner,
}
