export type RecordTime = 'original' | 'playback'

const timestamp = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})((?:\.\d+)?Z)"/g

const secondMs = 1_000

const bytewise = 'latin1'

const instantsOf = (content: Buffer): number[] =>
  [...content.toString(bytewise).matchAll(timestamp)].flatMap(([, seconds = '', fraction = '']) => {
    const instant = Date.parse(`${seconds}${fraction}`)
    return Number.isNaN(instant) ? [] : [instant]
  })

export const playbackShift = (sources: Iterable<Buffer>, now: number): number => {
  const earliest = Math.min(...[...sources].flatMap(instantsOf))
  return Number.isFinite(earliest) ? Math.floor((now - earliest) / secondMs) * secondMs : 0
}

export const shifted = (content: Buffer, shiftMs: number): Buffer => {
  if (shiftMs === 0) {
    return content
  }
  const text = content.toString(bytewise).replaceAll(timestamp, (match, seconds: string, fraction: string) => {
    const instant = Date.parse(`${seconds}Z`)
    return Number.isNaN(instant)
      ? match
      : `"${new Date(instant + shiftMs).toISOString().slice(0, seconds.length)}${fraction}"`
  })
  return Buffer.from(text, bytewise)
}
