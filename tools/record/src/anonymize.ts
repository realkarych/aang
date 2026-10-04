import type { MachineIdentity } from './machine.js'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

type Identity = 'ACCOUNT' | 'ORGANIZATION' | 'INSTALLATION' | 'USER' | 'HOST' | 'MACHINE'

const normalize = (key: string): string => key.replaceAll(/[^a-z]/gi, '').toLowerCase()

const identityKind = (key: string): Identity | undefined => {
  const normalized = normalize(key)
  if (/(?:account)(?:id|uuid)$/.test(normalized)) return 'ACCOUNT'
  if (/(?:organization|org)(?:id|uuid)$/.test(normalized)) return 'ORGANIZATION'
  if (/(?:installation|install)(?:id|uuid)$/.test(normalized)) return 'INSTALLATION'
  if (/(?:user)(?:id|uuid)$/.test(normalized)) return 'USER'
  if (normalized === 'hostname') return 'HOST'
  if (/^machine(?:id|uuid)$/.test(normalized)) return 'MACHINE'
  return undefined
}

const isCredential = (key: string): boolean => /(?:token|apikey|secret|password|authorization)$/.test(normalize(key))

const processDomain = /^[a-z\d]+:([^:\s]+)/i

const isMachine = (kind: string): boolean => kind === 'HOST' || kind === 'MACHINE'

const holdsMachineName = (key: string): boolean => normalize(key) === 'servername'

const isAmbiguous = (value: string): boolean => value.length < 4 || /^\d+$/.test(value)

