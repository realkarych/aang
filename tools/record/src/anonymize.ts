type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

type Identity = 'ACCOUNT' | 'ORGANIZATION' | 'INSTALLATION' | 'USER'

const normalize = (key: string): string => key.replaceAll(/[^a-z]/gi, '').toLowerCase()

const identityKind = (key: string): Identity | undefined => {
  const normalized = normalize(key)
  if (/(?:account)(?:id|uuid)$/.test(normalized)) return 'ACCOUNT'
  if (/(?:organization|org)(?:id|uuid)$/.test(normalized)) return 'ORGANIZATION'
  if (/(?:installation|install)(?:id|uuid)$/.test(normalized)) return 'INSTALLATION'
  if (/(?:user)(?:id|uuid)$/.test(normalized)) return 'USER'
  return undefined
}

const isCredential = (key: string): boolean => /(?:token|apikey|secret|password|authorization)$/.test(normalize(key))

const placeholder = /^(?:ACCOUNT|ORGANIZATION|INSTALLATION|USER|EMAIL|SECRET)_\d+$/
const email = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/giu
const slash = String.raw`(?:\\*/|\\+u002f)`
const separators = String.raw`(?:\\+u00(?:5c|2f)|\\*/|\\+)+`
const segment = String.raw`(?:[^\\/\r\n\0"'<>]|\\+u(?!00(?:5c|2f))[0-9a-f]{4})+`
const homes = new RegExp(String.raw`(${slash}(?:Users|home)${slash}|[a-z]:${separators}Users${separators})${segment}`, 'giu')
const rootHome = new RegExp(String.raw`(${slash})root(?=${slash}\.)`, 'gi')
const profile = /%USERPROFILE%|\$\{?USERPROFILE\}?/gi
const assignments = /((?:creator[._-]?)?(?:user[._-]?)?(?:account|organization|org|installation|install|user)[._-]?(?:id|uuid))(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?([\w.-]+)/gi
const credentials = /([\w.-]*?(?:token|api[._-]?key|secret|password|authorization))(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?(?:(?:bearer|basic|token)\s+)?([\w.~+/=-]{8,})/gi
const bearer = /\bBearer\s+([\w.~+/-]+=*)/g

const isRecord = (value: Json | undefined): value is { [key: string]: Json } => value !== null && typeof value === 'object' && !Array.isArray(value)

const isAttribute = (value: { [key: string]: Json }): boolean => typeof value['key'] === 'string' && identityKind(value['key']) !== undefined

const parse = (text: string): Json | undefined => {
  try { return JSON.parse(text) as Json } catch { return undefined }
}

const tokens = /"(?:[^"\\]|\\.)*"|[{}[\]:,]/g

const hasDuplicateKeys = (text: string): boolean => {
  const scopes: (Set<string> | undefined)[] = []
  let expectsKey = false
  for (const [token] of text.matchAll(tokens)) {
    if (token === '{') {
      scopes.push(new Set())
      expectsKey = true
    } else if (token === '[') {
      scopes.push(undefined)
      expectsKey = false
    } else if (token === '}' || token === ']') {
      scopes.pop()
    } else if (token === ',') {
      expectsKey = scopes.at(-1) !== undefined
    } else if (token === ':') {
      expectsKey = false
    } else if (expectsKey) {
      const keys = scopes.at(-1)
      const key = JSON.parse(token) as string
      if (keys?.has(key)) return true
      keys?.add(key)
    }
  }
  return false
}

