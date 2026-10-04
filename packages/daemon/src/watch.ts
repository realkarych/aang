import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { type Config, WatchState } from '@aang/contract'
import type { WatchedRoots } from '@aang/engine'
import type { Store, Transaction } from '@aang/store'
import { AdminError } from './admin-error.js'
import { epochNow } from './spool.js'

const watchSetting = 'watch'

export const loadWatch = (store: Store, config: Config): WatchState => {
  const stored = store.settings.get(watchSetting)
  return stored === undefined
    ? { all: config.watch.all, lookback_days: config.watch.lookbackDays, roots: config.watch.roots.map(({ path }) => path) }
    : WatchState.parse(stored)
}

export const saveWatch =
  (state: WatchState) =>
  (transaction: Transaction): void => {
    transaction.settings.save(watchSetting, state, epochNow())
  }

export const watchedRoots = (state: WatchState, config: Config): WatchedRoots => ({
  all: state.all,
  roots: state.roots.map((path) => ({
    path,
    contracts: config.watch.roots.find((root) => root.path === path)?.contracts ?? [],
  })),
})

const canonical = async (path: string): Promise<string> => {
  if (!isAbsolute(path)) {
    throw new AdminError('invalid_request', `${path} is not an absolute path`)
  }
  return realpath(resolve(path)).catch(() => resolve(path))
}

export const watchedDirectory = async (path: string): Promise<string> => {
  const directory = await canonical(path)
  const found = await stat(directory).catch(() => null)
  if (found?.isDirectory() !== true) {
    throw new AdminError('invalid_request', `${path} is not a directory`)
  }
  return directory
}

export const rootOf = async (state: WatchState, path: string): Promise<string> => {
  const resolved = resolve(path)
  const directory = await canonical(path)
  const root = state.roots.find((candidate) => candidate === resolved || candidate === directory)
  if (root === undefined) {
    throw new AdminError('not_found', `${path} is not a watched root`)
  }
  return root
}
