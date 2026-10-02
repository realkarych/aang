export interface ProfileCall {
  readonly env: NodeJS.ProcessEnv
}

export interface Requirement<C extends ProfileCall> {
  readonly id: string
  readonly met: (call: C) => boolean
}

export const environmentRequirement = <C extends ProfileCall>(name: string, value: string): Requirement<C> => ({
  id: `${name}=${value}`,
  met: ({ env }) => env[name] === value,
})

export const violations = <C extends ProfileCall>(requirements: readonly Requirement<C>[], call: C): string[] =>
  requirements.filter((requirement) => !requirement.met(call)).map((requirement) => requirement.id)

export const isolationMessage = (runtime: string, missing: readonly string[]): string =>
  `fake ${runtime}: observer isolation profile violated: ${missing.join(', ')}`

export const scenarioMessage = (runtime: string, problem: string): string => `fake ${runtime}: scenario: ${problem}`
