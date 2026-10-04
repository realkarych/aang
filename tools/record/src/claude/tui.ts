import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spoolLayout } from '@aang/contract'
import { resolveExpect } from '../expect.js'
import type { ScenarioSession } from '../scenario.js'
import { plainText } from '../terminal.js'

const driverScript = String.raw`set claude [lindex $argv 0]
set spool [lindex $argv 1]
set config [lindex $argv 2]
set steps [lindex $argv 3]
set claude_args [lrange $argv 5 end]
log_user 0
log_file -a -noappend [lindex $argv 4]
match_max 200000
set stty_init "rows 50 cols 200"
set env(TERM) xterm-256color
array set named_keys [list enter "\r" escape "\x1b" right "\x1b\[C" down "\x1b\[B"]
proc fail {message} {
  puts stderr "aang-tui: $message"
  exit 2
}
proc count_matching {files pattern} {
  set count 0
  foreach file $files {
    if {[catch {open $file r} channel]} { continue }
    fconfigure $channel -translation binary
    set data [read $channel]
    close $channel
    incr count [regexp -all -- $pattern $data]
  }
  return $count
}
proc pump {seconds pattern} {
  set timeout $seconds
  expect {
    -re {\x1b\[6n} { send -- "\x1b\[1;1R"; exp_continue -continue_timer }
    -re {\x1b\]10;\?} { send -- "\x1b\]10;rgb:ffff/ffff/ffff\x1b\\"; exp_continue -continue_timer }
    -re {\x1b\]11;\?} { send -- "\x1b\]11;rgb:0000/0000/0000\x1b\\"; exp_continue -continue_timer }
    -re {\x1b\[\?u} { send -- "\x1b\[?0u"; exp_continue -continue_timer }
    -re {\x1b\[c} { send -- "\x1b\[?62;c"; exp_continue -continue_timer }
    -re $pattern { return 1 }
    timeout { return 0 }
    eof { return -1 }
  }
}
proc idle {seconds} {
  if {[pump $seconds {\x00\x00}] < 0} { fail "claude exited unexpectedly" }
}
proc count_text {files text} {
  set count 0
  foreach file $files {
    if {[catch {open $file r} channel]} { continue }
    fconfigure $channel -translation binary
    set data [read $channel]
    close $channel
    if {[string first $text $data] >= 0} { incr count }
  }
  return $count
}
proc hooks {key value count seconds} {
  global spool
  set pattern "\"$key\"\\s*:\\s*\"$value\""
  set deadline [expr {[clock seconds] + $seconds}]
  while {[count_matching [glob -nocomplain -types f -directory $spool *] $pattern] < $count} {
    if {[clock seconds] > $deadline} { fail "timed out waiting for $count hook records with $key $value" }
    idle 1
  }
}
proc file_shows {path text seconds} {
  global config
  set deadline [expr {[clock seconds] + $seconds}]
  while {[count_text [glob -nocomplain -types f -directory $config $path] $text] == 0} {
    if {[clock seconds] > $deadline} { fail "timed out waiting for $path to show $text" }
    idle 1
  }
}
proc type_prompt {text} {
  send -- $text
  idle 1
  send -- "\r"
}
proc press {name} {
  global named_keys
  send -- $named_keys($name)
  idle 1
}
proc quit {} {
  for {set attempt 0} {$attempt < 5} {incr attempt} {
    send -- "\x03"
    after 200
    send -- "\x03"
    if {[pump 3 {\x00\x00}] < 0} { return }
  }
  fail "claude did not exit after Ctrl-C"
}
spawn -noecho $claude {*}$claude_args
source $steps
quit
set status [wait]
exit [lindex $status 3]
`

export type TuiKey = 'enter' | 'escape' | 'right' | 'down'

export type TuiStep =
  | { readonly hook: string; readonly count?: number; readonly seconds?: number }
  | { readonly notification: string; readonly seconds?: number }
  | { readonly file: string; readonly shows: string; readonly seconds?: number }
  | { readonly prompt: string }
  | { readonly press: TuiKey }
  | { readonly idle: number }

export interface TuiRun {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly steps: readonly TuiStep[]
}

const literal = (text: string): string => {
  if (/[{}\\\r\n]/.test(text)) throw new Error(`TUI step text cannot contain braces, backslashes or line breaks: ${text}`)
  return `{${text}}`
}

const name = (text: string): string => {
  if (!/^[\w-]+$/.test(text)) throw new Error(`TUI hook names are words: ${text}`)
  return text
}

const defaultSeconds = 90

const tcl = (step: TuiStep): string => {
  if ('hook' in step) return `hooks hook_event_name ${name(step.hook)} ${String(step.count ?? 1)} ${String(step.seconds ?? defaultSeconds)}`
  if ('notification' in step) return `hooks notification_type ${name(step.notification)} 1 ${String(step.seconds ?? defaultSeconds)}`
  if ('file' in step) return `file_shows ${literal(step.file)} ${literal(step.shows)} ${String(step.seconds ?? defaultSeconds)}`
  if ('prompt' in step) return `type_prompt ${literal(step.prompt)}`
  if ('press' in step) return `press ${step.press}`
  return `idle ${String(step.idle)}`
}

const onboarded = async (session: ScenarioSession, apiKey: string): Promise<void> => {
  const path = join(session.claude, '.claude.json')
  const existing: unknown = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'))
  const current = typeof existing === 'object' && existing !== null ? existing as Readonly<Record<string, unknown>> : {}
  const projects = typeof current['projects'] === 'object' && current['projects'] !== null ? current['projects'] as Readonly<Record<string, unknown>> : {}
  await writeFile(path, `${JSON.stringify({
    ...current,
    hasCompletedOnboarding: true,
    theme: 'dark',
    lastOnboardingVersion: session.engine.version,
    customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] },
    projects: { ...projects, [session.project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1 } },
  }, null, 2)}\n`)
}

export const driveTui = async (session: ScenarioSession, label: string, apiKey: string, run: TuiRun): Promise<void> => {
  const expect = await resolveExpect()
  const script = join(session.work, 'claude-tui.exp')
  const steps = join(session.work, `claude-tui-${label}.tcl`)
  const screen = join(session.work, `claude-tui-${label}.log`)
  await onboarded(session, apiKey)
  await writeFile(script, driverScript)
  await writeFile(steps, `${run.steps.map(tcl).join('\n')}\n`)
  try {
    await session.run(expect, [
      script, session.engine.executable, join(session.spool, spoolLayout.readyDirectory), session.claude, steps, screen,
      '--permission-mode', 'default', ...run.args,
    ], {
      env: { CLAUDE_CODE_CHILD_SESSION: '', CLAUDECODE: '', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', ...run.env },
      timeoutMs: 300_000,
    })
  } catch (error) {
    const transcript = plainText(await readFile(screen, 'utf8').catch(() => '')).slice(-2_000)
    throw new Error(`Claude TUI driver failed (${error instanceof Error ? error.message : String(error)}); last screen text: ${transcript}`, { cause: error })
  }
}
