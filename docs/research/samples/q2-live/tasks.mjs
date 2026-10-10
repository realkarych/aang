const ledgerSpec = `# ledger

A small Node.js library and command line tool for personal bookkeeping.

## Input

Transactions come as CSV text with the header \`date,account,amount,currency,memo\`:

- \`date\` is an ISO date (YYYY-MM-DD);
- \`account\` is a non-empty name such as \`cash\` or \`bank:checking\`;
- \`amount\` is a decimal number with up to two fractional digits, negative for spending;
- \`currency\` is a three-letter code (EUR, USD, GBP);
- \`memo\` is free text and may be quoted with double quotes and contain commas.

Malformed lines are reported with their line number and skipped; they never stop the parsing.

## Features

1. Parse transactions from CSV text.
2. Balances per account and currency.
3. Conversion of balances into one target currency with a table of rates.
4. A CLI \`bin/ledger.js\` with the commands \`balance <file> [--currency XXX]\` and \`report <file>\`.
5. A monthly summary exported as JSON: income, spending and net per month and account.

## Constraints

- Node.js 26, ES modules, no dependencies at all: no npm install, only built-in modules.
- Tests use \`node:test\` and \`node:assert\` in \`test/\`, run with \`node --test\`.
- Keep the code small and readable.
`

const logstatsSpec = `# logstats

A small Node.js library and command line tool that analyzes web server access logs.

## Input

One request per line in this format:

\`\`\`
2026-10-01T12:00:03Z GET /api/items 200 123ms 5120b
\`\`\`

The fields are the time, the method, the path (with an optional query string), the status code, the latency in milliseconds and the response size in bytes. Malformed lines are counted and skipped.

## Features

1. Parse log lines into records.
2. Aggregate per path (without the query string) and status class: request count, error rate, p50/p95/p99 latency, total bytes.
3. A CLI \`bin/logstats.js <file> [--top N] [--since ISO] [--json]\` printing a table or JSON.
4. An HTML report \`report.html\` with one table per status class.
5. Streaming: files larger than memory are read line by line.

## Constraints

- Node.js 26, ES modules, no dependencies at all: no npm install, only built-in modules.
- Tests use \`node:test\` and \`node:assert\` in \`test/\`, run with \`node --test\`.
- Keep the code small and readable.
`

const logstatsSeed = {
  'src/parse.js': `export const parseLine = (line) => {
  const [time, method, path, status, latency, size] = line.trim().split(' ')
  return { time, method, path, status: Number(status), latencyMs: Number(latency), bytes: Number(size) }
}
`,
  'test/parse.test.js': `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLine } from '../src/parse.js'

test('parses a request line', () => {
  assert.deepEqual(parseLine('2026-10-01T12:00:03Z GET /api/items 200 123ms 5120b'), {
    time: '2026-10-01T12:00:03Z', method: 'GET', path: '/api/items', status: 200, latencyMs: 123, bytes: 5120,
  })
})

test('rejects a malformed line', () => {
  assert.equal(parseLine('not a log line'), null)
})
`,
}

const kvstoreSpec = `# kvstore

A small persistent key-value store for Node.js with a command line tool.

## Behaviour

- Keys and values are UTF-8 strings. \`set\`, \`get\`, \`delete\` and \`list(prefix)\`.
- Every change is appended to a write-ahead log \`data/wal.log\` before it is applied in memory; the log is replayed on open.
- A torn last line of the log (a crash during a write) is ignored on replay; every complete line is applied.
- \`compact()\` writes a snapshot \`data/snapshot.json\` and truncates the log; a crash between the two steps must not lose data.
- Transactions: \`batch(operations)\` applies all operations or none.
- A CLI \`bin/kv.js <directory> set|get|delete|list|compact ...\`.

## Constraints

- Node.js 26, ES modules, no dependencies at all: no npm install, only built-in modules.
- Tests use \`node:test\` and \`node:assert\` in \`test/\`, run with \`node --test\`; tests use temporary directories.
- Keep the code small and readable.
`

