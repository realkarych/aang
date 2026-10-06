import { type ChatMessage, type ChatQuestionRequest, endpoints, type RunId } from '@aang/contract'
import { ChatError, type ReadQueries } from '@aang/engine'
import { ChatClosedError } from '@aang/observer'
import { ApiFailure, type ApiRoute, readRoute, writeRoute } from './routes.js'

export interface ChatSources {
  readonly reads: ReadQueries
  readonly ask: (run: RunId, request: ChatQuestionRequest) => ChatMessage | null
}

const asked = (ask: ChatSources['ask'], run: RunId, request: ChatQuestionRequest): ChatMessage | null => {
  try {
    return ask(run, request)
  } catch (error) {
    if (error instanceof ChatError) {
      throw new ApiFailure('invalid_request', error.message)
    }
    if (error instanceof ChatClosedError) {
      throw new ApiFailure('unavailable', 'the daemon is stopping')
    }
    throw error
  }
}

export const chatRoutes = ({ reads, ask }: ChatSources): ApiRoute[] => [
  readRoute(endpoints.chatHistory, ({ params }) => reads.chat(params.run)),
  writeRoute(endpoints.chatQuestion, ({ params, body }) => {
    const message = asked(ask, params.run, body)
    return message === null ? null : { message }
  }),
]
