import type { EpochNs } from '@aang/contract'
import type { ReactElement } from 'react'
import { absoluteTime, relativeTime } from './format.js'

export const Moment = ({ at, now }: { readonly at: EpochNs; readonly now: bigint }): ReactElement => (
  <time dateTime={new Date(Number(at / 1_000_000n)).toISOString()} title={absoluteTime(at)}>
    {relativeTime(at, now)}
  </time>
)
