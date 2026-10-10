import type { CheckReport, SurfaceReport } from './check.js'

const mark = (result: string): string => (result === 'passed' ? '✔' : result === 'not_run' ? '↷' : '✘')

const surfaceLines = (result: SurfaceReport): string[] => [
  `### ${mark(result.result)} ${result.surface}${result.key === null ? '' : ` ${result.key.engine_version}`}${result.emulated ? ' (emulated Desktop engine)' : ''}`,
  '',
  ...(result.error === null ? [] : [result.error, '']),
  ...result.scenarios.flatMap((scenario) => [
    `- ${mark(scenario.result)} ${scenario.name}${scenario.reference === null ? ' (no reference recording)' : ''}`,
    ...scenario.failures.map((failure) => `  - ${failure.replaceAll('\n', ' ')}`),
    ...scenario.notes.map((note) => `  - note: ${note}`),
  ]),
  '',
]

export const summary = (report: CheckReport): string =>
  [
    `## aang surface check on ${report.os}, placement ${report.placement}`,
    '',
    `Access to the UI: ${mark(report.access.result)} ${report.access.origin ?? ''} runs ${String(report.access.runs)}, write ${String(report.access.write)}${report.access.error === null ? '' : ` — ${report.access.error}`}`,
    '',
    ...report.results.flatMap(surfaceLines),
  ].join('\n')
