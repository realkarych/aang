import { type Adapter, NormalizerVersion } from '@aang/contract'
import { owner } from './owner.js'
import { parse } from './parse.js'
import { rawKey } from './raw-key.js'
import { streamKey } from './stream.js'

export const codexAdapter: Adapter = {
  runtime: 'codex',
  normalizerVersion: NormalizerVersion.parse(2),
  streamKey: (_path, firstLines) => streamKey(firstLines),
  rawKey,
  parse,
  owner,
}
