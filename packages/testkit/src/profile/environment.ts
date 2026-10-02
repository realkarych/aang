import { spoolEnvKeys } from '@aang/contract'

export type Environment = Readonly<Record<string, string>>

export type InheritedEnvironment = Readonly<Partial<Record<string, string>>>

const enclosingRuntimeVariable = /^(?:AANG_|CLAUDE|CODEX_|AI_AGENT$)/i

const hookVariables: readonly string[] = [...spoolEnvKeys, 'AANG_OBSERVER'].map((name) => name.toUpperCase())

const upperCased = (names: Iterable<string>): Set<string> => new Set([...names].map((name) => name.toUpperCase()))

const inheritedEntries = (env: InheritedEnvironment, dropped: (name: string) => boolean): [string, string][] =>
  Object.entries(env).flatMap(([name, value]) =>
    value === undefined || dropped(name.toUpperCase()) ? [] : [[name, value]],
  )

export const profileEnvironment = (inherited: InheritedEnvironment, explicit: Environment): Environment => {
  const overridden = upperCased(Object.keys(explicit))
  return {
    ...Object.fromEntries(
      inheritedEntries(inherited, (name) => enclosingRuntimeVariable.test(name) || overridden.has(name)),
    ),
    ...explicit,
  }
}

export const hookEnvironment = (base: InheritedEnvironment, event: Environment): Environment => {
  const overridden = upperCased(Object.keys(event))
  return {
    ...Object.fromEntries(inheritedEntries(base, (name) => hookVariables.includes(name) || overridden.has(name))),
    ...event,
  }
}
