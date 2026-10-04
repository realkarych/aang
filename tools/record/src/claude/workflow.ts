import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { bash, check, type Definition, playerPath, present, sessionOf } from './definition.js'
import { commandOf, findTranscript, named, readTranscript, toolResult, toolUses, type Transcript } from './transcripts.js'

const agentPrompt = (key: string, word: string): string => `[aang:${key}] Run \`echo ${word}\` with the Bash tool and report its output.`

const workflowScript = [
  "export const meta = { name: 'aang-echo', description: 'Echo words through workflow agents', phases: [{ title: 'Echo' }, { title: 'Report' }] }",
  'const words = await parallel([',
  `  () => agent('${agentPrompt('wf-left', 'left')}', { label: 'left', phase: 'Echo' }),`,
  `  () => agent('${agentPrompt('wf-right', 'right')}', { label: 'right', phase: 'Echo' }),`,
  '])',
  `const report = await agent('${agentPrompt('wf-report', 'report')}', { label: 'report', phase: 'Report' })`,
  'return { words, report }',
].join('\n')

const Snapshot = z.looseObject({
  runId: z.string(),
  workflowName: z.string(),
  status: z.string(),
  agentCount: z.number(),
  phases: z.array(z.looseObject({ title: z.string() })),
})
const JournalEntry = z.looseObject({ type: z.string(), agentId: z.string().optional(), label: z.string().optional(), phase: z.string().optional() })
const AgentMeta = z.looseObject({ agentType: z.string(), workflowPhase: z.string().optional() })

const sessionDirectory = (transcript: Transcript): string => transcript.file.slice(0, -'.jsonl'.length)

const filesMatching = async (directory: string, pattern: RegExp): Promise<string[]> =>
  (await readdir(directory).catch(() => [])).filter((name) => pattern.test(name)).map((name) => join(directory, name))

const jsonLines = async (file: string): Promise<unknown[]> =>
  (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '').map((line): unknown => JSON.parse(line))

export const workflow: Definition = {
  name: 'workflow',
  models: ['stub'],
  expectedFacts: [
    'The root session runs the workflow aang-echo with the Workflow tool after the host approves it after ~0.5 s',
    'Phase Echo runs the agents left and right in parallel, then phase Report runs the agent report; each agent runs one Bash action',
    'The workflow snapshot ends completed with three agents; its journal records the start and the result of every agent',
  ],
  script: () => ({
    workflow: [[{ tool: 'Workflow', input: { script: workflowScript } }], [{ text: 'The workflow aang-echo is running.' }], [{ text: 'The workflow aang-echo is completed.' }]],
    'wf-left': [[bash('echo left', 'Print left')], [{ text: 'left' }]],
    'wf-right': [[bash('echo right', 'Print right')], [{ text: 'right' }]],
    'wf-report': [[bash('echo report', 'Print report')], [{ text: 'report' }]],
  }),
  run: async ({ session, stage }) => {
    const summary = await stage('workflow', {
      turns: [{ prompt: `[aang:workflow] Run this workflow with the Workflow tool, passing the script verbatim, and reply with one sentence:\n${workflowScript}` }],
      decisions: [{ tool: 'Workflow', behavior: 'allow', delayMs: 500 }],
    })
    check(summary.tools.includes('Workflow'), 'The engine offered no Workflow tool')
    const sessionId = sessionOf(summary)
    const transcript = await findTranscript(session, sessionId)
    const call = present(named(toolUses(transcript), 'Workflow').at(-1), 'The session never called the Workflow tool')
    check(toolResult(transcript, call.id)?.isError === false, 'The Workflow action failed')
    const directory = sessionDirectory(transcript)
    const snapshotFile = present((await filesMatching(join(directory, 'workflows'), /^wf_.+\.json$/)).at(0), 'The session has no workflow snapshot')
    const snapshot = Snapshot.parse(JSON.parse(await readFile(snapshotFile, 'utf8')))
    check(snapshot.workflowName === 'aang-echo' && snapshot.status === 'completed' && snapshot.agentCount === 3, `The workflow snapshot is not a completed aang-echo run with three agents: ${snapshot.workflowName} ${snapshot.status} ${String(snapshot.agentCount)}`)
    check(snapshot.phases.map(({ title }) => title).join(',') === 'Echo,Report', 'The workflow snapshot does not list the phases Echo and Report')
    const runDirectory = join(directory, 'subagents', 'workflows', snapshot.runId)
    const journalFile = join(runDirectory, 'journal.jsonl')
    const journal = (await jsonLines(journalFile)).map((entry) => JournalEntry.parse(entry))
    const started = journal.filter(({ type }) => type === 'started')
    const firstResult = journal.findIndex(({ type }) => type === 'result')
    check(started.map(({ label }) => label).toSorted().join(',') === 'left,report,right' && journal.filter(({ type }) => type === 'result').length === 3,
      'The workflow journal does not record the start and the result of left, right and report')
    check(['left', 'right'].every((label) => journal.findIndex((entry) => entry.type === 'started' && entry.label === label) < firstResult),
      'The agents left and right did not run in parallel')
    const metas = await Promise.all((await filesMatching(runDirectory, /^agent-.+\.meta\.json$/)).map(async (file) => AgentMeta.parse(JSON.parse(await readFile(file, 'utf8')))))
    check(metas.length === 3 && metas.every(({ agentType }) => agentType === 'workflow-subagent') &&
      metas.map(({ workflowPhase }) => workflowPhase).toSorted().join(',') === 'Echo,Echo,Report', 'The workflow agents do not have meta files of their phases')
    for (const entry of started) {
      const agentFile = join(runDirectory, `agent-${present(entry.agentId, 'A started journal entry has no agent id')}.jsonl`)
      const agentTranscript = await readTranscript(session.claude, agentFile)
      check(named(toolUses(agentTranscript), 'Bash').some((use) => commandOf(use).includes(`echo ${entry.label ?? ''}`)), `The workflow agent ${entry.label ?? ''} did not run its Bash action`)
    }
    await session.checkpoint('workflow-started', { ...playerPath(session, journalFile), occurrence: 'first' },
      'A workflow starts in session S: phase Echo runs the agents left and right in parallel')
    await session.checkpoint('report-started', { ...playerPath(session, journalFile), contains: '"label":"report"', occurrence: 'first' },
      'Phase Echo is finished with the results of left and right; phase Report starts its agent')
    await session.checkpoint('workflow-completed', { ...playerPath(session, snapshotFile), contains: '"status":"completed"', occurrence: 'first' },
      'The workflow is completed with three agents in two phases; session S reports the result')
  },
}
