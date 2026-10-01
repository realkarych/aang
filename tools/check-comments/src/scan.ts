export type ScanResult =
  | { readonly kind: 'comments'; readonly offsets: readonly number[] }
  | { readonly kind: 'error'; readonly offset: number; readonly message: string }

export const comments = (offsets: readonly number[]): ScanResult => ({ kind: 'comments', offsets })

export const failure = (offset: number, message: string): ScanResult => ({ kind: 'error', offset, message })

export const lineEnd = (text: string, from: number): number => {
  let index = from
  while (index < text.length && text[index] !== '\n' && text[index] !== '\r') {
    index += 1
  }
  return index
}

export const closingIndex = (text: string, delimiter: string, from: number): number | undefined => {
  const index = text.indexOf(delimiter, from)
  return index === -1 ? undefined : index + delimiter.length
}
