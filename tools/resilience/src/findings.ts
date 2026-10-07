export const findings = {
  heldFileWatch: 'Q4-1: macOS fs watch reports no appends through a held-open file, so the Codex rollout is read by the 60 s tree scan',
  registryRemovalGap: 'Q4-2: a removed session registry file leaves an unknown_records gap in /api/status (fix: PR #159)',
  codexLaunchTwice: 'Q4-3: a Codex launch is listed twice, from the SessionStart hook and from session_meta',
  hooksLostMidSession: 'Q4-4: hook events lost in the middle of a session are not marked, full support is sticky',
  deadProcess: 'Q4-5: a Claude session whose process was killed stays running; the registry liveness hint is unused',
  missingRoot: 'Q4-6: a runtime root created after the daemon start is found by the 60 s tree scan only',
  transientHooksInactive:
    'Q4-7: rollout lines taken before the first hook file of a Codex session open a hooks_inactive gap that closes a moment later',
} as const
