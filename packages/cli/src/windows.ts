export const onWindows = process.platform === 'win32'

export const codexHooksOffByDefault =
  'hooks are not installed by default on Windows: Codex sessions are observed from their files only, so approval waits are not visible'

export const codexHookSlowdown =
  'on Windows Codex starts PowerShell for every hook event, which slows each event by 0.25–0.4 s'
