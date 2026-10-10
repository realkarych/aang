import { symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig, processEnvironment } from '@aang/contract/config-file'
import { aangHomePaths } from '@aang/contract/home'
import { createPlayer, installFakeClaude, installFakeCodex, loadManifest } from '@aang/testkit'

const usage = `usage: node dist/main.js <command>

  install-clis <directory> <bin>   install fake claude and codex into <directory> and link them from <bin>
  play <manifest>                  play a player manifest into the runtime roots and the spool aang uses
`

const installClis = async (directory: string, bin: string): Promise<void> => {
  for (const cli of [installFakeClaude(directory), installFakeCodex(directory)]) {
    await symlink(cli.command, join(bin, cli.runtime))
  }
}

const play = async (manifest: string): Promise<void> => {
  const environment = processEnvironment()
  const { aangHome, runtimeRoots } = await loadConfig(environment)
  const player = createPlayer(await loadManifest(resolve(manifest)), {
    roots: { home: environment.homedir, ...runtimeRoots },
    timeScale: 0,
    hook: { binary: 'aang-hook', spool: aangHomePaths(aangHome).spool },
  })
  try {
    await player.play()
  } finally {
    await player.close()
  }
}

const [command, first, second, ...extra] = parseArgs({ allowPositionals: true, strict: true }).positionals

if (command === 'install-clis' && first !== undefined && second !== undefined && extra.length === 0) {
  await installClis(resolve(first), resolve(second))
} else if (command === 'play' && first !== undefined && second === undefined) {
  await play(first)
} else {
  process.stderr.write(usage)
  process.exitCode = 2
}
