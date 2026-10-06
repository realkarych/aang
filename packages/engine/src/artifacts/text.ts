const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export const utf8Text = (bytes: Uint8Array): string | null => {
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}
