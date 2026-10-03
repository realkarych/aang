import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { lookup } from 'node:dns/promises'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { arch, homedir, hostname, release, tmpdir, userInfo } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as pause } from 'node:timers/promises'
import { parseArgs, promisify } from 'node:util'
import { codexHooksState } from '../../../../packages/hook/dist/index.js'

const run = promisify(execFile)
const { values } = parseArgs({
  options: {
    codex: { type: 'string', default: 'codex' },
    'codex-home': { type: 'string' },
    control: { type: 'string', default: '30' },
    'before-initialize': { type: 'string', default: '5' },
    'after-initialize': { type: 'string', default: '5' },
    'after-list': { type: 'string', default: '20' },
    runs: { type: 'string', default: '3' },
  },
})
const milliseconds = (name) => {
  const value = Number(values[name])
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number of seconds`)
  return value * 1000
}
const productRuns = Number(values.runs)
if (!Number.isInteger(productRuns) || productRuns < 1) throw new Error('--runs must be a positive integer')

const home = homedir()
const codexHome = await realpath(values['codex-home'] ?? join(home, '.codex'))
const temporary = await realpath(tmpdir())
const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-d6-')))
const project = join(root, 'project')
await mkdir(project)
await writeFile(join(project, 'README.md'), '# aang D.6 test project\n')
process.chdir(project)
const clientInfo = { name: 'aang', title: 'aang hook installation', version: '0.0.0' }
const knownHosts = ['chatgpt.com', 'ab.chatgpt.com', 'api.openai.com', 'github.com', 'api.github.com', 'codeload.github.com']
const hostsByAddress = new Map()
for (const host of knownHosts) {
  try {
    for (const { address } of await lookup(host, { all: true })) hostsByAddress.set(address, [...(hostsByAddress.get(address) ?? []), host])
  } catch {
    continue
  }
}
const started = Date.now()
const relativeTime = (at) => at - started

const redact = (text) => [[root, '<work>'], [codexHome, '<codex>'], [temporary, '<tmp>'], [tmpdir(), '<tmp>'], [home, '~'], [hostname(), '<host>']]
  .reduce((current, [path, label]) => current.replaceAll(path, label), text)

const pluginNames = new Map()
const anonymizePlugins = (text) => text.replace(/(plugins\/cache\/[^/"]+\/)([^/"]+)/g, (_match, prefix, name) => {
  if (!pluginNames.has(name)) pluginNames.set(name, `<plugin ${String(pluginNames.size + 1)}>`)
  return `${prefix}${pluginNames.get(name)}`
})

const placeholders = new Map()
const placeholder = (kind, value) => {
  const key = `${kind} ${value}`
  if (!placeholders.has(key)) placeholders.set(key, `${kind}_${String([...placeholders.keys()].filter((known) => known.startsWith(`${kind} `)).length + 1)}`)
  return placeholders.get(key)
}
const digestKeys = 'config\\.toml|hooks\\.json|AGENTS\\.md|version\\.json|models_cache\\.json|\\.codex-global-state\\.json|history\\.jsonl|session_index\\.jsonl|digest'
const anonymizeIdentifiers = (text) => text
  .replace(/("installation_id": )"([0-9a-f]{16})"/g, (_match, prefix, value) => `${prefix}"${placeholder('INSTALLATION_ID', value)}"`)
  .replace(/sha256:[0-9a-f]{64}/g, (value) => placeholder('TRUSTED_HASH', value))
  .replace(/(remote_plugin_catalog\/)([0-9a-f]{16})/g, (_match, prefix, value) => `${prefix}${placeholder('CATALOG_KEY', value)}`)
  .replace(new RegExp(`("(?:${digestKeys})": )"([0-9a-f]{16})"`, 'g'), (_match, prefix, value) => `${prefix}"${placeholder('DIGEST', value)}"`)

const isMissing = (error) => error?.code === 'ENOENT'

const walk = async (directory, files) => {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    let info
    try {
      info = await lstat(path, { bigint: true })
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    const kind = info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'link' : info.isSocket() ? 'socket' : 'file'
    files.set(relative(codexHome, path).split(sep).join('/'), {
      kind,
      size: Number(info.size),
      mtime: info.mtimeNs.toString(),
      ctime: info.ctimeNs.toString(),
      ino: info.ino.toString(),
    })
    if (entry.isDirectory()) await walk(path, files)
  }
}

const keyFiles = ['auth.json', 'config.toml', 'hooks.json', 'AGENTS.md', 'installation_id', 'version.json', 'models_cache.json', '.codex-global-state.json', 'history.jsonl', 'session_index.jsonl']
const digestNames = keyFiles.filter((name) => name !== 'auth.json')
const digest = async (name) => {
  try {
    return createHash('sha256').update(await readFile(join(codexHome, name))).digest('hex')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

const tomlTables = (text, prefix) => {
  const tables = []
  let current
  for (const line of text.split('\n')) {
    const header = line.match(/^\s*\[(.+)\]\s*$/)
    if (header !== null) {
      current = header[1].startsWith(prefix) ? { key: header[1].slice(prefix.length), body: [] } : undefined
      if (current !== undefined) tables.push(current)
    } else if (current !== undefined && line.trim() !== '') {
      current.body.push(line.trim())
    }
  }
  return tables
}

const readOptional = async (name, fallback) => {
  try {
    return await readFile(join(codexHome, name), 'utf8')
  } catch (error) {
    if (isMissing(error)) return fallback
    throw error
  }
}

const configState = async () => {
  const text = await readOptional('config.toml', '')
  const hooks = JSON.parse(await readOptional('hooks.json', '{}'))
  const projects = tomlTables(text, 'projects.')
  return {
    hooksState: tomlTables(text, 'hooks.state.').map(({ key, body }) => ({ key: redact(JSON.parse(key)), body })),
    projects: { count: projects.length, digest: createHash('sha256').update(JSON.stringify(projects)).digest('hex').slice(0, 16) },
    hooksJson: Object.fromEntries(Object.entries(hooks.hooks ?? {}).map(([event, groups]) => [event, groups.map((group) => group.hooks?.length ?? 0)])),
  }
}

const databaseNames = async () => {
  const top = (await readdir(codexHome)).filter((name) => name.endsWith('.sqlite'))
  let nested = []
  try {
    nested = (await readdir(join(codexHome, 'sqlite'))).filter((name) => name.endsWith('.db')).map((name) => `sqlite/${name}`)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  return [...top, ...nested].sort()
}

const withDatabase = async (name, read) => {
  for (let attempt = 1; ; attempt += 1) {
    let database
    try {
      database = new DatabaseSync(join(codexHome, name), { readOnly: true, timeout: 2000 })
      return read(database)
    } catch (error) {
      if (attempt >= 5) return { error: String(error?.message ?? error) }
      await pause(200)
    } finally {
      database?.close()
    }
  }
}

const isOwnPath = (path) => path.startsWith('<work>') || path === '<codex>'

const readDatabase = (name) => withDatabase(name, (database) => {
  const tables = database.prepare("select name from sqlite_master where type = 'table' order by name").all().map((row) => row.name)
  const result = {
    tables: Object.fromEntries(tables.map((table) => [table, database.prepare(`select count(*) as count from "${table}"`).get().count])),
  }
  if (tables.includes('logs')) {
    Object.assign(result, database.prepare('select min(id) as minId, max(id) as maxId from logs').get())
  }
  if (name === 'state_5.sqlite' && tables.includes('threads')) {
    result.threads = Object.fromEntries(database.prepare('select id, updated_at_ms, source, originator, thread_source, cwd, archived from threads').all()
      .map((row) => {
        const cwd = redact(row.cwd)
        const own = row.originator === clientInfo.name || isOwnPath(cwd)
        return [row.id, { updatedAtMs: row.updated_at_ms, source: row.source, originator: row.originator, threadSource: row.thread_source, archived: row.archived, own, cwd: own ? cwd : undefined }]
      }))
  }
  return result
})

const parseTable = (stdout, columns) => stdout.split('\n').flatMap((line) => {
  const match = line.trim().match(new RegExp(`^${'(\\d+)\\s+'.repeat(columns)}(.*)$`))
  return match === null ? [] : [match.slice(1)]
})

const processTable = async () => {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,pgid=,args='], { maxBuffer: 64 * 1024 * 1024 })
  return parseTable(stdout, 3).map(([pid, ppid, pgid, command]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), command }))
}

const classify = (executable, command) => {
  const name = basename(executable)
  if (name === 'codex') {
    if (/ app-server( |$)/.test(command)) {
      if (/ daemon( |$)/.test(command)) return 'app-server daemon'
      return /--analytics-default-enabled/.test(command) ? 'desktop app-server' : 'app-server'
    }
    if (/ exec-server( |$)/.test(command)) return 'exec-server'
    if (/ exec( |$)/.test(command)) return 'exec'
    return 'tui'
  }
  if (name === 'codex-code-mode-host') return 'code-mode host'
  if (name === 'SkyComputerUseService') return 'computer-use service'
  return undefined
}

const codexProcesses = async () => {
  const executables = new Map(parseTable((await run('ps', ['-axo', 'pid=,comm='], { maxBuffer: 64 * 1024 * 1024 })).stdout, 1)
    .map(([pid, executable]) => [Number(pid), executable]))
  return (await processTable()).flatMap(({ pid, ppid, command }) => {
    const executable = executables.get(pid) ?? ''
    const kind = classify(executable, command)
    return kind === undefined ? [] : [{ pid, ppid, kind, executable: redact(executable) }]
  })
}

const daemonDirectory = join('/tmp', `codex-daemon-${String(userInfo().uid)}`)
const listOrNull = async (path) => {
  try {
    return (await readdir(path)).sort()
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

const snapshot = async (label) => {
  const at = Date.now()
  const files = new Map()
  await walk(codexHome, files)
  const digests = Object.fromEntries(await Promise.all(digestNames.map(async (name) => [name, await digest(name)])))
  const databases = {}
  for (const name of await databaseNames()) databases[name] = await readDatabase(name)
  return {
    label,
    at,
    files,
    digests,
    config: await configState(),
    databases,
    processes: await codexProcesses(),
    daemonSockets: await listOrNull(daemonDirectory),
    controlSocket: await listOrNull(join(codexHome, 'app-server-control')),
  }
}

const sameFile = (left, right) => left.kind === right.kind && left.size === right.size && left.mtime === right.mtime && left.ino === right.ino

const countOnlyGroups = ['sessions', 'archived_sessions', 'shell_snapshots']
const summarize = (paths) => {
  const groups = new Map()
  for (const path of paths) {
    const key = path.split('/').slice(0, 2).join('/')
    groups.set(key, [...(groups.get(key) ?? []), path])
  }
  return [...groups.entries()].map(([group, members]) => {
    if (countOnlyGroups.includes(group.split('/')[0])) return { group: group.split('/')[0], count: members.length }
    return members.length <= 40 ? { group, count: members.length, paths: members } : { group, count: members.length, examples: members.slice(0, 5) }
  })
}

const diffFiles = (before, after) => {
  const added = [...after.files.keys()].filter((path) => !before.files.has(path)).sort()
  const removed = [...before.files.keys()].filter((path) => !after.files.has(path)).sort()
  const changed = [...after.files.entries()]
    .filter(([path, info]) => before.files.has(path) && !sameFile(before.files.get(path), info))
    .map(([path]) => path)
    .sort()
  return { added: summarize(added), removed: summarize(removed), changed: summarize(changed) }
}

const keyFileStatus = (before, after) => Object.fromEntries(keyFiles.map((name) => {
  const left = before.files.get(name)
  const right = after.files.get(name)
  if (left === undefined && right === undefined) return [name, 'absent']
  if (left === undefined) return [name, 'added']
  if (right === undefined) return [name, 'removed']
  const contentChanged = name !== 'auth.json' && before.digests[name] !== after.digests[name]
  if (contentChanged) return [name, 'content changed']
  return [name, sameFile(left, right) && left.ctime === right.ctime ? 'unchanged' : 'touched']
}))

const sameRow = (left, right) => JSON.stringify(left) === JSON.stringify(right)

const diffDatabases = (before, after) => Object.fromEntries(Object.keys({ ...before.databases, ...after.databases }).map((name) => {
  const left = before.databases[name] ?? { tables: {} }
  const right = after.databases[name] ?? { tables: {} }
  const tables = Object.fromEntries(Object.keys({ ...left.tables, ...right.tables })
    .map((table) => [table, (right.tables?.[table] ?? 0) - (left.tables?.[table] ?? 0)])
    .filter(([, delta]) => delta !== 0))
  const entry = { tables }
  if (left.threads !== undefined && right.threads !== undefined) {
    entry.threadsCreated = Object.entries(right.threads).filter(([id]) => left.threads[id] === undefined).map(([id, row]) => ({ id, ...row }))
    entry.threadsUpdated = Object.keys(right.threads).filter((id) => left.threads[id] !== undefined && !sameRow(left.threads[id], right.threads[id])).length
  }
  if (left.maxId !== undefined && right.maxId !== undefined) {
    entry.logIds = { from: left.maxId, to: right.maxId, minIdBefore: left.minId, minIdAfter: right.minId }
  }
  return [name, entry]
}).filter(([, entry]) => Object.keys(entry.tables).length > 0 || (entry.threadsCreated?.length ?? 0) > 0 || (entry.threadsUpdated ?? 0) > 0 || entry.logIds !== undefined))

const logWriters = async (from, to, ownPids, kinds) => withDatabase('logs_2.sqlite', (database) => database
  .prepare('select process_uuid, count(*) as rows, sum(estimated_bytes) as bytes from logs where id > ? and id <= ? group by process_uuid order by rows desc')
  .all(from, to)
  .map((row) => {
    const pid = Number(String(row.process_uuid ?? '').split(':')[1])
    return { pid: Number.isFinite(pid) ? pid : null, kind: ownPids.has(pid) ? 'own' : kinds.get(pid) ?? 'unknown', rows: row.rows, bytes: row.bytes }
  }))

const interval = async (label, before, after, ownPids) => {
  const databases = diffDatabases(before, after)
  const logs = databases['logs_2.sqlite']?.logIds
  return {
    label,
    from: relativeTime(before.at),
    to: relativeTime(after.at),
    keyFiles: keyFileStatus(before, after),
    configChanged: !sameRow(before.config, after.config),
    files: diffFiles(before, after),
    databases,
    logWriters: logs === undefined || logs.from === null ? [] : await logWriters(logs.from, logs.to, ownPids, new Map([...before.processes, ...after.processes].map(({ pid, kind }) => [pid, kind]))),
  }
}

const isOwnRoot = (row) => row.ppid === process.pid && / app-server( |$)/.test(row.command)

const descendantsOf = (table, roots) => {
  const found = new Map()
  const queue = table.filter((row) => roots.has(row.pid))
  while (queue.length > 0) {
    const row = queue.shift()
    if (found.has(row.pid)) continue
    found.set(row.pid, row)
    queue.push(...table.filter((child) => !found.has(child.pid) && (child.ppid === row.pid || roots.has(child.pgid))))
  }
  return found
}

const parseLsof = (stdout) => {
  const entries = []
  let pid
  let current
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const field = line[0]
    const value = line.slice(1)
    if (field === 'p') pid = Number(value)
    else if (field === 'f') {
      current = { pid, fd: value }
      entries.push(current)
    } else if (current !== undefined && field === 't') current.type = value
    else if (current !== undefined && field === 'n') current.name = value
  }
  return entries
}

const startMonitor = (rootPids, { psIntervalMs, lsofEvery }) => {
  const processes = new Map()
  const openFiles = new Map()
  const sockets = new Map()
  const unixSockets = new Set()
  let running = true
  const sampleProcesses = async () => {
    const table = await processTable()
    for (const row of table.filter(isOwnRoot)) rootPids.add(row.pid)
    const now = relativeTime(Date.now())
    for (const [pid, row] of descendantsOf(table, rootPids)) {
      const known = processes.get(pid)
      if (known === undefined) processes.set(pid, { pid, ppid: row.ppid, pgid: row.pgid, command: redact(row.command), raw: row.command, firstSeen: now, lastSeen: now })
      else known.lastSeen = now
    }
  }
  const sampleFiles = async () => {
    const pids = [...processes.values()].map(({ pid }) => pid)
    if (pids.length === 0) return
    let stdout = ''
    try {
      stdout = (await run('lsof', ['-n', '-P', '-w', '-p', pids.join(','), '-F', 'pftn'], { maxBuffer: 64 * 1024 * 1024 })).stdout
    } catch (error) {
      stdout = error.stdout ?? ''
    }
    const now = relativeTime(Date.now())
    for (const entry of parseLsof(stdout)) {
      const name = entry.name ?? ''
      if (entry.type === 'IPv4' || entry.type === 'IPv6') {
        const remote = name.includes('->') ? name.split('->')[1] : name
        const address = remote.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
        if (!sockets.has(remote)) sockets.set(remote, { type: entry.type, remote, resolvesFrom: hostsByAddress.get(address) ?? [], firstSeen: now })
      } else if (entry.type === 'unix') {
        unixSockets.add(`${String(entry.pid)} ${entry.fd}`)
      } else if (name.startsWith(codexHome)) {
        const path = relative(codexHome, name).split(sep).join('/')
        if (!openFiles.has(path)) openFiles.set(path, { path, type: entry.type, firstSeen: now })
      }
    }
  }
  const loop = (async () => {
    for (let tick = 0; running; tick += 1) {
      await sampleProcesses()
      if (tick % lsofEvery === 0) await sampleFiles()
      await pause(psIntervalMs)
    }
  })()
  return {
    sampleFiles,
    stop: async () => {
      running = false
      await loop
      await sampleProcesses()
    },
    processes,
    report: () => ({
      processes: [...processes.values()].map(({ raw, ...rest }) => rest),
      openFiles: [...openFiles.values()],
      sockets: [...sockets.values()],
      unixSockets: unixSockets.size,
    }),
  }
}

const reapLeftovers = async (monitor) => {
  await pause(1000)
  const table = new Map((await processTable()).map((row) => [row.pid, row]))
  const leftovers = [...monitor.processes.values()]
    .filter(({ pid, raw }) => table.get(pid)?.command === raw && !/<defunct>|^\(.*\)$/.test(raw))
    .map(({ pid, command }) => ({ pid, command }))
  for (const { pid } of leftovers) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      continue
    }
  }
  return leftovers
}

const describeHooks = (hooks) => hooks.map((hook) => ({
  key: redact(hook.key),
  eventName: hook.eventName,
  handlerType: hook.handlerType,
  source: hook.source,
  sourcePath: redact(hook.sourcePath),
  enabled: hook.enabled,
  trustStatus: hook.trustStatus,
}))

const session = async ({ beforeInitialize, afterInitialize, afterList, lists }) => {
  const phases = []
  const mark = (phase) => phases.push({ phase, at: relativeTime(Date.now()) })
  const messages = []
  const child = spawn(values.codex, ['app-server'], {
    cwd: project,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: 'pipe',
    detached: true,
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  mark('spawned')
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, at: relativeTime(Date.now()) })))
  let running = true
  void exited.then(() => {
    running = false
  })
  const monitor = startMonitor(new Set([child.pid]), { psIntervalMs: 100, lsofEvery: 3 })
  try {
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-16384)
    })
    const pending = new Map()
    let buffer = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line === '') continue
        const message = JSON.parse(line)
        const at = relativeTime(Date.now())
        if (message.method !== undefined) {
          messages.push({ at, method: message.method, request: message.id !== undefined, paramKeys: Object.keys(message.params ?? {}).sort() })
        } else if (pending.has(message.id)) {
          pending.get(message.id)(message)
          pending.delete(message.id)
        }
      }
    })
    let nextId = 0
    const request = async (method, params) => {
      nextId += 1
      const id = nextId
      const answer = new Promise((resolve) => pending.set(id, resolve))
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      const message = await Promise.race([answer, exited.then(() => null), pause(30_000).then(() => null)])
      if (message === null) throw new Error(`${method} got no response: ${redact(stderr)}`)
      if (message.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(message.error)}`)
      return message.result
    }
    await pause(beforeInitialize)
    await monitor.sampleFiles()
    mark('initialize sent')
    const initialize = await request('initialize', { clientInfo, capabilities: { experimentalApi: true, requestAttestation: false } })
    mark('initialize answered')
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
    await pause(afterInitialize)
    await monitor.sampleFiles()
    const listings = []
    for (const params of lists) {
      mark(`hooks/list ${JSON.stringify(params)} sent`)
      const listing = await request('hooks/list', params)
      mark(`hooks/list ${JSON.stringify(params)} answered`)
      listings.push({
        params,
        data: (listing?.data ?? []).map((entry) => ({ cwd: redact(entry.cwd), hooks: describeHooks(entry.hooks ?? []), warnings: (entry.warnings ?? []).map(redact), errors: entry.errors ?? [] })),
      })
    }
    await pause(afterList)
    await monitor.sampleFiles()
    mark('stdin closed')
    child.stdin.end()
    let exit = await Promise.race([exited, pause(10_000).then(() => null)])
    const graceful = exit !== null
    if (!graceful) {
      process.kill(-child.pid, 'SIGKILL')
      exit = await exited
    }
    mark('exited')
    await monitor.stop()
    return {
      cwd: '<work>/project',
      pid: child.pid,
      phases,
      initialize: {
        userAgent: redact(String(initialize?.userAgent ?? '')),
        codexHome: redact(String(initialize?.codexHome ?? '')),
        platformFamily: initialize?.platformFamily,
        platformOs: initialize?.platformOs,
        keys: Object.keys(initialize ?? {}).sort(),
      },
      listings,
      messages,
      termination: { graceful, ...exit },
      leftovers: await reapLeftovers(monitor),
      stderrTail: redact(stderr).split('\n').filter((line) => line !== '').slice(-20),
      ...monitor.report(),
    }
  } finally {
    if (running) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        void 0
      }
    }
    await monitor.stop()
  }
}

