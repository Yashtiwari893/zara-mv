// src/app/api/reminders/trigger/route.ts
// Manual reminder trigger — for testing or on-demand reminder processing

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseClient } from '@/lib/infrastructure/database'
import { sendWhatsAppMessage } from '@/lib/whatsapp/client'
import type { Language } from '@/types'

const supabase = getSupabaseClient()

export async function POST(req: NextRequest) {
  try {
    // Auth check
    const body = await req.json()
    const secret = body.secret || req.headers.get('x-cron-secret')

    if (secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { reminder_id } = body

    if (!reminder_id) {
      return NextResponse.json({ error: 'reminder_id is required' }, { status: 400 })
    }

    // Fetch the reminder with user info
    const { data: reminder, error: fetchErr } = await supabase
      .from('reminders')
      .select('id, title, note, status, user_id, users(phone, language)')
      .eq('id', reminder_id)
      .single()

    if (fetchErr || !reminder) {
      return NextResponse.json({ error: 'Reminder not found' }, { status: 404 })
    }

    if (reminder.status !== 'pending') {
      return NextResponse.json({ error: 'Reminder is not pending', status: reminder.status }, { status: 400 })
    }

    const user = reminder.users as unknown as { phone: string; language: string } | null
    if (!user?.phone) {
      return NextResponse.json({ error: 'User phone not found' }, { status: 404 })
    }

    const lang = (user.language as Language) ?? 'en'
    const noteText = reminder.note ? `\n📌 ${reminder.note}` : ''
    const message = lang === 'hi'
      ? `⏰ *Reminder*\n\n📝 ${reminder.title}${noteText}\n\n_Done? "done" likho। Snooze? "snooze" likho।_`
      : `⏰ *Reminder*\n\n📝 ${reminder.title}${noteText}\n\n_Done? Reply "done". Snooze? Reply "snooze"._`

    await sendWhatsAppMessage({ to: user.phone, message })

    // Mark as sent
    await supabase.from('reminders').update({ status: 'sent' }).eq('id', reminder_id)

    return NextResponse.json({ success: true, reminder_id, sent_to: user.phone })
  } catch (err) {
    console.error('[reminders/trigger] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
