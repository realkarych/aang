import type { ApiErrorCode, EndpointSpec } from '@aang/contract'
import { z } from 'zod'

export class ApiFailure extends Error {
  override readonly name = 'ApiFailure'

  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface RouteRequest {
  readonly pathname: string
  readonly params: ReadonlyMap<string, string>
  readonly search: URLSearchParams
}

export interface ApiRoute {
  readonly method: EndpointSpec['method']
  readonly path: EndpointSpec['path']
  readonly serve: (request: RouteRequest) => Promise<unknown>
}

export interface RouteMatch {
  readonly route: ApiRoute
  readonly params: ReadonlyMap<string, string>
}

interface ReadSpec extends EndpointSpec {
  readonly method: 'GET'
  readonly body: null
}

type Parsed<T> = T extends z.ZodType ? z.output<T> : null

export interface ReadInput<S extends ReadSpec> {
  readonly params: Parsed<S['params']>
  readonly query: Parsed<S['query']>
}

type Found<S extends ReadSpec> = z.output<S['response']> | null

export type ReadHandler<S extends ReadSpec> = (input: ReadInput<S>) => Found<S> | Promise<Found<S>>

const capture = (path: string, pathname: string): Map<string, string> | null => {
  const expected = path.split('/')
  const actual = pathname.split('/')
  if (expected.length !== actual.length) {
    return null
  }
  const params = new Map<string, string>()
  for (const [index, segment] of expected.entries()) {
    const value = actual[index] ?? ''
    if (segment.startsWith(':')) {
      if (value === '') {
        return null
      }
      params.set(segment.slice(1), value)
    } else if (segment !== value) {
      return null
    }
  }
  return params
}

export const matchRoute = (routes: readonly ApiRoute[], method: string, pathname: string): RouteMatch | null => {
  for (const route of routes) {
    const params = route.method === method ? capture(route.path, pathname) : null
    if (params !== null) {
      return { route, params }
    }
  }
  return null
}

const decoded = (params: ReadonlyMap<string, string>): Record<string, string> => {
  try {
    return Object.fromEntries([...params].map(([name, value]) => [name, decodeURIComponent(value)]))
  } catch {
    throw new ApiFailure('invalid_request', 'a path parameter is not a valid percent-encoded string')
  }
}

const queryOf = (search: URLSearchParams): Record<string, string> => {
  const query = new Map<string, string>()
  for (const [name, value] of search) {
    if (query.has(name)) {
      throw new ApiFailure('invalid_request', `the query parameter ${name} is repeated`)
    }
    query.set(name, value)
  }
  return Object.fromEntries(query)
}

const parsed = (schema: z.ZodType, value: Record<string, string>, part: string): unknown => {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new ApiFailure('invalid_request', `invalid ${part}: ${z.prettifyError(result.error)}`)
  }
  return result.data
}

export const readRoute = <S extends ReadSpec>(spec: S, handle: ReadHandler<S>): ApiRoute => ({
  method: spec.method,
  path: spec.path,
  serve: async ({ pathname, params, search }) => {
    const input = {
      params: spec.params === null ? null : parsed(spec.params, decoded(params), 'path'),
      query: spec.query === null ? null : parsed(spec.query, queryOf(search), 'query'),
    } as ReadInput<S>
    const found = await handle(input)
    if (found === null) {
      throw new ApiFailure('not_found', `${pathname} was not found`)
    }
    return spec.response.encode(found)
  },
})