const productRun = async (index) => {
  const rootPids = new Set()
  const onChild = ({ process: child }) => {
    child.once('spawn', () => {
      if (child.spawnargs.includes('app-server')) rootPids.add(child.pid)
    })
  }
  subscribe('child_process', onChild)
  const monitor = startMonitor(rootPids, { psIntervalMs: 20, lsofEvery: 2 })
  const begin = Date.now()
  let outcome
  try {
    const state = await codexHooksState({ codexHome, codex: { command: values.codex } })
    outcome = { status: state.status, aangHooks: describeHooks(state.hooks), warnings: state.warnings.map(redact) }
  } catch (error) {
    outcome = { error: redact(String(error?.message ?? error)) }
  } finally {
    unsubscribe('child_process', onChild)
  }
  const durationMs = Date.now() - begin
  await monitor.stop()
  return {
    index,
    at: relativeTime(begin),
    durationMs,
    pids: [...rootPids],
    outcome,
    leftovers: await reapLeftovers(monitor),
    ...monitor.report(),
  }
}

const phaseOf = (phases, at) => phases.filter((entry) => entry.at <= at).at(-1)?.phase ?? 'before spawn'

const ownLogs = async (pids, phases, fromId) => withDatabase('logs_2.sqlite', (database) => Object.fromEntries(pids.map((pid) => {
  const rows = database.prepare('select ts * 1000 + ts_nanos / 1000000 as at, level, target, estimated_bytes as bytes, thread_id is not null as withThread from logs where id > ? and process_uuid like ? order by id')
    .all(fromId ?? 0, `pid:${String(pid)}:%`)
  const byTarget = {}
  const byPhase = {}
  for (const row of rows) {
    const key = `${row.level} ${row.target}`
    byTarget[key] = (byTarget[key] ?? 0) + 1
    const phase = phases.get(pid) === undefined ? 'product run' : phaseOf(phases.get(pid), row.at - started)
    byPhase[phase] = (byPhase[phase] ?? 0) + 1
  }
  return [pid, {
    rows: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    withThread: rows.filter((row) => row.withThread).length,
    first: rows.length === 0 ? null : Math.round(rows[0].at - started),
    last: rows.length === 0 ? null : Math.round(rows.at(-1).at - started),
    byPhase,
    byTarget: Object.entries(byTarget).sort((left, right) => right[1] - left[1]).map(([key, count]) => ({ key, count })),
  }]
}).filter(([, entry]) => entry.rows > 0)))

