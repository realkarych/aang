export interface Position {
  readonly line: number
  readonly column: number
}

export const lineStarts = (text: string): number[] => {
  const starts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1)
  }
  return starts
}

export const positionLocator = (text: string): ((offset: number) => Position) => {
  const starts = lineStarts(text)
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((starts[middle] ?? 0) <= offset) {
        low = middle
      } else {
        high = middle - 1
      }
    }
    return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 }
  }
}
