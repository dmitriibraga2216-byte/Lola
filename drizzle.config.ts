import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/db/schema/index.ts',
  out: './server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Миграции идут от владельца БД, не от app_user
    url: process.env.DATABASE_ADMIN_URL || 'postgres://lola:lola_dev@localhost:5432/lola',
  },
})
