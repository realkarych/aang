export type RecordTime = 'original' | 'playback'

export interface RecordShift {
  readonly ms: number
  readonly from: number
  readonly to: number
}

export const unshifted: RecordShift = { ms: 0, from: 0, to: 0 }

const timestamp = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g

const epochValue = /(:\s*)("?)(\d{10}|\d{13}|\d{16}|\d{19})\2(?=\s*[,}\]])/g

const dayMs = 24 * 60 * 60 * 1_000

const nanosecondsPerMillisecond = 1_000_000n

const instantsOf = (content: Buffer): number[] =>
  [...content.toString('utf8').matchAll(timestamp)].flatMap(([, value]) => {
    const instant = Date.parse(value ?? '')
    return Number.isNaN(instant) ? [] : [instant]
  })

export const playbackShift = (sources: Iterable<Buffer>, now: number): RecordShift => {
  const instants = [...sources].flatMap(instantsOf)
  if (instants.length === 0) {
    return unshifted
  }
  const earliest = instants.reduce((least, instant) => Math.min(least, instant))
  const latest = instants.reduce((most, instant) => Math.max(most, instant))
  return { ms: now - earliest, from: earliest - dayMs, to: latest + dayMs }
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
    .toString('utf8')
    .replaceAll(timestamp, (match, value: string) => {
      const instant = Date.parse(value)
      return Number.isNaN(instant) ? match : `"${new Date(instant + shift.ms).toISOString()}"`
    })
    .replaceAll(epochValue, (match, separator: string, quote: string, digits: string) => {
      const moved = shiftedEpoch(digits, shift)
      return moved === null ? match : `${separator}${quote}${moved}${quote}`
    })
  return Buffer.from(text, 'utf8')
}
