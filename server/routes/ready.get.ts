import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/** Readiness: БД и S3 достижимы. Красный → из балансировки. */
export default defineEventHandler(async (event) => {
  const checks: Record<string, 'ok' | 'fail'> = {}

  try {
    await db.execute(sql`select 1`)
    checks.db = 'ok'
  }
  catch {
    checks.db = 'fail'
  }

  const s3Endpoint = process.env.S3_ENDPOINT
  if (s3Endpoint) {
    try {
      const res = await fetch(`${s3Endpoint}/minio/health/live`, { signal: AbortSignal.timeout(2000) })
      checks.s3 = res.ok ? 'ok' : 'fail'
    }
    catch {
      checks.s3 = 'fail'
    }
  }

  const ready = Object.values(checks).every(v => v === 'ok')
  setResponseStatus(event, ready ? 200 : 503)
  return { status: ready ? 'ready' : 'not_ready', checks }
})
