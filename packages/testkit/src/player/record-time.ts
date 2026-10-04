export type RecordTime = 'original' | 'playback'

const timestamp = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g

const instantsOf = (content: Buffer): number[] =>
  [...content.toString('utf8').matchAll(timestamp)].flatMap(([, value]) => {
    const instant = Date.parse(value ?? '')
    return Number.isNaN(instant) ? [] : [instant]
  })

export const playbackShift = (sources: Iterable<Buffer>, now: number): number => {
  const earliest = Math.min(...[...sources].flatMap(instantsOf))
  return Number.isFinite(earliest) ? now - earliest : 0
}

export const shifted = (content: Buffer, shiftMs: number): Buffer => {
  if (shiftMs === 0) {
    return content
  }
  const text = content.toString('utf8').replaceAll(timestamp, (match, value: string) => {
    const instant = Date.parse(value)
    return Number.isNaN(instant) ? match : `"${new Date(instant + shiftMs).toISOString()}"`
  })
  return Buffer.from(text, 'utf8')
}
