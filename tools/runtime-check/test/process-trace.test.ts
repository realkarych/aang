import { expect, test } from 'vitest'
import { describeProcessTrace, type ProcessTraceEvidence } from '../dist/process-trace.js'

const event = (pid: number, ppid: number, name: string, createdAt: string) => ({ pid, ppid, name, parentName: null, createdAt })

const evidence = (started: ProcessTraceEvidence['started']): ProcessTraceEvidence => ({
  rootPid: 10,
  rootName: 'codex.exe',
  harnessPid: 1,
  observerPid: 2,
  started,
})

test('the report counts separate CLI processes when Windows reuses a PID', () => {
  const report = describeProcessTrace(evidence([
    event(10, 1, 'codex.exe', '134354340829078202'),
    event(20, 10, 'git.exe', '134354340829078203'),
    event(30, 10, 'pwsh.exe', '134354340829078204'),
    event(20, 30, 'aang-hook.exe', '134354340829078205'),
  ]))
  expect(report.treeFromTrace).toEqual({ processes: 4, names: { 'git.exe': 1, 'pwsh.exe': 1, 'aang-hook.exe': 1 } })
  expect(report.startedOutsideTree).toEqual([])
})

test('a recycled CLI or root PID does not bring unrelated processes into the report tree', () => {
  const report = describeProcessTrace(evidence([
    event(10, 1, 'csc.exe', '134354340829078200'),
    event(10, 1, 'codex.exe', '134354340829078202'),
    event(20, 10, 'git.exe', '134354340829078203'),
    event(20, 99, 'service.exe', '134354340829078204'),
    event(30, 20, 'worker.exe', '134354340829078205'),
    event(10, 99, 'codex.exe', '134354340829078206'),
    event(40, 10, 'worker.exe', '134354340829078207'),
  ]))
  expect(report.treeFromTrace).toEqual({ processes: 2, names: { 'git.exe': 1 } })
  expect(report.startedOutsideTree.map(({ pid, name, parent }) => ({ pid, name, parent }))).toEqual([
    { pid: 20, name: 'service.exe', parent: null },
    { pid: 30, name: 'worker.exe', parent: 'service.exe' },
    { pid: 10, name: 'codex.exe', parent: null },
    { pid: 40, name: 'worker.exe', parent: 'codex.exe' },
  ])
})

test('the report resolves shuffled equal-time parent events and duplicate deliveries', () => {
  const child = event(20, 10, 'git.exe', '134354340829078202')
  const report = describeProcessTrace(evidence([
    event(30, 20, 'conhost.exe', '134354340829078202'),
    child,
    event(10, 1, 'codex.exe', '134354340829078202'),
    { ...child },
  ]))
  expect(report.treeFromTrace).toEqual({ processes: 3, names: { 'git.exe': 1, 'conhost.exe': 1 } })
  expect(report.startedOutsideTree).toEqual([])
})

test('the report rejects missing or ambiguous process identities', () => {
  const root = event(10, 1, 'codex.exe', '134354340829078202')
  for (const started of [
    [],
    [root, { ...root, ppid: 99 }],
    [root, event(10, 1, 'codex.exe', '134354340829078203')],
    [root, event(20, 30, 'first.exe', '134354340829078203'), event(30, 20, 'second.exe', '134354340829078203')],
  ]) {
    expect(() => describeProcessTrace(evidence(started))).toThrow()
  }
})
