import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { inspectCodexPersistence } from '../dist/persistence.js'

test('ephemeral admission rejects session rows in either SQLite database even without rollout files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aang-persistence-'))
  try {
    expect(inspectCodexPersistence(home).clean).toBe(true)
    for (const [name, schema, insert] of [
      ['state_5.sqlite', 'CREATE TABLE threads(id TEXT)', "INSERT INTO threads VALUES ('probe')"],
      ['thread_history_1.sqlite', 'CREATE TABLE thread_turns(thread_id TEXT); CREATE TABLE thread_items(thread_id TEXT); CREATE TABLE thread_history_projection_state(thread_id TEXT)', "INSERT INTO thread_history_projection_state VALUES ('probe')"],
    ] as const) {
      const path = join(home, name)
      const database = new DatabaseSync(path)
      try {
        database.exec(schema)
        expect(inspectCodexPersistence(home).clean).toBe(true)
        database.exec(insert)
        const evidence = inspectCodexPersistence(home)
        expect(evidence.clean).toBe(false)
        expect(evidence.databases.find((entry) => entry.path === path)?.rows).toEqual(expect.objectContaining(
          name === 'state_5.sqlite' ? { threads: 1 } : { thread_history_projection_state: 1 },
        ))
      } finally {
        database.close()
      }
      await rm(path)
    }
    await writeFile(join(home, 'state_5.sqlite'), 'unreadable database')
    expect(inspectCodexPersistence(home).clean).toBe(false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
