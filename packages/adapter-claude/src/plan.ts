import type { FactDraft, JsonValue, PlanItemStatus, PlanSource, PlanUpdatePayload } from '@aang/contract'
import { z } from 'zod'
import { callFact, type ToolCall } from './facts.js'
import { name, optionalText } from './fields.js'
import { stringField } from './json.js'
import { actionKey } from './keys.js'

type PlanContent = Omit<PlanUpdatePayload, 'source'>

type PlanReader = readonly [PlanSource, (input: JsonValue) => PlanContent | null]

const itemStatuses: ReadonlyMap<string, PlanItemStatus> = new Map([
  ['pending', 'pending'],
  ['in_progress', 'in_progress'],
  ['completed', 'completed'],
  ['deleted', 'cancelled'],
])

const itemStatus = (status: string | null | undefined): PlanItemStatus =>
  (typeof status === 'string' ? itemStatuses.get(status) : undefined) ?? 'unknown'

const TaskCreateInput = z.looseObject({ subject: z.string(), description: optionalText })

const TaskUpdateInput = z.looseObject({
  taskId: name,
  subject: optionalText,
  description: optionalText,
  status: optionalText,
})

const TodoWriteInput = z.looseObject({
  todos: z.array(z.looseObject({ content: z.string(), status: optionalText, id: optionalText })),
})

const readWith =
  <T>(schema: z.ZodType<T>, read: (input: T) => PlanContent) =>
  (input: JsonValue): PlanContent | null => {
    const parsed = schema.safeParse(input)
    return parsed.success ? read(parsed.data) : null
  }

const planReaders: ReadonlyMap<string, PlanReader> = new Map<string, PlanReader>([
  ['ExitPlanMode', ['exit_plan_mode', (input) => ({ text: stringField(input, 'plan'), items: [] })]],
  [
    'TaskCreate',
    [
      'task_tool',
      readWith(TaskCreateInput, (task) => ({
        text: task.description ?? null,
        items: [{ id: null, text: task.subject, status: 'pending' }],
      })),
    ],
  ],
  [
    'TaskUpdate',
    [
      'task_tool',
      readWith(TaskUpdateInput, (task) => ({
        text: task.description ?? null,
        items: [{ id: task.taskId, text: task.subject ?? '', status: itemStatus(task.status) }],
      })),
    ],
  ],
  [
    'TodoWrite',
    [
      'task_tool',
      readWith(TodoWriteInput, ({ todos }) => ({
        text: null,
        items: todos.map((todo) => ({ id: todo.id ?? null, text: todo.content, status: itemStatus(todo.status) })),
      })),
    ],
  ],
])

export const planUpdates = (call: ToolCall): FactDraft[] => {
  const reader = planReaders.get(call.tool)
  if (reader === undefined) {
    return []
  }
  const [source, read] = reader
  const plan = read(call.input)
  return plan === null
    ? []
    : [
        callFact(
          call,
          {
            kind: 'plan_update',
            entity_key: actionKey(call.session, call.call),
            speaker: 'solver',
            urgent: true,
            payload: { source, ...plan },
          },
          false,
        ),
      ]
}
