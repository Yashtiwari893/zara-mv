import { NextResponse } from 'next/server'
import { sendMorningBriefingToAll } from '@/lib/features/briefing'

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false

  // Vercel Cron sends x-cron-secret header
  if (req.headers.get('x-cron-secret') === cronSecret) return true

  // Bearer token fallback
  const authHeader = req.headers.get('authorization')
  if (authHeader === `Bearer ${cronSecret}`) return true

  // Query param fallback (for manual trigger)
  const url = new URL(req.url)
  if (url.searchParams.get('secret') === cronSecret) return true

  return false
}

async function handleBriefing(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    console.log('[cron/briefing] Starting morning briefing...')
    const result = await sendMorningBriefingToAll()
    console.log(`[cron/briefing] Done — Sent: ${result.sent}, Failed: ${result.failed}`)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[cron/briefing] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(req: Request) {
  return handleBriefing(req)
}

export async function POST(req: Request) {
  return handleBriefing(req)
}
