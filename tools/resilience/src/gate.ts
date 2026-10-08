import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Cli } from './clis.js'
import { windows } from './processes.js'

export const gateExitCode = 64

const allowedCommands: Readonly<Record<Cli['name'], readonly string[]>> = {
  claude: ['plugin', '--version'],
  codex: ['app-server', '--version'],
}

const posixQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const posixGate = (cli: Cli): string =>
  [
    '#!/bin/sh',
    `case "$1" in ${allowedCommands[cli.name].map(posixQuote).join('|')}) exec ${posixQuote(cli.command)} "$@" ;; esac`,
    `echo "aang resilience: ${cli.name} $1 is not allowed for the daemon" >&2`,
    `exit ${String(gateExitCode)}`,
    '',
  ].join('\n')

const nodeGate = [
  "import { spawnSync } from 'node:child_process'",
  'const [real, allowed, ...args] = process.argv.slice(2)',
  "if (!allowed.split(',').includes(args[0] ?? '')) {",
  '  process.stderr.write(`aang resilience: ${args[0] ?? ""} is not allowed for the daemon\\n`)',
  `  process.exit(${String(gateExitCode)})`,
  '}',
  "const result = spawnSync(real, args, { stdio: 'inherit', windowsHide: true })",
  'process.exit(result.status ?? 1)',
  '',
].join('\n')

const execShim = (): string =>
  join(dirname(dirname(fileURLToPath(import.meta.resolve('@aang/testkit')))), 'bin', 'exec-shim.exe')

export const writeGate = async (directory: string, cli: Cli): Promise<string> => {
  await mkdir(directory, { recursive: true })
  if (!windows) {
    const path = join(directory, cli.name)
    await writeFile(path, posixGate(cli))
    await chmod(path, 0o755)
    return path
  }
  const script = join(directory, `${cli.name}-gate.mjs`)
  await writeFile(script, nodeGate)
  const path = join(directory, `${cli.name}.exe`)
  await copyFile(execShim(), path)
  await writeFile(
    join(directory, `${cli.name}.json`),
    JSON.stringify({ command: process.execPath, args: [script, cli.command, allowedCommands[cli.name].join(',')] }),
  )
  return path
}
