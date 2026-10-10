export type RecordTime = 'original' | 'playback' | { readonly startsAt: number }

export interface RecordShift {
  readonly ms: number
  readonly from: number
  readonly to: number
}

export const unshifted: RecordShift = { ms: 0, from: 0, to: 0 }

const timestamp = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})((?:\.\d+)?Z)"/g

const timestampAtAnyDepth = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})((?:\.\d+)?Z)(\\*")/g

const secondMs = 1_000

const bytewise = 'latin1'

const epochValue = /(:\s*)((?:\\*")?)(\d{10}|\d{13}|\d{16}|\d{19})\2(?=\s*[,}\]])/g

const dayMs = 24 * 60 * 60 * 1_000

const nanosecondsPerMillisecond = 1_000_000n

const instantsOf = (content: Buffer): number[] =>
  [...content.toString(bytewise).matchAll(timestamp)].flatMap(([, seconds = '', fraction = '']) => {
    const instant = Date.parse(`${seconds}${fraction}`)
    return Number.isNaN(instant) ? [] : [instant]
  })

export const playbackShift = (sources: Iterable<Buffer>, now: number): RecordShift => {
  const instants = [...sources].flatMap(instantsOf)
  if (instants.length === 0) {
    return unshifted
  }
  const earliest = instants.reduce((least, instant) => Math.min(least, instant))
  const latest = instants.reduce((most, instant) => Math.max(most, instant))
  return { ms: Math.floor((now - earliest) / secondMs) * secondMs, from: earliest - dayMs, to: latest + dayMs }
}

const shiftedEpoch = (digits: string, { ms, from, to }: RecordShift): string | null => {
  const unit = 10n ** BigInt(19 - digits.length)
  const nanoseconds = BigInt(digits) * unit
  if (nanoseconds < BigInt(from) * nanosecondsPerMillisecond || nanoseconds > BigInt(to) * nanosecondsPerMillisecond) {
    return null
  }
  const shift = (BigInt(ms) * nanosecondsPerMillisecond) / unit
  return (BigInt(digits) + shift).toString()
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
