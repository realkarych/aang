import { z } from 'zod'
import { fact, joinText, type LineContext, type LineFacts, messageEntity, runtimeIds } from './facts.js'

const id = z.string().min(1)

const InterAgentMessage = z.looseObject({
  id,
  author: z.string().optional(),
  recipient: z.string().optional(),
  content: z.array(z.looseObject({ text: z.string().optional() })),
  internal_chat_message_metadata_passthrough: z.looseObject({ turn_id: id.optional() }).nullish(),
})

export const interAgentMessage = (context: LineContext): LineFacts => {
  const parsed = InterAgentMessage.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const message = parsed.data
  return [
    fact(
      'message',
      {
        entity: messageEntity(context.stream, context.line.ordinal),
        speaker: 'solver',
        urgent: false,
        at: context.line.at,
        ids: runtimeIds(context, {
          turn_id: message.internal_chat_message_metadata_passthrough?.turn_id ?? null,
          message_id: message.id,
        }),
      },
      { text: joinText(message.content), final: false, audience: 'agent', model: null },
    ),
  ]
}
