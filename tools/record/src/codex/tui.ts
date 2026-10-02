import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spoolLayout } from '@aang/contract'
import type { Scenario } from '../scenario.js'
import { exists, patch, shell } from './calls.js'
import { resolveExpect } from './engine.js'
import { type StubContext, stubScenario } from './harness.js'
import { check, completedItems, containing, events, finished, hookRecords, hooksNamed, readRollout, responseItems, type Rollout, rolloutFiles } from './rollout.js'
import { logRecords } from './telemetry.js'

const surface = 'codex_tui'

const driverScript = String.raw`set codex [lindex $argv 0]
set mode [lindex $argv 1]
set prompt [lindex $argv 2]
set sessions [lindex $argv 3]
set spool [lindex $argv 4]
set codex_args [lrange $argv 6 end]
set trusted 0
log_user 0
log_file -a -noappend [lindex $argv 5]
match_max 200000
set stty_init "rows 40 cols 160"
set env(TERM) xterm-256color
proc fail {message} {
  send_user "aang-tui: $message\n"
  exit 2
}
proc count_matching {files pattern} {
  set count 0
  foreach file $files {
    if {[catch {open $file r} channel]} { continue }
    set data [read $channel]
    close $channel
    incr count [regexp -all -- $pattern $data]
  }
  return $count
}
proc rollout_count {type} {
  global sessions
  return [count_matching [glob -nocomplain -types f -directory $sessions */*/*/*.jsonl] "\"type\":\"$type\""]
}
proc hook_count {event} {
  global spool
  return [count_matching [glob -nocomplain -types f -directory $spool *] "\"hook_event_name\"\\s*:\\s*\"$event\""]
}
proc pump {seconds pattern} {
  global trusted
  set timeout $seconds
  expect {
    -re {\x1b\[6n} { send -- "\x1b\[1;1R"; exp_continue -continue_timer }
    -re {\x1b\]10;\?} { send -- "\x1b\]10;rgb:ffff/ffff/ffff\x1b\\"; exp_continue -continue_timer }
    -re {\x1b\]11;\?} { send -- "\x1b\]11;rgb:0000/0000/0000\x1b\\"; exp_continue -continue_timer }
    -re {\x1b\[\?u} { send -- "\x1b\[?0u"; exp_continue -continue_timer }
    -re {\x1b\[c} { send -- "\x1b\[?62;c"; exp_continue -continue_timer }
    -re {Trust this folder} {
      if {!$trusted} {
        set trusted 1
        send -- "\r"
      }
      exp_continue -continue_timer
    }
    -re $pattern { return 1 }
    timeout { return 0 }
    eof { return -1 }
  }
}
proc idle {seconds} {
  if {[pump $seconds {\x00\x00}] < 0} { fail "codex exited unexpectedly" }
}
proc screen {pattern seconds} {
  set result [pump $seconds $pattern]
  if {$result == 0} { fail "timed out waiting for the screen to show $pattern" }
  if {$result < 0} { fail "codex exited while waiting for $pattern" }
}
proc await {description seconds condition} {
  set deadline [expr {[clock seconds] + $seconds}]
  while {![uplevel #0 [list expr $condition]]} {
    if {[clock seconds] > $deadline} { fail "timed out waiting for $description" }
    idle 1
  }
}
proc quit {} {
  for {set attempt 0} {$attempt < 6} {incr attempt} {
    send -- "\x03"
    if {[pump 3 {\x00\x00}] < 0} { return }
  }
  fail "codex did not exit after Ctrl-C"
}
spawn -noecho $codex {*}$codex_args $prompt
if {$mode eq "approval"} {
  screen {Would you like to run} 60
  idle 1
  send -- "y"
  await "the approved turn to complete" 60 {[rollout_count task_complete] > 0}
} elseif {$mode eq "interrupt"} {
  await "the command to start" 60 {[hook_count PreToolUse] > 0}
  idle 1
  send -- "\x1b"
  await "the turn to abort" 60 {[rollout_count turn_aborted] > 0}
} else {
  await "the turn to complete" 60 {[rollout_count task_complete] > 0}
}
idle 1
quit
set status [wait]
exit [lindex $status 3]
`

type Mode = 'tools' | 'approval' | 'interrupt'

const escape = String.fromCharCode(27)
const bell = String.fromCharCode(7)
const terminalSequence = new RegExp(`${escape}\\[[0-9;?<>]*[ -/]*[@-~]|${escape}\\][^${bell}${escape}]*(?:${bell}|${escape}\\\\)`, 'g')

const blank = new RegExp(`[\\s${String.fromCharCode(0)}-${String.fromCharCode(31)}]+`, 'g')

const plainText = (screen: string): string => screen.replaceAll(terminalSequence, ' ').replaceAll(blank, ' ')

const tuiFlags: readonly string[] = ['--dangerously-bypass-hook-trust', '--no-alt-screen', '-a', 'on-request']

const driveTui = async ({ session }: StubContext, mode: Mode, prompt: string, extra: readonly string[] = []): Promise<Rollout> => {
  const expect = await resolveExpect()
  const script = join(session.work, 'codex-tui.exp')
  const screen = join(session.work, `codex-tui-${mode}.log`)
  await writeFile(script, driverScript)
  try {
    await session.run(expect, [script, session.engine.executable, mode, prompt, join(session.codex, 'sessions'), join(session.spool, spoolLayout.readyDirectory), screen, ...tuiFlags, ...extra], {
      env: { OTEL_BLRP_SCHEDULE_DELAY: '200' },
      timeoutMs: 180_000,
    })
  } catch (error) {
    const transcript = plainText(await readFile(screen, 'utf8').catch(() => '')).slice(-2_000)
    throw new Error(`Codex TUI driver failed (${error instanceof Error ? error.message : String(error)}); last screen text: ${transcript}`, { cause: error })
  }
  const files = await rolloutFiles(session.codex)
  check(files.length === 1, `the TUI wrote one rollout (${String(files.length)})`)
  return readRollout(session.codex, files[0] ?? '')
}

