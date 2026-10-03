type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Identity = 'ACCOUNT' | 'ORGANIZATION' | 'INSTALLATION' | 'USER' | 'HOST' | 'MACHINE'

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

const hostLabel = /^([^.]+)\./

const isMachine = (kind: string): boolean => kind === 'HOST' || kind === 'MACHINE'

const isAmbiguous = (value: string): boolean => value.length < 4 || /^\d+$/.test(value)

const nameCharacter = String.raw`[\p{L}\p{N}_-]`
const afterEscape = String.raw`(?<=\\[bfnrt]|\\u[\da-f]{4}|%[\da-f]{2})`
const compoundGuards = [String.raw`(?<![\p{L}\p{N}][./])`, String.raw`(?!\.\p{N})`] as const
const timeGuards = [String.raw`(?<![\p{L}\p{N}]:)`, String.raw`(?!:\p{N})`] as const

const machinePattern = (name: string, kind: string): string => {
  if (kind === 'MACHINE' && !isAmbiguous(name)) return `(?i:${RegExp.escape(name)})`
  const guards = [...isAmbiguous(name) ? [compoundGuards] : [], .../^\d+$/.test(name) ? [timeGuards] : []]
  const before = guards.map(([guard]) => guard).join('')
  const after = guards.map(([, guard]) => guard).join('')
  return `(?i:(?:(?<!${nameCharacter})${before}|${afterEscape})${RegExp.escape(name)}(?!${nameCharacter})${after})`
}

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

const isRecord = (value: Json | undefined): value is { [key: string]: Json } => value !== null && typeof value === 'object' && !Array.isArray(value)

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

export const createAnonymizer = (
  paths: ReadonlyMap<string, string> = new Map(),
  identities: Iterable<readonly [Identity, string]> = [],
  protocol: Iterable<string> = [],
): Anonymizer => {
  const protocolValues = [...new Set(protocol)]
  const replacements = new Map(paths)
  const machines = new Map<string, { readonly after: string; readonly pattern: string }>()
  const secrets = new Set<string>()
  const counts = new Map<string, number>()
  const patterns = new Map<boolean, RegExp>()
  const lookup = (value: string): string | undefined => replacements.get(value) ?? machines.get(value.toLowerCase())?.after
  const protocolClash = (source: string): string | undefined => {
    const machine = new RegExp(source, 'u')
    return protocolValues.find((value) => machine.test(value))
  }
  const register = (value: string, kind: string, aliases: readonly string[] = [], own = false): void => {
    const names = [value, ...aliases]
    if (!value || placeholder.test(value) || lookup(value) !== undefined || (kind === 'HOST' && names.some((name) => /^localhost$/i.test(name)))) return
    const next = (counts.get(kind) ?? 0) + 1
    counts.set(kind, next)
    const after = `${kind}_${String(next)}`
    if (isMachine(kind)) {
      for (const name of names) {
        const source = machinePattern(name, kind)
        const clash = protocolClash(source)
        if (clash !== undefined) {
          throw new Error(own
            ? `The host name "${name}" of this machine matches the protocol value "${clash}" in the recording, and masking it would corrupt the recording; give the machine another host name and record again`
            : `The host name "${name}" in the recording matches its protocol value "${clash}", and masking it would corrupt the recording; change the scenario so that the recording does not carry this host name`)
        }
        machines.set(name.toLowerCase(), machines.get(name.toLowerCase()) ?? { after, pattern: source })
      }
    } else {
      replacements.set(value, after)
    }
    patterns.clear()
  }
  for (const [kind, value] of identities) register(value, kind, kind === 'HOST' ? hostLabel.exec(value)?.slice(1) : undefined, true)
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
  const pattern = (withMachines: boolean): RegExp => {
    const cached = patterns.get(withMachines)
    if (cached) return cached
    const registered = [...replacements.keys()].filter((before) => !paths.has(before) && (secrets.has(before) || !isAmbiguous(before)))
    const compiled = new RegExp([
      ...longestFirst([...paths.keys()].map((before) => [before, RegExp.escape(before)])),
      homePaths,
      ...longestFirst([
        ...registered.map((before) => [before, RegExp.escape(before)] as const),
        ...withMachines ? [...machines].map(([name, { pattern: source }]) => [name, source] as const) : [],
      ]),
    ].join('|'), 'gu')
    patterns.set(withMachines, compiled)
    return compiled
  }
  const substitute = (match: string, ...captures: unknown[]): string => {
    const { home, root, profile } = captures.at(-1) as { home?: string; root?: string; profile?: string }
    if (home !== undefined) return `${home}USER`
    if (root !== undefined) return `${root}home${root}USER`
    if (profile !== undefined) return 'REDACTED_HOME'
    return lookup(match) ?? match
  }
  const replaceText = (input: string, withMachines = true): string => input.replaceAll(pattern(withMachines), substitute)
    .replaceAll(assignments, (match: string, _key: string, value: string) => match.slice(0, match.length - value.length) + (lookup(value) ?? value))
  const identity = (value: Json): Json => typeof value === 'number' ? lookup(String(value)) ?? value : mapValue(value)
  const processDomainOf = (value: string): string => {
    const [match, segment] = processDomain.exec(value) ?? []
    if (match === undefined || segment === undefined) return replaceText(value)
    return match.slice(0, -segment.length) + (lookup(segment) ?? replaceText(segment)) + replaceText(value.slice(match.length))
  }
  const field = (key: string, value: Json): Json =>
    identityKind(key) ? identity(value)
      : normalize(key) === 'piddomain' && typeof value === 'string' ? processDomainOf(value)
        : mapValue(value)
  const attributeValue = (key: string, value: { [key: string]: Json }): Json => Object.fromEntries(Object.entries(value).map(([kind, content]) => {
    const masked = field(key, content)
    return [kind === 'intValue' && masked !== content ? 'stringValue' : kind, masked]
  }))
  const mapValue = (value: Json): Json => {
    if (typeof value === 'string') return lookup(value) ?? structured(value, mapValue, replaceText)
    if (Array.isArray(value)) return value.map(mapValue)
    if (isRecord(value)) {
      const attribute = attributeKey(value)
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
        replaceText(key, false),
        attribute !== undefined && key === 'key' ? replaceText(attribute, false)
          : attribute !== undefined && key === 'value' && isRecord(nested) ? attributeValue(attribute, nested)
            : field(key, nested),
      ]))
    }
    return value
  }
  return {
    discover: (texts) => { for (const text of texts) structured(text, discoverValue, discoverText) },
    text: (text) => structured(text, mapValue, replaceText),
    path: (path) => replaceText(path, false),
  }
}

export const assertAnonymous = (texts: readonly string[]): void => {
  const anonymizer = createAnonymizer()
  anonymizer.discover(texts)
  if (texts.some((text) => anonymizer.text(text) !== text)) {
    throw new Error('Recording contains private data; anonymization is required')
  }
}
