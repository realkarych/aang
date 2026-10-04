import { pathToFileURL } from 'node:url'
import { createConversation, hostArguments, type PermissionResponse } from './conversation.js'
import { forwardedSettings, pluginDirectory, type SettingSource } from './plan.js'

interface SdkUserMessage {
  readonly type: 'user'
  readonly message: { readonly role: 'user'; readonly content: string }
  readonly parent_tool_use_id: null
  readonly session_id: string
}

interface SdkOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly plugins: readonly { readonly type: 'local'; readonly path: string }[]
  readonly permissionMode: 'default' | 'plan'
  readonly settingSources?: readonly SettingSource[]
  readonly strictMcpConfig?: boolean
  readonly resume?: string
  readonly forkSession?: boolean
  readonly stderr: (data: string) => void
  readonly canUseTool: (tool: string, input: Record<string, unknown>, options: { readonly toolUseID?: string }) => Promise<PermissionResponse>
}

interface SdkQuery extends AsyncIterable<unknown> {
  readonly interrupt: () => Promise<unknown>
}

interface SdkModule {
  readonly query: (params: { readonly prompt: AsyncIterable<SdkUserMessage>; readonly options: SdkOptions }) => SdkQuery
}

const isSdk = (value: unknown): value is SdkModule =>
  typeof value === 'object' && value !== null && 'query' in value && typeof value.query === 'function'

const { plan, summary, forwarded } = await hostArguments('Usage: sdk-host <plan.json> <summary.json> --plugin-dir <directory>')

const inbox = (): { readonly push: (message: SdkUserMessage) => void; readonly close: () => void; readonly messages: AsyncIterable<SdkUserMessage> } => {
  const queued: SdkUserMessage[] = []
  const state: { closed: boolean; wake?: () => void } = { closed: false }
  return {
    push: (message) => {
      queued.push(message)
      state.wake?.()
    },
    close: () => {
      state.closed = true
      state.wake?.()
    },
    messages: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queued.shift()
          if (next !== undefined) {
            yield next
            continue
          }
          if (state.closed) return
          await new Promise<void>((resolve) => {
            state.wake = resolve
          })
          delete state.wake
        }
      },
    },
  }
}

const prompts = inbox()
const lifecycle = { closing: false }
const handle: { query?: SdkQuery } = {}
const conversation = createConversation(plan, summary, async () => {
  await handle.query?.interrupt()
})

const start = async (): Promise<{ readonly streamed: Promise<void> }> => {
  const sdk: unknown = await import(pathToFileURL(plan.engine).href)
  if (!isSdk(sdk)) throw new Error(`${plan.engine} does not export query()`)
  const { settingSources, strictMcpConfig } = forwardedSettings(forwarded)
  const query = sdk.query({
    prompt: prompts.messages,
    options: {
      cwd: process.cwd(),
      env: { ...process.env, ...plan.env },
      plugins: [{ type: 'local', path: pluginDirectory(forwarded) }],
      permissionMode: plan.permissionMode,
      ...settingSources === undefined ? {} : { settingSources },
      ...strictMcpConfig ? { strictMcpConfig: true } : {},
      ...plan.resume === undefined ? {} : { resume: plan.resume },
      ...plan.fork ? { forkSession: true } : {},
      stderr: (data) => {
        process.stderr.write(data)
      },
      canUseTool: (tool, input, { toolUseID }) => conversation.permission(tool, toolUseID ?? null, input),
    },
  })
  handle.query = query
  const streamed = (async () => {
    try {
      for await (const message of query) {
        process.stdout.write(`${JSON.stringify(message)}\n`)
        conversation.observe(message)
      }
    } catch (error) {
      if (!lifecycle.closing || !conversation.endedByInterrupt()) throw error
    }
    if (!lifecycle.closing) throw new Error('The SDK stream ended before the conversation finished')
  })()
  streamed.catch(conversation.fail)
  return { streamed }
}

try {
  const { streamed } = await start()
  await conversation.converse((prompt) => {
    prompts.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' })
  })
  lifecycle.closing = true
  prompts.close()
  await Promise.race([streamed, conversation.failed])
  await conversation.finish(0)
} catch (error) {
  conversation.fail(error)
  prompts.close()
  process.stderr.write(`${conversation.summary.error ?? 'Host failed'}\n`)
  await conversation.finish(1)
  process.exit(1)
}