const tools = stubScenario({
  name: 'tools',
  surface,
  expectedFacts: [
    'An interactive Codex TUI session (in-process, originator codex-tui, source cli) runs exec_command `echo hi` and applies a patch adding result.json',
    'The TUI exits cleanly with Ctrl-C after the turn; SessionEnd fires',
  ],
  script: { 'tui-tools': [[shell('echo hi')], [patch('result.json', '{"status": "ok"}')]] },
  run: async (context) => {
    const { session } = context
    const rollout = await driveTui(context, 'tools', '[aang:tui-tools] Run `echo hi`, add result.json with a patch, then reply done.')
    check(completedItems(rollout, 'CommandExecution').length === 1 && completedItems(rollout, 'FileChange').length === 1, 'the command and the patch completed')
    check(await exists(join(session.project, 'result.json')), 'result.json was written')
    check(hooksNamed(await hookRecords(session.spool), 'SessionEnd').length === 1, 'SessionEnd fired on exit')
    await session.checkpoint('result-written', { root: 'home', path: 'project/result.json' }, 'result.json appears as the output file of the interactive stage')
    await session.checkpoint('turn-complete', finished(rollout), 'The interactive turn completes with both actions finished')
  },
})

const approval = stubScenario({
  name: 'approval',
  surface,
  expectedFacts: [
    'With -a on-request -s read-only the model requests require_escalated for `touch approved.txt`; the TUI asks "Would you like to run the following command?"',
    'The PermissionRequest hook is spooled while the request waits; the rollout has no record of the wait',
    'The user approves with y; OTel codex.tool_decision reports decision approved, source User, call_id equal to the PreToolUse tool_use_id',
  ],
  script: {
    'tui-approval': [[shell('touch approved.txt', { sandbox_permissions: 'require_escalated', justification: 'Create approved.txt outside the read-only sandbox' })]],
  },
  run: async (context) => {
    const { session, telemetry } = context
    const rollout = await driveTui(context, 'approval', '[aang:tui-approval] Create approved.txt with `touch approved.txt` and ask for approval.', ['-s', 'read-only'])
    const hooks = await hookRecords(session.spool)
    const request = hooksNamed(hooks, 'PermissionRequest', { key: 'tool_name', value: 'Bash' })
    const started = hooksNamed(hooks, 'PreToolUse', { key: 'tool_name', value: 'Bash' })[0]
    check(request.length === 1 && started !== undefined, 'PermissionRequest was spooled for the Bash command')
    const decisions = logRecords(telemetry.bodies).filter((record) => record['event.name'] === 'codex.tool_decision')
    check(decisions.some((record) => record['decision'] === 'approved' && record['source'] === 'User' && record['call_id'] === started?.['tool_use_id']),
      `OTel reported a user approval (${JSON.stringify(decisions)})`)
    check(await exists(join(session.project, 'approved.txt')), 'the approved command ran')
    await session.checkpoint('approval-requested', { hook: { event: 'PermissionRequest' } }, 'The action waits for the user to approve the command')
    await session.checkpoint('approval-granted', { hook: { event: 'PostToolUse' } }, 'The approved command completes and the wait for approval ends')
    await session.checkpoint('turn-complete', finished(rollout), 'The turn completes after the approved command')
  },
})

const interrupt = stubScenario({
  name: 'interrupt',
  surface,
  expectedFacts: [
    'The TUI runs exec_command `sleep 30`; the user presses Esc while it runs',
    'The rollout records function_call_output "aborted by user" and event_msg turn_aborted with reason interrupted; the Interrupt hook fires and Stop does not',
    'When the TUI exits, the killed command adds a late item_completed CommandExecution with status failed after turn_aborted',
  ],
  script: { 'tui-interrupt': [[shell('sleep 30', { yield_time_ms: 30_000 })]] },
  run: async (context) => {
    const { session } = context
    const rollout = await driveTui(context, 'interrupt', '[aang:tui-interrupt] Run `sleep 30`, then reply done.')
    check(events(rollout, 'turn_aborted').some((event) => event['reason'] === 'interrupted'), 'the turn was aborted by the interrupt')
    check(responseItems(rollout, 'function_call_output').some((item) => String(item['output']).includes('aborted by user')), 'the running command was aborted')
    const hooks = await hookRecords(session.spool)
    check(hooksNamed(hooks, 'Interrupt').length === 1 && hooksNamed(hooks, 'Stop').length === 0, 'Interrupt fired instead of Stop')
    await session.checkpoint('interrupted', { hook: { event: 'Interrupt' } }, 'The user interrupts the turn; the running action stops as interrupted')
    await session.checkpoint('turn-aborted', containing(rollout, '"type":"turn_aborted"'), 'The turn ends as aborted, not completed')
    await session.checkpoint('late-completion', containing(rollout, '"status":"failed"'), 'The aborted command reports its failed completion after turn_aborted; the action stays interrupted and the turn stays aborted')
  },
})

export const tuiScenarios: readonly Scenario[] = [tools, approval, interrupt]
