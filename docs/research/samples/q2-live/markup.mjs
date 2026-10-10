import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tasks } from './tasks.mjs'

const passed = ['confirmed', 'passed_unversioned', 'reported_done']
const titled = (pattern) => `(?i:${pattern})`
const stage = (pattern, execution) => ({ stage: { title: titled(pattern), ...(execution === undefined ? {} : { execution }) } })
const tested = (pattern) => ({ any: [stage(pattern, ['done']), { criterion: { text: titled(pattern), status: passed } }] })
const done = (pattern) => stage(pattern, ['done'])
const planned = (patterns) => ({ all: patterns.map((pattern) => stage(pattern)) })

const cli = '\\bcli\\b|command[ -]line'

export const markup = {
  ledger: {
    'plan-written': planned(['pars|csv', 'balanc', 'conver|currenc', cli, 'export|month|summar']),
    'parse-tested': tested('pars|csv'),
    'parse-done': done('pars|csv'),
    'balances-tested': tested('balanc'),
    'balances-done': done('balanc'),
    'conversion-tested': tested('conver|currenc|exchange'),
    'conversion-done': done('conver|currenc|exchange'),
    'cli-tested': tested(cli),
    'cli-done': done(cli),
    'export-tested': tested('export|month|summar'),
    'export-done': done('export|month|summar'),
    'cents-planned': stage('cent|integer|minor unit'),
    'cents-done': done('cent|integer|minor unit'),
  },
  logstats: {
    'triage-tested': tested('pars|fail|fix|triage'),
    'triage-done': done('pars|fail|fix|triage'),
    'plan-written': planned(['aggregat|statistic|percentil', cli, 'html|report', 'stream|readline|memory']),
    'aggregate-tested': tested('aggregat|statistic|percentil'),
    'aggregate-done': done('aggregat|statistic|percentil'),
    'generator-done': done('generat|synthetic|perform|benchmark|timing'),
    'cli-tested': tested(cli),
    'cli-done': done(cli),
    'report-tested': tested('html|report'),
    'report-done': done('html|report'),
    'streaming-tested': tested('stream|readline|memory'),
    'streaming-done': done('stream|readline|memory'),
  },
  kvstore: {
    'plan-written': planned(['log|wal|replay', 'compact|snapshot', 'batch|transaction|atomic', cli]),
    'log-tested': tested('log|wal|replay|store'),
    'log-done': done('log|wal|replay|store'),
    'crash-tested': tested('crash|torn|recover'),
    'crash-done': done('crash|torn|recover'),
    'compaction-tested': tested('compact|snapshot'),
    'compaction-done': done('compact|snapshot'),
    'batch-tested': tested('batch|transaction|atomic'),
    'batch-done': done('batch|transaction|atomic'),
    'cli-tested': tested(cli),
    'cli-done': done(cli),
    'ttl-planned': stage('ttl|expir|time to live'),
    'ttl-done': done('ttl|expir|time to live'),
  },
  mdlinks: {
    'plan-written': planned(['extract|pars', 'check|anchor|valid|resolv', 'report|output|exit', 'fix|repair|rewrite']),
    'extract-tested': tested('extract|pars'),
    'extract-done': done('extract|pars'),
    'check-tested': tested('check|anchor|valid|resolv'),
    'check-done': done('check|anchor|valid|resolv'),
    'report-tested': tested('report|output|exit'),
    'report-done': done('report|output|exit'),
    'fix-tested': tested('fix|repair|rewrite'),
    'fix-done': done('fix|repair|rewrite'),
    'json-planned': stage('json'),
    'json-done': done('json'),
  },
}

const descriptions = Object.fromEntries(
  Object.entries(tasks).map(([task, { turns }]) => [task, Object.fromEntries(turns.flatMap(({ events }) => events.map(({ label, description }) => [label, description])))]),
)

const [fixtures, only] = process.argv.slice(2)
if (fixtures !== undefined) {
  for (const runtime of (await readdir(fixtures)).filter((name) => only === undefined || name === only)) {
    for (const version of await readdir(join(fixtures, runtime))) {
      for (const surface of await readdir(join(fixtures, runtime, version))) {
        for (const os of await readdir(join(fixtures, runtime, version, surface))) {
          for (const scenario of await readdir(join(fixtures, runtime, version, surface, os))) {
            const task = /^workload-(.+)$/.exec(scenario)?.[1]
            const predicates = task === undefined ? undefined : markup[task]
            if (predicates === undefined) continue
            const path = join(fixtures, runtime, version, surface, os, scenario, 'manifest.json')
            const manifest = JSON.parse(await readFile(path, 'utf8'))
            for (const event of manifest.control_events) {
              event.expected_map_change.description = descriptions[task][event.label] ?? event.expected_map_change.description
              const predicate = predicates[event.label]
              if (predicate === undefined) delete event.expected_map_change.predicate
              else event.expected_map_change.predicate = predicate
            }
            await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
            const marked = manifest.control_events.filter(({ expected_map_change: change }) => change.predicate !== undefined).length
            process.stdout.write(`${runtime}/${version}/${surface}/${os}/${scenario}: ${String(marked)} of ${String(manifest.control_events.length)} events with a predicate\n`)
          }
        }
      }
    }
  }
}
