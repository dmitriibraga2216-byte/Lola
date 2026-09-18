import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

const url = process.env.DATABASE_ADMIN_URL
if (!url) {
  console.error('DATABASE_ADMIN_URL не задан — миграции идут от владельца БД')
  process.exit(1)
}

const client = postgres(url, { max: 1, onnotice: () => {} })

await migrate(drizzle(client), { migrationsFolder: 'server/db/migrations' })
console.log('Миграции применены')
await client.end()