const structured = (text: string, map: (value: Json) => Json, plain: (value: string) => string): string => {
  const parsed = parse(text)
  if (parsed !== undefined && (isRecord(parsed) || Array.isArray(parsed))) {
    if (hasDuplicateKeys(text)) throw new Error('Recording contains JSON with duplicate keys, which can hide private data')
    const mapped = JSON.stringify(map(parsed))
    if (mapped === JSON.stringify(parsed)) return text
    const trailing = text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : ''
    return mapped + trailing
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
  const secrets = new Set<string>()
  const counts = new Map<string, number>()
  let ordered: (readonly [string, string])[] | undefined
  const register = (value: string, kind: string): void => {
    if (!value || placeholder.test(value) || replacements.has(value)) return
    const next = (counts.get(kind) ?? 0) + 1
    counts.set(kind, next)
    replacements.set(value, `${kind}_${String(next)}`)
    ordered = undefined
  }
  const registerSecret = (value: string): void => {
    const secret = value.replace(/^(?:bearer|basic|token)\s+/i, '')
    if (secret.length < 24 && (secret.length < 8 || !/\d/.test(secret))) return
    secrets.add(secret)
    register(secret, 'SECRET')
  }
  const discoverField = (key: string, value: Json | undefined): void => {
    if (typeof value !== 'string' && typeof value !== 'number') return
    const kind = identityKind(key)
    if (kind) register(String(value), kind)
    else if (typeof value === 'string' && isCredential(key)) registerSecret(value)
  }
  const discoverText = (text: string): string => {
    for (const match of text.matchAll(email)) register(match[0], 'EMAIL')
    for (const match of text.matchAll(assignments)) {
      const kind = identityKind(match[1] ?? '')
      if (kind !== undefined) register(match[2] ?? '', kind)
    }
    for (const match of text.matchAll(credentials)) registerSecret(match[2] ?? '')
    for (const match of text.matchAll(bearer)) registerSecret(match[1] ?? '')
    return text
  }
  const discoverValue = (value: Json): Json => {
    if (typeof value === 'string') {
      structured(value, discoverValue, discoverText)
    } else if (Array.isArray(value)) {
      value.forEach(discoverValue)
    } else if (isRecord(value)) {
      const attribute = value['value']
      if (typeof value['key'] === 'string' && isRecord(attribute)) discoverField(value['key'], attribute['stringValue'] ?? attribute['intValue'])
      for (const [key, nested] of Object.entries(value)) {
        discoverField(key, nested)
        discoverText(key)
        discoverValue(nested)
      }
    }
    return value
  }
  const replaceText = (input: string): string => {
    ordered ??= [...replacements].sort(([left], [right]) => right.length - left.length)
    let text = input
    for (const [before, after] of ordered) {
      if (!paths.has(before) && !secrets.has(before) && (before.length < 4 || /^\d+$/.test(before))) continue
      text = text.replaceAll(before, after)
    }
    text = text.replaceAll(assignments, (match: string, _key: string, value: string) =>
      match.slice(0, match.length - value.length) + (replacements.get(value) ?? value))
    return text.replaceAll(homes, (_home, prefix: string) => `${prefix}USER`)
      .replaceAll(rootHome, (_root, separator: string) => `${separator}home${separator}USER`)
      .replaceAll(profile, 'REDACTED_HOME')
  }
  const identity = (value: Json): Json => typeof value === 'number' ? replacements.get(String(value)) ?? value : mapValue(value)
  const attributeValue = (value: { [key: string]: Json }): Json => Object.fromEntries(Object.entries(value).map(([field, content]) => {
    const masked = identity(content)
    return [field === 'intValue' && masked !== content ? 'stringValue' : field, masked]
  }))
  const mapValue = (value: Json): Json => {
    if (typeof value === 'string') return replacements.get(value) ?? structured(value, mapValue, replaceText)
    if (Array.isArray(value)) return value.map(mapValue)
    if (isRecord(value)) {
      const attribute = isAttribute(value)
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
        replaceText(key),
        identityKind(key) ? identity(nested)
          : attribute && key === 'value' && isRecord(nested) ? attributeValue(nested)
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

export const assertAnonymous = (texts: readonly string[]): void => {
  const anonymizer = createAnonymizer()
  anonymizer.discover(texts)
  if (texts.some((text) => anonymizer.text(text) !== text)) {
    throw new Error('Recording contains private data; anonymization is required')
  }
}
