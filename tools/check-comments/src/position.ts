export interface Position {
  readonly line: number
  readonly column: number
}

export const positionLocator = (text: string): ((offset: number) => Position) => {
  const lineStarts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lineStarts.push(index + 1)
  }
  return (offset) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((lineStarts[middle] ?? 0) <= offset) {
        low = middle
      } else {
        high = middle - 1
      }
    }
    return { line: low + 1, column: offset - (lineStarts[low] ?? 0) + 1 }
  }
}
