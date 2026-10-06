import type { ActionKind, JsonValue } from '@aang/contract'
import { z } from 'zod'
import { actionEnded, actionStarted, type CallTiming, joinText, type LineContext, type LineFacts } from './facts.js'
import { BoundedJson, readJson } from './json.js'
import { planTool, planUpdated } from './plan.js'

const id = z.string().min(1)
const defaultNamespace = 'functions'
export const mcpNamespacePrefix = 'mcp__'
export const agentNamespaces: readonly string[] = ['collaboration', 'multi_agent_v1']

const toolKinds: ReadonlyMap<string, ActionKind> = new Map([
  ['exec_command', 'command'],
  ['write_stdin', 'command'],
  ['apply_patch', 'file_write'],
  ['request_user_input', 'question'],
  ['request_user_input_async', 'question'],
  [planTool, 'plan'],
])

const codeCellTool = 'exec'

const Passthrough = z.looseObject({ turn_id: id.optional() })

const Call = z.looseObject({
  call_id: id,
  name: id,
  internal_chat_message_metadata_passthrough: Passthrough.nullish(),
})

const FunctionCall = Call.extend({
  namespace: z.string().nullish(),
  arguments: z.string(),
})

const CustomToolCall = Call.extend({ input: z.string() })

const ToolOutput = z.looseObject({
  call_id: id,
  output: z.union([z.string(), z.array(z.looseObject({ text: z.string().optional() }))]),
  internal_chat_message_metadata_passthrough: Passthrough.nullish(),
})

const timing = (
  context: LineContext,
  passthrough: z.infer<typeof Passthrough> | null | undefined,
): CallTiming => ({
  at: context.line.at,
  turn: passthrough?.turn_id ?? null,
  verified: true,
})

const explicitNamespace = (namespace: string | null | undefined): string | null =>
  namespace === null || namespace === undefined || namespace === '' || namespace === defaultNamespace
    ? null
    : namespace

export const qualifiedTool = (namespace: string | null | undefined, name: string): string => {
  const explicit = explicitNamespace(namespace)
  return explicit === null ? name : `${explicit}/${name}`
}

const actionKind = (namespace: string | null, name: string): ActionKind => {
  if (namespace?.startsWith(mcpNamespacePrefix) === true) {
    return 'mcp'
  }
  if (namespace !== null && agentNamespaces.includes(namespace)) {
    return 'agent'
  }
  return toolKinds.get(name) ?? 'other'
}

const parsedArguments = (raw: string): JsonValue => BoundedJson.safeParse(readJson(raw)).data ?? raw

export const functionCall = (context: LineContext): LineFacts => {
  const parsed = FunctionCall.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const call = parsed.data
  const namespace = explicitNamespace(call.namespace)
  const callTiming = timing(context, call.internal_chat_message_metadata_passthrough)
  const input = parsedArguments(call.arguments)
  return [
    actionStarted(context, call.call_id, callTiming, {
      tool: qualifiedTool(call.namespace, call.name),
      action_kind: actionKind(namespace, call.name),
      input,
    }),
    ...(namespace === null && call.name === planTool ? planUpdated(context, call.call_id, callTiming, input) : []),
  ]
}

export const customToolCall = (context: LineContext): LineFacts => {
  const parsed = CustomToolCall.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const call = parsed.data
  return [
    actionStarted(context, call.call_id, timing(context, call.internal_chat_message_metadata_passthrough), {
      tool: call.name,
      action_kind: call.name === codeCellTool ? 'code_cell' : actionKind(null, call.name),
      input: call.input,
    }),
  ]
}

export const toolOutput = (context: LineContext): LineFacts => {
  const parsed = ToolOutput.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const { call_id: call, output, internal_chat_message_metadata_passthrough: passthrough } = parsed.data
  return [
    actionEnded(context, call, timing(context, passthrough), {
      outcome: 'unknown',
      output: typeof output === 'string' ? output : joinText(output),
    }),
  ]
}
