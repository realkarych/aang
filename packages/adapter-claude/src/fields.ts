import { z } from 'zod'

export const name = z.string().min(1)
export const optionalText = z.string().nullish()
