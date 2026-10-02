type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

type Identity = 'ACCOUNT' | 'ORGANIZATION' | 'INSTALLATION' | 'USER'

const identityKind = (key: string): Identity | undefined => {
  const normalized = key.replaceAll(/[^a-z]/gi, '').toLowerCase()
  if (/(?:account)(?:id|uuid)$/.test(normalized)) return 'ACCOUNT'
  if (/(?:organization|org)(?:id|uuid)$/.test(normalized)) return 'ORGANIZATION'
  if (/(?:installation|install)(?:id|uuid)$/.test(normalized)) return 'INSTALLATION'
  if (/(?:user)(?:id|uuid)$/.test(normalized)) return 'USER'
  return undefined
}

const placeholder = /^(?:ACCOUNT|ORGANIZATION|INSTALLATION|USER|EMAIL)_\d+$/
const email = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/giu
const homes = /(?:\/(?:Users|home)\/|[a-z]:[\\/]+Users[\\/]+)[^\\/\r\n\0"'<>]+/giu
const rootHome = /\/root(?=[/\s"'\0]|$)/g
const profile = /%USERPROFILE%|\$\{?USERPROFILE\}?/gi
const assignments = /((?:creator[._-]?)?(?:user[._-]?)?(?:account|organization|org|installation|install|user)[._-]?(?:id|uuid))(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?([\w.-]+)/gi

const parse = (text: string): Json | undefined => {
  try { return JSON.parse(text) as Json } catch { return undefined }
}

const structured = (text: string, map: (value: Json) => Json, plain: (value: string) => string): string => {
  const parsed = parse(text)
  if (parsed !== undefined) {
    const trailing = text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : ''
    return JSON.stringify(map(parsed)) + trailing
  }
  if (text.includes('\0')) return text.split('\0').map((part) => structured(part, map, plain)).join('\0')
  if (text.includes('\n')) return text.split(/(\r?\n)/).map((line) => /\n/.test(line) ? line : structured(line, map, plain)).join('')
  return plain(text)
}

export interface Anonymizer {
  readonly discover: (texts: Iterable<string>) => void
  readonly text: (text: string) => string
}

export const createAnonymizer = (paths: ReadonlyMap<string, string> = new Map()): Anonymizer => {
  const replacements = new Map(paths)
  const counts = new Map<string, number>()
  const register = (value: string, kind: string): void => {
    if (!value || placeholder.test(value) || replacements.has(value)) return
    const next = (counts.get(kind) ?? 0) + 1
    counts.set(kind, next)
    replacements.set(value, `${kind}_${String(next)}`)
  }
  const discoverText = (text: string): string => {
    for (const match of text.matchAll(email)) register(match[0], 'EMAIL')
    for (const match of text.matchAll(assignments)) {
      const kind = identityKind(match[1] ?? '')
      if (kind !== undefined) register(match[2] ?? '', kind)
    }
    return text
  }
  const discoverValue = (value: Json): Json => {
    if (typeof value === 'string') {
      structured(value, discoverValue, discoverText)
    } else if (Array.isArray(value)) {
      value.forEach(discoverValue)
    } else if (value !== null && typeof value === 'object') {
      const attributeKind = typeof value['key'] === 'string' ? identityKind(value['key']) : undefined
      const attribute = value['value']
      if (attributeKind && attribute && typeof attribute === 'object' && !Array.isArray(attribute)) {
        const content = attribute['stringValue']
        if (typeof content === 'string') register(content, attributeKind)
      }
      for (const [key, nested] of Object.entries(value)) {
        const kind = identityKind(key)
        if (kind && (typeof nested === 'string' || typeof nested === 'number')) register(String(nested), kind)
        discoverText(key)
        discoverValue(nested)
      }
    }
    return value
  }
  const replaceText = (input: string): string => {
    let text = input
    for (const [before, after] of [...replacements].sort(([left], [right]) => right.length - left.length)) {
      if (!paths.has(before) && (before.length < 4 || /^\d+$/.test(before))) continue
      text = text.replaceAll(before, after)
    }
    text = text.replaceAll(assignments, (match: string, _key: string, value: string) =>
      match.slice(0, match.length - value.length) + (replacements.get(value) ?? value))
    return text.replaceAll(homes, (home) => {
      const prefix = /^(\/(?:Users|home)\/|[a-z]:[\\/]+Users[\\/]+)/i.exec(home)?.[0] ?? ''
      return `${prefix}USER`
    }).replaceAll(rootHome, '/home/USER').replaceAll(profile, 'REDACTED_HOME')
  }
  const mapValue = (value: Json): Json => {
    if (typeof value === 'string') return structured(value, mapValue, replaceText)
    if (Array.isArray(value)) return value.map(mapValue)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
        replaceText(key),
        identityKind(key) && (typeof nested === 'number' || typeof nested === 'string')
          ? replacements.get(String(nested)) ?? mapValue(nested)
          : mapValue(nested),
      ]))
    }
    return value
  }
  return {
    discover: (texts) => { for (const text of texts) structured(text, discoverValue, discoverText) },
    text: (text) => structured(text, mapValue, replaceText),
  }
}

export const assertAnonymous = (text: string): void => {
  const anonymizer = createAnonymizer()
  anonymizer.discover([text])
  const canonical = (value: Json): Json => {
    if (typeof value === 'string') return structured(value, canonical, (plain) => plain)
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, canonical(nested)]))
    return value
  }
  if (anonymizer.text(text) !== structured(text, canonical, (value) => value)) {
    throw new Error('Recording contains private data; anonymization is required')
  }
}