const mdlinksSpec = `# mdlinks

A command line tool that checks the links of a folder of Markdown documents.

## Behaviour

- Finds every \`*.md\` file under a directory, skipping \`node_modules\` and dot directories.
- Extracts inline links \`[text](target)\`, reference links \`[text][ref]\` with their definitions, and autolinks \`<https://...>\`; links inside code spans and fenced code blocks are ignored.
- Checks relative file links (the file exists) and anchors (\`#heading\` matches a heading of the target file, using GitHub-style slugs).
- External links (http, https, mailto) are listed but never fetched.
- Reports broken links with file, line and reason; exit code 1 when any link is broken.
- \`--fix\` rewrites a broken relative link when exactly one file with the same name exists elsewhere in the folder.

## Constraints

- Node.js 26, ES modules, no dependencies at all: no npm install, only built-in modules.
- Tests use \`node:test\` and \`node:assert\` in \`test/\`, run with \`node --test\`.
- Keep the code small and readable.
`

const mdlinksSeed = {
  'docs/index.md': '# Guide\n\nStart with [installation](install.md) and the [usage notes](guide/usage.md#options).\n\nSee also [the FAQ](faq.md) and <https://example.invalid/docs>.\n',
  'docs/install.md': '# Installation\n\nRun the tool with node. Back to [the guide](index.md#guide).\n\n## Requirements\n\nNode.js 26.\n',
  'docs/guide/usage.md': '# Usage\n\n## Options\n\n- `--fix` repairs links. See [requirements](../install.md#requirements) and [the old page](../setup.md).\n\n```md\n[not a link](nowhere.md)\n```\n',
  'docs/reference/faq.md': '# FAQ\n\nAnswers live here. Go [back](../index.md).\n',
}

const turn = (name, prompt, events) => ({ name, prompt, events })
const tests = (label, description) => ({ kind: 'test', label, description })
const end = (label, description) => ({ kind: 'end', label, description })
const write = (label, path, description) => ({ kind: 'write', label, path, description })
const agent = (label, description) => ({ kind: 'agent', label, description })
const question = (label, description) => ({ kind: 'question', label, description })
const command = (label, text, description) => ({ kind: 'command', label, text, description })

