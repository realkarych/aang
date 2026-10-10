export type RecordTime = 'original' | 'playback' | { readonly startsAt: number }

export interface RecordShift {
  readonly ms: number
  readonly from: number
  readonly to: number
  readonly kept: ReadonlySet<bigint>
}

export const unshifted: RecordShift = { ms: 0, from: 0, to: 0, kept: new Set() }

const timestamp = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})((?:\.\d+)?Z)"/g

const timestampAtAnyDepth = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})((?:\.\d+)?Z)(\\*")/g

const secondMs = 1_000

const bytewise = 'latin1'

const epochValue = /(:(?:\s|\\+[nrt])*)((?:\\*")?)(\d{10}|\d{13}|\d{16}|\d{19})\2(?=(?:\s|\\+[nrt])*[,}\]])/g

const dayMs = 24 * 60 * 60 * 1_000

const nanosecondsPerMillisecond = 1_000_000n

const instantsOf = (text: string): number[] =>
  [...text.matchAll(timestamp)].flatMap(([, seconds = '', fraction = '']) => {
    const instant = Date.parse(`${seconds}${fraction}`)
    return Number.isNaN(instant) ? [] : [instant]
  })

const unitOf = (digits: string): bigint => 10n ** BigInt(19 - digits.length)

const nanosecondsOf = (digits: string): bigint => BigInt(digits) * unitOf(digits)

const within = (nanoseconds: bigint, { from, to }: Pick<RecordShift, 'from' | 'to'>): boolean =>
  nanoseconds >= BigInt(from) * nanosecondsPerMillisecond && nanoseconds <= BigInt(to) * nanosecondsPerMillisecond

const epochsOf = (text: string): bigint[] => [...text.matchAll(epochValue)].map(([, , , digits = '']) => nanosecondsOf(digits))

export const playbackShift = (sources: Iterable<Buffer>, now: number): RecordShift => {
  const texts = [...sources].map((content) => content.toString(bytewise))
  const instants = texts.flatMap(instantsOf)
  if (instants.length === 0) {
    return unshifted
  }
  const earliest = instants.reduce((least, instant) => Math.min(least, instant))
  const latest = instants.reduce((most, instant) => Math.max(most, instant))
  const timeline = { from: earliest - dayMs, to: latest + dayMs }
  return {
    ms: Math.floor((now - earliest) / secondMs) * secondMs,
    ...timeline,
    kept: new Set(texts.flatMap(epochsOf).filter((instant) => !within(instant, timeline))),
  }
}

const shiftedEpoch = (digits: string, shift: RecordShift): string | null => {
  const nanoseconds = nanosecondsOf(digits)
  if (!within(nanoseconds, shift) || shift.kept.has(nanoseconds)) {
    return null
  }
  return (BigInt(digits) + (BigInt(shift.ms) * nanosecondsPerMillisecond) / unitOf(digits)).toString()
}

export const shifted = (content: Buffer, shift: RecordShift): Buffer => {
  if (shift.ms === 0) {
    return content
  }
  const text = content
    .toString(bytewise)
    .replaceAll(timestampAtAnyDepth, (match, seconds: string, fraction: string, close: string) => {
      const instant = Date.parse(`${seconds}Z`)
      return Number.isNaN(instant)
        ? match
        : `"${new Date(instant + shift.ms).toISOString().slice(0, seconds.length)}${fraction}${close}`
    })
    .replaceAll(epochValue, (match, separator: string, quote: string, digits: string) => {
      const moved = shiftedEpoch(digits, shift)
      return moved === null ? match : `${separator}${quote}${moved}${quote}`
    })
  return Buffer.from(text, bytewise)
}