const placeholder = /^(?:ACCOUNT|ORGANIZATION|INSTALLATION|USER|HOST|MACHINE|EMAIL|SECRET)_\d+$/
const email = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/giu
const slash = String.raw`(?:\\*/|\\+u002f)`
const separators = String.raw`(?:\\+u00(?:5c|2f)|\\*/|\\+)+`
const segment = String.raw`(?:[^\\/\r\n\0"'<>]|\\+u(?!00(?:5c|2f))[0-9a-f]{4})+`
const homeDirectory = String.raw`(?<home>${slash}(?:Users|home)${slash}|[a-z]:${separators}Users${separators})${segment}`
const rootDirectory = String.raw`(?<root>${slash})root(?=${slash}\.)`
const profileVariable = String.raw`(?<profile>%USERPROFILE%|\$\{?USERPROFILE\}?)`
const homePaths = `(?i:${homeDirectory}|${rootDirectory}|${profileVariable})`
const assignments = /((?:creator[._-]?)?(?:user[._-]?)?(?:account|organization|org|installation|install|user)[._-]?(?:id|uuid))(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?([\w.-]+)/gi
const credentials = /([\w.-]*?(?:token|api[._-]?key|secret|password|authorization))(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?(?:(?:bearer|basic|token)\s+)?([\w.~+/=-]{8,})/gi
const bearer = /\bBearer\s+([\w.~+/-]+=*)/g

const holdsCommandPrefixes = (key: string): boolean => normalize(key) === 'approvedcommandprefixes'
const prefixPlaceholder = /^(?:COMMAND|ARG)_\d+$/
const quoted = String.raw`"(?:[^"\\\n]|\\.)*"`
const prefixItem = String.raw`- \[(?:${quoted}(?:, ${quoted})*)?\]`
const approvedPrefixes = new RegExp(String.raw`(?<=The following prefix rules have already been approved: )${prefixItem}(?:\n${prefixItem})*`, 'g')
const quotedParts = new RegExp(quoted, 'g')

const isRecord = (value: Json | undefined): value is { [key: string]: Json } => value !== null && typeof value === 'object' && !Array.isArray(value)

const isPrefixList = (value: Json): value is string[][] => Array.isArray(value) && value.every((prefix) => Array.isArray(prefix) && prefix.every((part) => typeof part === 'string'))

const anyValue = /^(?:string|bool|int|double|bytes|array|kvlist)Value$/

const attributeKey = (value: { [key: string]: Json }): string | undefined => {
  const content = value['value']
  return typeof value['key'] === 'string' && isRecord(content) && Object.keys(content).some((kind) => anyValue.test(kind)) ? value['key'] : undefined
}

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
  readonly path: (path: string) => string
}

export const createAnonymizer = (paths: ReadonlyMap<string, string> = new Map(), own: Iterable<MachineIdentity> = []): Anonymizer => {
  const replacements = new Map(paths)
  const machines = new Map<string, string>()
  const secrets = new Set<string>()
  const counts = new Map<string, number>()
  let cached: RegExp | undefined
  const lookup = (value: string): string | undefined => replacements.get(value)
  const machine = (value: string): string | undefined => machines.get(value.toLowerCase())
  const known = (kind: string): (value: string) => string | undefined => isMachine(kind) ? machine : lookup
  const register = (value: string, kind: Identity | 'EMAIL' | 'SECRET', aliases: readonly string[] = []): void => {
    if (!value || placeholder.test(value) || known(kind)(value) !== undefined || (kind === 'HOST' && /^localhost$/i.test(value))) return
    const next = (counts.get(kind) ?? 0) + 1
    counts.set(kind, next)
    const after = `${kind}_${String(next)}`
    if (isMachine(kind)) {
      for (const name of [value, ...aliases]) if (machine(name) === undefined) machines.set(name.toLowerCase(), after)
    } else {
      replacements.set(value, after)
      cached = undefined
    }
  }
  for (const { kind, names: [name = '', ...aliases] } of own) register(name, kind, aliases)
  const registerSecret = (value: string): void => {
    const secret = value.replace(/^(?:bearer|basic|token)\s+/i, '')
    if (secret.length < 24 && (secret.length < 8 || !/\d/.test(secret))) return
    secrets.add(secret)
    register(secret, 'SECRET')
  }
  const discoverField = (key: string, value: Json | undefined): void => {
    if (typeof value !== 'string' && typeof value !== 'number') return
    if (normalize(key) === 'piddomain' && typeof value === 'string') register(processDomain.exec(value)?.[1] ?? '', 'MACHINE')
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
  const longestFirst = (entries: (readonly [string, string])[]): string[] =>
    entries.sort(([left], [right]) => right.length - left.length).map(([, source]) => source)
  const pattern = (): RegExp => {
    if (cached) return cached
    const registered = [...replacements.keys()].filter((before) => !paths.has(before) && (secrets.has(before) || !isAmbiguous(before)))
    cached = new RegExp([
      ...longestFirst([...paths.keys()].map((before) => [before, RegExp.escape(before)])),
      homePaths,
      ...longestFirst(registered.map((before) => [before, RegExp.escape(before)])),
    ].join('|'), 'gu')
    return cached
  }
  const substitute = (match: string, ...captures: unknown[]): string => {
    const { home, root, profile } = captures.at(-1) as { home?: string; root?: string; profile?: string }
    if (home !== undefined) return `${home}USER`
    if (root !== undefined) return `${root}home${root}USER`
    if (profile !== undefined) return 'REDACTED_HOME'
    return lookup(match) ?? match
  }
  const replaceText = (input: string): string => input.replaceAll(pattern(), substitute)
    .replaceAll(assignments, (match: string, _key: string, value: string) => match.slice(0, match.length - value.length) + (lookup(value) ?? value))
  const identity = (kind: Identity, value: Json): Json => {
    if (typeof value === 'number') return known(kind)(String(value)) ?? value
    return typeof value === 'string' ? known(kind)(value) ?? mapValue(value) : mapValue(value)
  }
  const processDomainOf = (value: string): string => {
    const [match, segment] = processDomain.exec(value) ?? []
    if (match === undefined || segment === undefined) return replaceText(value)
    return match.slice(0, -segment.length) + (machine(segment) ?? replaceText(segment)) + replaceText(value.slice(match.length))
  }
  const prefixes = new Map<string, string[]>()
  const commandPrefix = (parts: readonly string[]): string[] => {
    if (parts.every((part) => prefixPlaceholder.test(part))) return [...parts]
    const original = JSON.stringify(parts)
    const masked = prefixes.get(original) ?? [`COMMAND_${String(prefixes.size + 1)}`, ...parts.slice(1).map((_, index) => `ARG_${String(index + 1)}`)]
    prefixes.set(original, masked)
    return masked
  }
  const unquote = (part: string): string => {
    const value = parse(part)
    return typeof value === 'string' ? value : part.slice(1, -1)
  }
  const prefixLists = (text: string): string => text.replaceAll(approvedPrefixes, (list) => list.split('\n')
    .map((item) => `- [${commandPrefix(item.match(quotedParts)?.map(unquote) ?? []).map((part) => JSON.stringify(part)).join(', ')}]`)
    .join('\n'))
  const field = (key: string, value: Json): Json => {
    if (holdsCommandPrefixes(key) && isPrefixList(value)) return value.map(commandPrefix)
    const kind = identityKind(key)
    if (kind !== undefined) return identity(kind, value)
    if (normalize(key) === 'piddomain' && typeof value === 'string') return processDomainOf(value)
    if (holdsMachineName(key) && typeof value === 'string') return machine(value) ?? mapValue(value)
    return mapValue(value)
  }
  const attributeValue = (key: string, value: { [key: string]: Json }): Json => Object.fromEntries(Object.entries(value).map(([kind, content]) => {
    const masked = field(key, content)
    return [kind === 'intValue' && masked !== content ? 'stringValue' : kind, masked]
  }))
  const mapValue = (value: Json): Json => {
    if (typeof value === 'string') return lookup(value) ?? structured(prefixLists(value), mapValue, replaceText)
    if (Array.isArray(value)) return value.map(mapValue)
    if (isRecord(value)) {
      const attribute = attributeKey(value)
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
        replaceText(key),
        attribute !== undefined && key === 'key' ? replaceText(attribute)
          : attribute !== undefined && key === 'value' && isRecord(nested) ? attributeValue(attribute, nested)
            : field(key, nested),
      ]))
    }
    return value
  }
  return {
    discover: (texts) => { for (const text of texts) structured(text, discoverValue, discoverText) },
    text: (text) => structured(prefixLists(text), mapValue, replaceText),
    path: replaceText,
  }
}

export const assertAnonymous = (texts: readonly string[]): void => {
  const anonymizer = createAnonymizer()
  anonymizer.discover(texts)
  if (texts.some((text) => anonymizer.text(text) !== text)) {
    throw new Error('Recording contains private data; anonymization is required')
  }
}