export const tasks = {
  ledger: {
    files: { 'SPEC.md': ledgerSpec, 'package.json': `${JSON.stringify({ name: 'ledger', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`, '.gitignore': 'node_modules/\n' },
    turns: [
      turn('plan', 'Read SPEC.md. Write PLAN.md with five to seven numbered implementation stages, each with acceptance criteria that a test can check. Do not write any code yet. Reply with a short summary of the plan.', [
        write('plan-written', /PLAN\.md$/, 'PLAN.md is written: the map shows the planned implementation stages of the ledger library from the plan (parsing, balances, conversion, CLI, monthly export) as planned stages'),
        end('plan-ready', 'The planning turn ends: no stage is running yet and the run brief states the goal, a bookkeeping library and CLI from SPEC.md'),
      ]),
      turn('parse', 'Implement the first stage of PLAN.md: CSV parsing in src/parse.js with tests in test/parse.test.js, including quoted memos with commas and malformed lines. Run the tests with node --test and make them pass.', [
        tests('parse-tested', 'The parsing tests run and pass: the parsing stage is running or done and its test criterion is met'),
        end('parse-done', 'The parsing stage is done with src/parse.js as its output and the next stage, balances, is still planned'),
      ]),
      turn('balances', 'Implement the balances stage of PLAN.md in src/balances.js with tests. Run all tests and make them pass.', [
        tests('balances-tested', 'The balance tests pass: the balances stage is running or done and its criterion is met'),
        end('balances-done', 'The balances stage is done with src/balances.js as its output'),
      ]),
      turn('rounding', 'Before you implement currency conversion, ask me with the AskUserQuestion tool which rounding mode to use for converted amounts, with the options "Half-up" and "Banker\'s rounding". Then implement the conversion stage in src/convert.js with that rounding, with tests, and run all tests.', [
        question('rounding-answered', 'The rounding question is answered with Half-up: the question is resolved and the conversion stage continues with the chosen rounding'),
        tests('conversion-tested', 'The conversion tests pass with half-up rounding chosen by the user: the conversion stage is running or done and its criterion is met'),
        end('conversion-done', 'The conversion stage is done with src/convert.js as its output and the rounding question is answered'),
      ]),
      turn('review', 'Use the Agent tool to start one general-purpose subagent that reviews src/ for bugs and missing edge cases against SPEC.md and reports concrete findings. Then fix the confirmed findings, add tests for them and run all tests.', [
        agent('review-reported', 'The review subagent finishes and reports findings: the map shows a review stage or step with the subagent as its participant'),
        end('review-fixed', 'The confirmed review findings are fixed and all tests pass; the review stage is done'),
      ]),
      turn('cli', 'Implement the CLI stage: bin/ledger.js with the commands balance and report as described in SPEC.md, plus tests in test/cli.test.js that run it with node:child_process on a sample CSV in test/fixtures/. Run all tests.', [
        tests('cli-tested', 'The CLI tests pass: the CLI stage is running or done and its criterion is met'),
        end('cli-done', 'The CLI stage is done with bin/ledger.js as its output'),
      ]),
      turn('compact', '/compact', []),
      turn('export', 'Implement the monthly summary export stage in src/export.js and a CLI command export that writes the JSON to a file, with tests. Run all tests.', [
        tests('export-tested', 'The export tests pass: the monthly export stage is running or done and its criterion is met'),
        end('export-done', 'The monthly export stage is done with src/export.js as its output'),
      ]),
      turn('cents', 'The requirements change: amounts must be stored and computed as integer cents everywhere, and only formatted as decimals at the edges (CLI output and JSON export). Update PLAN.md with a new stage for this change, then refactor parse, balances, convert and export accordingly and keep all tests green.', [
        write('cents-planned', /PLAN\.md$/, 'PLAN.md gets a new stage for integer cents: the map shows a new or replacing stage for the refactoring to integer cents'),
        end('cents-done', 'The refactoring to integer cents is done and all tests pass; the earlier stages keep their history'),
      ]),
      turn('parallel-tests', 'In a single message start two general-purpose subagents with the Agent tool in parallel: one adds edge case tests for parsing (empty input, BOM, CRLF line endings), the other adds edge case tests for conversion (missing rate, zero amounts). Wait for both, fix any failing code and run all tests.', [
        agent('parallel-reported', 'Both test subagents finish: the map shows two subagents working in parallel on edge case tests'),
        end('parallel-done', 'The edge case tests from both subagents pass; the testing stage is done'),
      ]),
      turn('commit', 'Write README.md with installation-free usage examples of the library and the CLI. Then commit all work with git: git add -A and git commit with a descriptive message.', [
        command('committed', 'git commit', 'The work is committed: the map shows the commit as an output of the run'),
        end('commit-done', 'README.md is written and the work is committed'),
      ]),
      turn('final', 'Run the full test suite once more and check every acceptance criterion of PLAN.md. Reply with a table of the criteria and their status.', [
        tests('final-tested', 'The final test run passes: every stage of the plan is done'),
        end('final-done', 'The final check ends: the run has a result summary of the delivered library against the criteria of PLAN.md'),
      ]),
    ],
  },
  logstats: {
    files: { 'SPEC.md': logstatsSpec, 'package.json': `${JSON.stringify({ name: 'logstats', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`, '.gitignore': 'node_modules/\n', ...logstatsSeed },
    turns: [
      turn('triage', 'The tests in test/ fail. Run node --test, find out why, and fix src/parse.js so that the existing tests pass without changing them. Explain the cause in one sentence.', [
        tests('triage-tested', 'The failing parse tests are fixed and pass: a stage for fixing the parser is done and the failure no longer needs attention'),
        end('triage-done', 'The fix of the parser is done with src/parse.js as its output'),
      ]),
      turn('plan', 'Read SPEC.md and write PLAN.md with numbered implementation stages for the remaining features, each with acceptance criteria. Track the stages with your task list tool. No code in this step.', [
        write('plan-written', /PLAN\.md$/, 'PLAN.md is written: the map shows the planned stages of logstats (aggregation, CLI, HTML report, streaming) as planned stages'),
        end('plan-ready', 'The planning turn ends: the planned stages wait and the run brief states the goal, a log analysis library and CLI'),
      ]),
      turn('aggregate', 'Implement the aggregation stage in src/aggregate.js with exact p50/p95/p99 by nearest rank, with tests on a generated log. Run all tests.', [
        tests('aggregate-tested', 'The aggregation tests pass: the aggregation stage is running or done and its criterion is met'),
        end('aggregate-done', 'The aggregation stage is done with src/aggregate.js as its output'),
      ]),
      turn('generator', 'Write scripts/generate.js that writes a synthetic access log with a given number of lines to a file, then run it with node to create a log of 300000 lines in tmp/big.log and measure how long the aggregation of src/aggregate.js takes on it with a one-off node -e script. Report the timing.', [
        command('big-log', 'generate.js', 'A large synthetic log is generated: the map shows a performance check step running'),
        end('generator-done', 'The generator and the timing are done; the timing is reported as a result'),
      ]),
      turn('cli', 'Implement the CLI stage: bin/logstats.js with --top, --since and --json, with tests in test/cli.test.js that run it on a small fixture log. Run all tests.', [
        tests('cli-tested', 'The CLI tests pass: the CLI stage is running or done and its criterion is met'),
        end('cli-done', 'The CLI stage is done with bin/logstats.js as its output'),
      ]),
      turn('format', 'Before the HTML report, ask me with the AskUserQuestion tool whether the report should be a single self-contained file or use a separate CSS file, with these two options. Then implement the HTML report stage in src/report.js and a --html option of the CLI accordingly, with tests. Run all tests.', [
        question('format-answered', 'The report format question is answered with a single self-contained file: the question is resolved and the report stage continues with that choice'),
        tests('report-tested', 'The HTML report tests pass with a single self-contained file chosen by the user: the report stage is running or done'),
        end('report-done', 'The HTML report stage is done with src/report.js as its output and the question is answered'),
      ]),
      turn('review', 'Use the Agent tool to start a general-purpose subagent that reviews the whole project for bugs, quadratic algorithms and missing edge cases and reports concrete findings. Fix the confirmed findings with tests and run all tests.', [
        agent('review-reported', 'The review subagent finishes with findings: the map shows a review stage or step with the subagent as participant'),
        end('review-fixed', 'The confirmed findings are fixed and the tests pass; the review is done'),
      ]),
      turn('compact', '/compact', []),
      turn('streaming', 'Implement the streaming stage: read the input with node:readline line by line so memory stays flat, keep the same results, and add a test that compares streaming and in-memory results on the same log. Run all tests.', [
        tests('streaming-tested', 'The streaming tests pass: the streaming stage is running or done and its criterion is met'),
        end('streaming-done', 'The streaming stage is done and the earlier stages stay done'),
      ]),
      turn('parallel-docs', 'In a single message start two general-purpose subagents with the Agent tool in parallel: one writes README.md with usage examples, the other writes docs/FORMAT.md describing the log format and the metrics. Wait for both and check that the examples in README.md work by running them.', [
        agent('docs-reported', 'Both documentation subagents finish: the map shows two subagents working in parallel on documentation'),
        end('docs-done', 'README.md and docs/FORMAT.md are written; the documentation stage is done'),
      ]),
      turn('commit', 'Remove tmp/ and commit all work with git: git add -A and git commit with a descriptive message.', [
        command('committed', 'git commit', 'The work is committed: the map shows the commit as an output of the run'),
        end('commit-done', 'The work is committed and the temporary log is removed'),
      ]),
      turn('final', 'Run all tests once more and check every acceptance criterion of PLAN.md. Reply with a table of the criteria and their status.', [
        tests('final-tested', 'The final test run passes: every stage of the plan is done'),
        end('final-done', 'The final check ends: the run has a result summary against the criteria of PLAN.md'),
      ]),
    ],
  },
  kvstore: {
    files: { 'SPEC.md': kvstoreSpec, 'package.json': `${JSON.stringify({ name: 'kvstore', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`, '.gitignore': 'node_modules/\ndata/\n' },
    turns: [
      turn('plan', 'Read SPEC.md and write PLAN.md with numbered implementation stages, each with acceptance criteria a test can check, including the crash cases. No code yet. Reply with a short summary.', [
        write('plan-written', /PLAN\.md$/, 'PLAN.md is written: the map shows the planned stages of the key-value store (log, replay, compaction, batches, CLI) as planned stages'),
        end('plan-ready', 'The planning turn ends: the planned stages wait and the run brief states the goal, a persistent key-value store'),
      ]),
      turn('log', 'Implement the write-ahead log and the in-memory store with set, get, delete and list in src/store.js, with tests in test/store.test.js that reopen the store from its log. Run the tests.', [
        tests('log-tested', 'The store tests pass: the log stage is running or done and its criterion is met'),
        end('log-done', 'The log stage is done with src/store.js as its output'),
      ]),
      turn('crash', 'Add the torn-line case: write a test that truncates the last line of the log in the middle and checks that every complete change survives a reopen. Make it pass.', [
        tests('crash-tested', 'The torn-line test passes: the crash recovery criterion is met'),
        end('crash-done', 'Crash recovery of a torn log line is done'),
      ]),
      turn('durability', 'Before implementing compaction, ask me with the AskUserQuestion tool whether compaction must call fsync on the snapshot and the directory (slower but durable) or may skip it, with these two options. Then implement compact() accordingly with a test that simulates a crash between writing the snapshot and truncating the log. Run all tests.', [
        question('durability-answered', 'The durability question is answered with fsync: the question is resolved and the compaction stage continues with durable writes'),
        tests('compaction-tested', 'The compaction tests pass, including the crash between snapshot and truncation: the compaction stage is running or done'),
        end('compaction-done', 'The compaction stage is done and the question is answered'),
      ]),
      turn('batch', 'Implement batch(operations) with all-or-nothing semantics in the log (a batch is one log line) and tests, including a torn batch line. Run all tests.', [
        tests('batch-tested', 'The batch tests pass: the batch stage is running or done and its criterion is met'),
        end('batch-done', 'The batch stage is done'),
      ]),
      turn('review', 'Use the Agent tool to start one general-purpose subagent that reviews src/ for durability and concurrency bugs against SPEC.md and reports concrete findings with line numbers. Fix the confirmed findings with tests and run all tests.', [
        agent('review-reported', 'The review subagent finishes with findings: the map shows a review stage or step with the subagent as participant'),
        end('review-fixed', 'The confirmed findings are fixed and the tests pass; the review is done'),
      ]),
      turn('cli', 'Implement bin/kv.js with set, get, delete, list and compact, with tests in test/cli.test.js that run it on a temporary directory. Run all tests.', [
        tests('cli-tested', 'The CLI tests pass: the CLI stage is running or done and its criterion is met'),
        end('cli-done', 'The CLI stage is done with bin/kv.js as its output'),
      ]),
      turn('compact', '/compact', []),
      turn('ttl', 'The requirements change: keys may have a time to live. Add set(key, value, { ttlMs }), expiry on read and during compaction, and a --ttl option of the CLI. Update PLAN.md with a new stage for it first, then implement with tests and run all tests.', [
        write('ttl-planned', /PLAN\.md$/, 'PLAN.md gets a stage for expiring keys: the map shows a new stage for the time to live'),
        end('ttl-done', 'Expiring keys are implemented and all tests pass'),
      ]),
      turn('parallel-bench', 'In a single message start two general-purpose subagents with the Agent tool in parallel: one writes scripts/bench.js measuring set and get throughput for 100000 keys, the other adds property-style randomized tests that compare the store with a plain Map after random operations and reopenings. Wait for both, run the benchmark once and all tests.', [
        agent('parallel-reported', 'Both subagents finish: the map shows two subagents working in parallel on the benchmark and the randomized tests'),
        end('parallel-done', 'The benchmark ran and the randomized tests pass'),
      ]),
      turn('commit', 'Write README.md with usage of the library and the CLI and the durability guarantees. Commit all work with git: git add -A and git commit with a descriptive message.', [
        command('committed', 'git commit', 'The work is committed: the map shows the commit as an output of the run'),
        end('commit-done', 'README.md is written and the work is committed'),
      ]),
      turn('final', 'Run all tests once more and check every acceptance criterion of PLAN.md. Reply with a table of the criteria and their status.', [
        tests('final-tested', 'The final test run passes: every stage of the plan is done'),
        end('final-done', 'The final check ends: the run has a result summary against the criteria of PLAN.md'),
      ]),
    ],
  },
  mdlinks: {
    files: { 'SPEC.md': mdlinksSpec, 'package.json': `${JSON.stringify({ name: 'mdlinks', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`, '.gitignore': 'node_modules/\n', ...mdlinksSeed },
    turns: [
      turn('explore', 'Read SPEC.md and the Markdown files under docs/. List which links in docs/ are broken and why, by reading the files yourself. Do not write code yet.', [
        end('explore-done', 'The exploration ends: the map shows an analysis step with the broken links found in docs/'),
      ]),
      turn('plan', 'Write PLAN.md with numbered implementation stages for mdlinks, each with acceptance criteria a test can check. Track the stages with your task list tool. No code yet.', [
        write('plan-written', /PLAN\.md$/, 'PLAN.md is written: the map shows the planned stages of mdlinks (extraction, file checks, anchors, report, fix) as planned stages'),
        end('plan-ready', 'The planning turn ends: the planned stages wait and the run brief states the goal, a link checker for Markdown'),
      ]),
      turn('extract', 'Implement link extraction in src/extract.js (inline, reference and autolinks; ignore code spans and fenced code) with tests. Run the tests.', [
        tests('extract-tested', 'The extraction tests pass: the extraction stage is running or done and its criterion is met'),
        end('extract-done', 'The extraction stage is done with src/extract.js as its output'),
      ]),
      turn('check', 'Implement file and anchor checks in src/check.js with GitHub-style heading slugs, with tests that use docs/ as a fixture. Run all tests.', [
        tests('check-tested', 'The check tests pass and find the broken links of docs/: the checking stage is running or done'),
        end('check-done', 'The checking stage is done with src/check.js as its output'),
      ]),
      turn('slugs', 'Before the report, ask me with the AskUserQuestion tool whether anchors must match headings case-sensitively or case-insensitively, with these two options. Then apply the answer in src/check.js with a test, and implement the report and exit code in bin/mdlinks.js with tests. Run all tests.', [
        question('slugs-answered', 'The anchor question is answered with case-sensitive matching: the question is resolved and the checking continues with that rule'),
        tests('report-tested', 'The report tests pass: the CLI report stage is running or done'),
        end('report-done', 'The report stage is done with bin/mdlinks.js as its output and the question is answered'),
      ]),
      turn('review', 'Use the Agent tool to start one general-purpose subagent that reviews the parser in src/extract.js against CommonMark corner cases (nested brackets, escaped brackets, titles in links, angle-bracket destinations) and reports concrete failing inputs. Add those inputs as tests and fix them. Run all tests.', [
        agent('review-reported', 'The review subagent finishes with failing inputs: the map shows a review stage or step with the subagent as participant'),
        end('review-fixed', 'The failing inputs are fixed and the tests pass; the review is done'),
      ]),
      turn('compact', '/compact', []),
      turn('fix', 'Implement --fix as described in SPEC.md with tests on a temporary copy of docs/. Run all tests, then run the tool with --fix on a copy in tmp/ and show the diff.', [
        tests('fix-tested', 'The fix tests pass: the fix stage is running or done and its criterion is met'),
        end('fix-done', 'The fix stage is done'),
      ]),
      turn('json', 'The requirements change: the report must also be available as JSON with --json for CI use, and the exit code must be 2 for usage errors. Update PLAN.md with a new stage first, then implement with tests and run all tests.', [
        write('json-planned', /PLAN\.md$/, 'PLAN.md gets a stage for the JSON report: the map shows a new stage for the JSON output'),
        end('json-done', 'The JSON report is implemented and all tests pass'),
      ]),
      turn('parallel-docs', 'In a single message start two general-purpose subagents with the Agent tool in parallel: one writes README.md with usage examples, the other fixes the broken links of docs/ by hand in the files themselves. Wait for both, then run bin/mdlinks.js on docs/ and show that it reports no broken links.', [
        agent('docs-reported', 'Both subagents finish: the map shows two subagents working in parallel on the README and on docs/'),
        end('docs-done', 'docs/ has no broken links and README.md is written'),
      ]),
      turn('commit', 'Remove tmp/ and commit all work with git: git add -A and git commit with a descriptive message.', [
        command('committed', 'git commit', 'The work is committed: the map shows the commit as an output of the run'),
        end('commit-done', 'The work is committed'),
      ]),
      turn('final', 'Run all tests once more and check every acceptance criterion of PLAN.md. Reply with a table of the criteria and their status.', [
        tests('final-tested', 'The final test run passes: every stage of the plan is done'),
        end('final-done', 'The final check ends: the run has a result summary against the criteria of PLAN.md'),
      ]),
    ],
  },
}
