import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

const url = process.env.NUXT_DATABASE_URL || process.env.DATABASE_URL
if (!url) {
  throw new Error('DATABASE_URL не задан — приложение не может стартовать без базы')
}

const client = postgres(url, {
  max: Number(process.env.DB_POOL_MAX || 20),
  onnotice: () => {},
})

export const db = drizzle(client, { schema })
export type Db = typeof db
