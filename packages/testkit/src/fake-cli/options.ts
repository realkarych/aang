export interface OptionSpec {
  readonly key: string
  readonly names: readonly string[]
  readonly takesValue: boolean
}

export interface ParsedOptions {
  readonly flags: ReadonlySet<string>
  readonly values: ReadonlyMap<string, readonly string[]>
  readonly positionals: readonly string[]
}

export type ParseResult =
  | { readonly ok: true; readonly options: ParsedOptions }
  | { readonly ok: false; readonly problem: 'unknown' | 'missing_value'; readonly argument: string }

export const flag = (key: string, ...aliases: string[]): OptionSpec => ({
  key,
  names: [`--${key}`, ...aliases],
  takesValue: false,
})

export const valued = (key: string, ...aliases: string[]): OptionSpec => ({
  key,
  names: [`--${key}`, ...aliases],
  takesValue: true,
})

const isOption = (argument: string): boolean => argument.startsWith('-') && argument !== '-'

export const parseOptions = (argv: readonly string[], specs: readonly OptionSpec[]): ParseResult => {
  const byName = new Map(specs.flatMap((spec) => spec.names.map((name) => [name, spec] as const)))
  const flags = new Set<string>()
  const values = new Map<string, string[]>()
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ''
    if (argument === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (!isOption(argument)) {
      positionals.push(argument)
      continue
    }
    const separator = argument.indexOf('=')
    const name = separator === -1 ? argument : argument.slice(0, separator)
    const spec = byName.get(name)
    if (spec === undefined) {
      return { ok: false, problem: 'unknown', argument: name }
    }
    if (!spec.takesValue) {
      flags.add(spec.key)
      continue
    }
    const value = separator === -1 ? argv[index + 1] : argument.slice(separator + 1)
    if (value === undefined) {
      return { ok: false, problem: 'missing_value', argument: name }
    }
    if (separator === -1) {
      index += 1
    }
    values.set(spec.key, [...(values.get(spec.key) ?? []), value])
  }
  return { ok: true, options: { flags, values, positionals } }
}

export const lastValue = (options: ParsedOptions, key: string): string | undefined => options.values.get(key)?.at(-1)

export const allValues = (options: ParsedOptions, key: string): readonly string[] => options.values.get(key) ?? []