const version = async () => {
  const versionHome = join(root, 'version-home')
  await mkdir(versionHome)
  return (await run(values.codex, ['--version'], { env: { ...process.env, CODEX_HOME: versionHome }, cwd: project })).stdout.trim()
}

const serializeSnapshot = (snapshot) => ({
  label: snapshot.label,
  at: relativeTime(snapshot.at),
  entries: snapshot.files.size,
  digests: Object.fromEntries(Object.entries(snapshot.digests).map(([name, value]) => [name, value === null ? null : value.slice(0, 16)])),
  config: snapshot.config,
  databases: Object.fromEntries(Object.entries(snapshot.databases).map(([name, value]) => [name, { ...value, threads: value.threads === undefined ? undefined : Object.keys(value.threads).length }])),
  processes: snapshot.processes,
  daemonSockets: snapshot.daemonSockets?.length ?? null,
  controlSocket: snapshot.controlSocket,
})

const codexVersion = await version()
const control = milliseconds('control')
const s0 = await snapshot('start')
await pause(control)
const s1 = await snapshot('after control window')
const instrumented = await session({
  beforeInitialize: milliseconds('before-initialize'),
  afterInitialize: milliseconds('after-initialize'),
  afterList: milliseconds('after-list'),
  lists: [{}, { cwds: [codexHome] }],
})
const s2 = await snapshot('after instrumented run')
const product = []
for (let index = 1; index <= productRuns; index += 1) {
  product.push(await productRun(index))
  await pause(2000)
}
const s3 = await snapshot('after product runs')
await pause(control)
const s4 = await snapshot('after final control window')
const verification = await session({ beforeInitialize: 0, afterInitialize: 0, afterList: 0, lists: [{}] })
const s5 = await snapshot('after trust verification')
const sessionPids = (entry) => [entry.pid, ...entry.processes.map(({ pid }) => pid)]
const ownPids = new Set([...sessionPids(instrumented), ...sessionPids(verification), ...product.flatMap((entry) => [...entry.pids, ...entry.processes.map(({ pid }) => pid)])])
const phases = new Map([[instrumented.pid, instrumented.phases], [verification.pid, verification.phases]])
const result = {
  environment: {
    date: new Date(started).toISOString(),
    platform: `${process.platform} ${release()} ${arch()}`,
    node: process.version,
    codex: codexVersion,
    codexCommand: redact(values.codex),
    codexHome: values['codex-home'] === undefined ? '~/.codex' : 'disposable',
    settings: { controlMs: control, beforeInitializeMs: milliseconds('before-initialize'), afterInitializeMs: milliseconds('after-initialize'), afterListMs: milliseconds('after-list'), productRuns },
  },
  snapshots: [s0, s1, s2, s3, s4, s5].map(serializeSnapshot),
  intervals: [
    await interval('control before', s0, s1, ownPids),
    await interval('instrumented run', s1, s2, ownPids),
    await interval('product runs', s2, s3, ownPids),
    await interval('control after', s3, s4, ownPids),
    await interval('trust verification', s4, s5, ownPids),
  ],
  instrumented,
  product,
  verification,
  ownLogs: await ownLogs([...ownPids], phases, s0.databases['logs_2.sqlite']?.maxId),
}
process.stdout.write(`${anonymizeIdentifiers(anonymizePlugins(redact(JSON.stringify(result, null, 2))))}\n`)
await rm(root, { recursive: true, force: true })
