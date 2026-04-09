// src/app/api/health/route.ts
// Production health check — validates all critical dependencies

import { NextResponse } from 'next/server'
import { getSupabaseClient } from '@/lib/infrastructure/database'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  const status: Record<string, unknown> = {
    status: 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'local',
    checks: {} as Record<string, string>,
  }

  const checks: Record<string, string> = {}

  // 1. Database (Supabase)
  try {
    const supabase = getSupabaseClient()
    const { error } = await supabase.from('users').select('id').limit(1)
    checks.database = error ? 'error' : 'ok'
  } catch (e) {
    checks.database = 'down'
    console.error('[Health] DB check failed:', (e as Error).message)
  }

  // 2. AI Provider (Groq) — check if key is configured
  try {
    checks.ai = process.env.GROQ_API_KEY ? 'ok' : 'not_configured'
  } catch {
    checks.ai = 'error'
  }

  // 3. WhatsApp API — check if credentials exist
  checks.whatsapp = (process.env.WHATSAPP_AUTH_TOKEN && process.env.WHATSAPP_ORIGIN)
    ? 'ok'
    : 'not_configured'

  // 4. Cron Secret — must be set for scheduled jobs
  checks.cron = process.env.CRON_SECRET ? 'ok' : 'not_configured'

  // 5. Google OAuth (optional)
  checks.google_oauth = (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
    ? 'ok'
    : 'not_configured'

  status.checks = checks

  // Overall status
  const criticalChecks = [checks.database, checks.ai, checks.whatsapp]
  const allCriticalOk = criticalChecks.every(c => c === 'ok')
  const anyCriticalDown = criticalChecks.some(c => c === 'down' || c === 'error')

  if (allCriticalOk) {
    status.status = 'healthy'
  } else if (anyCriticalDown) {
    status.status = 'unhealthy'
  } else {
    status.status = 'degraded'
  }

  const httpStatus = status.status === 'healthy' ? 200 : status.status === 'degraded' ? 200 : 503
  return NextResponse.json(status, { status: httpStatus })
}
