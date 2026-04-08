import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuid } from 'uuid'
import { classifyIntent } from '@/lib/ai/intent'
import { getOrCreateUser, handleOnboarding } from '@/lib/features/onboarding'
import {
  handleSetReminder, handleListReminders,
  handleSnoozeReminder, handleCancelReminder
} from '@/lib/features/reminder'
import {
  handleAddTask, handleListTasks, handleCompleteTask,
  handleDeleteTask, handleDeleteList
} from '@/lib/features/task'
import {
  handleSaveDocument, handleFindDocument, handleListDocuments,
  handleDeleteDocument
} from '@/lib/features/document'
import { handleGetBriefing } from '@/lib/features/briefing'
import { helpMessage } from '@/lib/whatsapp/templates'
import { sendWhatsAppMessage } from '@/lib/whatsapp/client'
import { speechToText } from '@/lib/ai/stt'
import { generateAutoResponse } from '@/lib/autoResponder'
import { getSupabaseClient } from '@/lib/infrastructure/database'
import { logger, setTraceId } from '@/lib/infrastructure/logger'
import { createErrorResponse } from '@/lib/infrastructure/errorHandler'
import { validatePhone, validatePlainText } from '@/lib/infrastructure/inputValidator'
import { retryWithExponentialBackoff } from '@/lib/infrastructure/errorHandler'
import { getContext, updateContext, addToHistory, clearPendingAction } from '@/lib/infrastructure/sessionContext'
import type { PendingDelete } from '@/lib/infrastructure/sessionContext'
import type { Language } from '@/types'

const supabaseAdmin = getSupabaseClient()
const recentlyProcessed = new Map<string, number>()

// BUG FIX: Proper MIME type resolver - was hardcoded 'image/jpeg' before
function resolveMimeType(rawMime?: string | null, subType?: string | null): string {
  if (rawMime) {
    const clean = rawMime.split(';')[0].trim().toLowerCase()
    const supported = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
    if (supported.includes(clean)) return clean
  }
  if (subType === 'document') return 'application/pdf'
  return 'image/jpeg'
}

interface ParsedWebhookBody {
  from?: string
  to?: string
  messageId?: string
  event?: string
  whatsapp?: { senderName?: string | null }
  content?: {
    text?: string
    button_id?: string | null
    contentType?: string
    media?: {
      caption?: string
      url?: string
      mimeType?: string
      mime_type?: string
      type?: string
    }
  }
}

function parseWebhookPayload(body: unknown) {
  const payload = (body ?? {}) as ParsedWebhookBody
  return {
    phone: payload.from || '',
    to: payload.to || '',
    message: payload.content?.text || payload.content?.media?.caption || '',
    buttonId: payload.content?.button_id || null,
    mediaUrl: payload.content?.media?.url || null,
    mediaType: payload.content?.contentType || 'text',
    mimeType: payload.content?.media?.mimeType || payload.content?.media?.mime_type || null,
    subType: payload.content?.media?.type || null,
    messageId: payload.messageId || '',
    name: payload.whatsapp?.senderName || null,
    event: payload.event || 'MoMessage'
  }
}

async function getLatestOutgoingReply(fromNumber: string, toNumber: string): Promise<string | null> {
  const windowStart = new Date(Date.now() - 60_000).toISOString()

  const { data } = await supabaseAdmin
    .from('whatsapp_messages')
    .select('content_text')
    .eq('event_type', 'MtMessage')
    .eq('from_number', fromNumber)
    .eq('to_number', toNumber)
    .gte('received_at', windowStart)
    .order('received_at', { ascending: false })
    .limit(1)

  const latest = data?.[0]?.content_text
  return typeof latest === 'string' && latest.trim().length > 0 ? latest : null
}

function extractMultiReminderFallbackItems(message: string): Array<{ title: string; dateTimeText: string }> {
  const dayMatch = message.match(/\b(kal|tomorrow|aaj|today|parso)\b/i)
  const dayPrefix = dayMatch ? dayMatch[1] : ''
  const seen = new Set<string>()

  const slots: string[] = []

  const addUniqueSlot = (raw: string | undefined | null) => {
    if (!raw) return
    const clean = raw.trim().replace(/\s+/g, ' ')
    if (!/\d/.test(clean)) return
    const key = clean.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    slots.push(clean)
  }

  // Better time pattern: captures "2:00 baje", "3 baje", "7:00 baje", with optional context words.
  const timeMatches = message.match(/\b(?:subah|dopahar|shaam|sham|raat)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|baje|bje)?\b/gi) || []
  timeMatches.forEach((match) => addUniqueSlot(match))

  // Also extract ordinal-based reminder phrases: pehla/dusra/teesra/chautha/paanchva reminder ... <time>
  const ordinalPatterns = [
    /(?:pahla?|pehla?|1st?)\s+reminder[^,.;\n]*?(\d{1,2}(?::\d{2})?\s*(?:baje|bje|am|pm)?)/gi,
    /(?:dusra|doosra|2nd?)\s+reminder[^,.;\n]*?(\d{1,2}(?::\d{2})?\s*(?:baje|bje|am|pm)?)/gi,
    /(?:teesra|tisra|3rd?)\s+reminder[^,.;\n]*?(\d{1,2}(?::\d{2})?\s*(?:baje|bje|am|pm)?)/gi,
    /(?:chautha|chotha|4th?)\s+reminder[^,.;\n]*?(\d{1,2}(?::\d{2})?\s*(?:baje|bje|am|pm)?)/gi,
    /(?:paanchva|panchva|5th?)\s+reminder[^,.;\n]*?(\d{1,2}(?::\d{2})?\s*(?:baje|bje|am|pm)?)/gi,
  ]

  for (const pattern of ordinalPatterns) {
    for (const match of message.matchAll(pattern)) {
      addUniqueSlot(match[1])
    }
  }

  return slots.map((slot, index) => ({
    title: `Reminder ${index + 1}`,
    dateTimeText: dayPrefix ? `${dayPrefix} ${slot}` : slot,
  }))
}

export async function POST(req: NextRequest) {
  // ─── TRACE ID & LOGGING ────────────────────────────────
  const traceId = uuid()
  setTraceId(traceId)

  try {
    const body = await req.json()
    logger.info('📩 Webhook received', { traceId, eventType: body.event })

    // ─── PARSE & VALIDATE WEBHOOK PAYLOAD ──────────────────
    const { phone, to, message, buttonId, mediaUrl, mediaType, mimeType, subType, messageId, name, event } = parseWebhookPayload(body)

    // ─── IN-MEMORY DEDUP (rapid duplicate deliveries in same instance) ───
    const now = Date.now()
    if (recentlyProcessed.has(messageId)) {
      logger.info('⚡ In-memory duplicate skip', { messageId })
      return NextResponse.json({ ok: true })
    }
    recentlyProcessed.set(messageId, now)
    // Cleanup old entries (keep map bounded)
    if (recentlyProcessed.size > 500) {
      const oldest = [...recentlyProcessed.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, 100)
      oldest.forEach(([k]) => recentlyProcessed.delete(k))
    }

    // ─── VALIDATE REQUIRED FIELDS ──────────────────────────
    if (!phone || !messageId) {
      logger.warn('Invalid webhook - missing required fields', { phone, messageId })
      return NextResponse.json({ ok: true }) // Silent ignore
    }

    // ─── VALIDATE PHONE NUMBERS ────────────────────────────
    let cleanFromPhone: string
    let cleanToPhone: string
    try {
      cleanFromPhone = validatePhone(phone)
      cleanToPhone = validatePhone(to)
    } catch {
      logger.warn('Invalid phone format', { phone, to })
      return NextResponse.json({ ok: true })
    }

    // ─── ATOMIC DEDUPLICATION ─────────────────────────────
    // We try to insert first. If it fails with 23505 (Unique violation), it's a duplicate.
    // This is faster and safer than (SELECT then INSERT).
    try {
      const { error: logErr } = await supabaseAdmin.from('whatsapp_messages').insert([{
        message_id: messageId,
        channel: 'whatsapp',
        from_number: cleanFromPhone,
        to_number: cleanToPhone,
        received_at: new Date().toISOString(),
        content_type: mediaType,
        content_text: message ? validatePlainText(message, 10000) : null,
        sender_name: name ? validatePlainText(name, 100) : null,
        event_type: event,
        is_in_24_window: true,
        is_responded: false,
        raw_payload: body,
        trace_id: traceId,
      }])

      if (logErr) {
        if ((logErr as { code?: string }).code === '23505') {
          logger.info('ℹ️ Duplicate message ignored (Insert conflict)', { messageId })
          return NextResponse.json({ ok: true }) // Silent ignore
        }
        throw logErr
      }
    } catch (logErr) {
      // If DB is failing, we might have issues, but for now we skip to avoid infinite loops
      logger.error('Failed to log message', { messageId }, logErr as Error)
    }

    // ─── ONLY PROCESS INCOMING MESSAGES ────────────────────
    if (event !== 'MoMessage') {
      logger.debug('Ignored non-MoMessage event', { event })
      return NextResponse.json({ ok: true })
    }

    // ─── GET OR CREATE USER (with retries) ─────────────────
    const user = await retryWithExponentialBackoff(
      () => getOrCreateUser(cleanFromPhone, name),
      3
    )

    if (!user) {
      logger.error('Failed to create user', { phone: cleanFromPhone })
      return NextResponse.json({ ok: true }) // Silent fail
    }

    // ─── UPDATE USER NAME IF AVAILABLE ────────────────────
    if (name && !user.name) {
      try {
        await supabaseAdmin.from('users').update({ name: validatePlainText(name, 100) }).eq('id', user.id)
      } catch {
        logger.warn('Failed to update user name', { userId: user.id })
      }
    }

    const lang = (user.language as Language) ?? 'en'

    // ─── HANDLE ONBOARDING FLOW ───────────────────────────
    if (!user.onboarded) {
      await handleOnboarding(user, message, buttonId)
      return NextResponse.json({ ok: true })
    }

    // ─── PROCESS MESSAGE CONTENT ──────────────────────────
    let processedMessage = message

    // Convert voice/audio to text
    if (mediaType === 'media' && (subType === 'voice' || subType === 'audio') && mediaUrl) {
      try {
        const { data: botCreds } = await supabaseAdmin
          .from('phone_document_mapping')
          .select('auth_token')
          .eq('phone_number', cleanToPhone)
          .limit(1)
        const authToken = botCreds?.[0]?.auth_token || process.env.ELEVEN_ZA_API_KEY

        const stt = await speechToText(mediaUrl, authToken)
        processedMessage = stt?.text || message
        logger.info('🎙 Voice transcribed', { userId: user.id, length: processedMessage?.length })
      } catch (sttErr) {
        logger.error('Speech-to-text failed', { userId: user.id }, sttErr as Error)
        processedMessage = message // Fallback to original
      }
    }

    // ─── HANDLE IMAGE/DOCUMENT UPLOADS ─────────────────────
    const isImageOrDoc = mediaType === 'image' || mediaType === 'document' || subType === 'image' || subType === 'document'
    if (mediaUrl && isImageOrDoc && subType !== 'voice' && subType !== 'audio') {
      const resolvedMime = resolveMimeType(mimeType, subType)
      await handleSaveDocument({
        userId: user.id,
        phone: cleanFromPhone,
        language: lang,
        mediaUrl: mediaUrl!,
        mediaType: resolvedMime,
        caption: processedMessage || undefined,
        authToken: undefined,
      })
      return NextResponse.json({ ok: true })
    }

    // ─── EMPTY MESSAGE CHECK ──────────────────────────────
    if (!processedMessage?.trim()) {
      logger.debug('Empty message - ignoring')
      return NextResponse.json({ ok: true })
    }

    // ─── LOAD SESSION CONTEXT ─────────────────────────────
    const ctx = await getContext(user.id)

    // ─── HANDLE PENDING DELETE CONFIRMATION ──────────────────────
    if (ctx?.pending_action === 'awaiting_delete_confirm' && ctx?.pending_delete) {
      const pd = ctx.pending_delete as PendingDelete
      const lowerMsg = processedMessage.toLowerCase().trim()

      const isYes = /^(haan|ha|yes|y|ok|okay|confirm|bilkul|ji|theek\s*hai|thik\s*hai|kar\s*do|karo|delete\s*karo|done|sure|haan\s*ji|ha\s*ji|han|hnji)$/i.test(lowerMsg)
      const isNo  = /^(nahi|nhi|nahin|no|n|cancel|rukao|ruk|mat\s*karo|band\s*karo|rehne\s*do|chodo|chordo|naa|na|don'?t|mana\s*hai|nai|nope)$/i.test(lowerMsg)

      if (isYes) {
        await clearPendingAction(user.id)
        // Execute the stored delete
        if (pd.intent === 'DELETE_LIST') {
          await handleDeleteList({ userId: user.id, phone: cleanFromPhone, language: lang, listName: pd.listName || '', isBulk: !!pd.isBulk })
        } else if (pd.intent === 'DELETE_DOCUMENT') {
          await handleDeleteDocument({ userId: user.id, phone: cleanFromPhone, language: lang, query: pd.query || '' })
        } else if (pd.intent === 'CANCEL_REMINDER') {
          await handleCancelReminder({ userId: user.id, phone: cleanFromPhone, language: lang, titleHint: pd.titleHint, isGenericSearch: pd.isGenericSearch })
        } else if (pd.intent === 'DELETE_TASK') {
          await handleDeleteTask({ userId: user.id, phone: cleanFromPhone, language: lang, taskContent: pd.taskContent || '' })
        }
      } else if (isNo) {
        await clearPendingAction(user.id)
        await sendWhatsAppMessage({
          to: cleanFromPhone,
          message: lang === 'hi'
            ? '✅ Theek hai, delete cancel kar diya! Koi cheez delete nahi hui.'
            : '✅ Got it! Nothing was deleted.'
        })
      } else {
        // Neither yes nor no — re-ask
        await sendWhatsAppMessage({
          to: cleanFromPhone,
          message: lang === 'hi'
            ? `${pd.confirmMessage}\n\n_"Haan" bolein confirm karne ke liye, "Nahi" bolein cancel karne ke liye._`
            : `${pd.confirmMessage}\n\n_Reply "Yes" to confirm or "No" to cancel._`
        })
      }
      return NextResponse.json({ ok: true })
    }

    // ─── HANDLE PENDING ACTIONS (e.g., awaiting document label) ─
    if (ctx?.pending_action === 'awaiting_label') {
      const rawLabel = processedMessage.trim()
      const cleanLabel = rawLabel.replace(/[^a-zA-Z0-9\s\u0900-\u097F]/g, '').substring(0, 50)
      
      const updateQuery = ctx.document_id 
        ? supabaseAdmin.from('documents').update({ label: cleanLabel }).eq('id', ctx.document_id)
        : supabaseAdmin.from('documents').update({ label: cleanLabel }).eq('storage_path', ctx.document_path).eq('user_id', user.id)

      await updateQuery
      
      await supabaseAdmin.from('sessions').update({ context: {} }).eq('user_id', user.id)
      
      await sendWhatsAppMessage({
        to: cleanFromPhone,
        message: lang === 'hi'
          ? `📁 *${cleanLabel}* के नाम से save हो गया!\n\n_"${cleanLabel} दिखाओ" बोलकर फिर से पा सकते हो।_`
          : `📁 Saved as *${cleanLabel}*!\n\nSay "show ${cleanLabel}" anytime to get it back.`
      })
      return NextResponse.json({ ok: true })
    }

    // ─── INTENT CLASSIFICATION ───────────────────────────
    logger.debug('Classifying intent', { userId: user.id })
    
    // Safety Guard: Conversational cues & pure greetings don't need heavy LLM classification
    const lowerMessage = processedMessage.toLowerCase().trim()

    // Extended cue list — covers Hinglish, Gujarati, and English acknowledgements
    const conversationalCues = new Set([
      'done', 'ok', 'okay', 'k', 'thanks', 'thank you', 'ty', 'thnx', 'thx',
      'dhanyawad', 'shukriya', 'shukriyaa', 'wow', 'good', 'great', 'nice',
      'perfect', 'bilkul', 'acha', 'accha', 'achha', 'theek hai', 'thik hai',
      'hi', 'hello', 'hey', 'hlo', 'hii', 'helo', 'namaste', 'namaskar',
      'kem cho', 'kaise ho', 'kya haal hai', 'sup'
    ])

    let intentResult;
    if (conversationalCues.has(lowerMessage)) {
      intentResult = { intent: 'UNKNOWN', confidence: 1.0, extractedData: {} }
    } else {
      intentResult = await classifyIntent(processedMessage, lang, ctx)
    }

    logger.info('Intent classified', {
      userId: user.id,
      intent: intentResult.intent,
      confidence: intentResult.confidence,
    })

    // ─── SMART KEYWORD-BASED INTENT OVERRIDE (Safety Net) ────
    // ONLY override to FIND_DOCUMENT if no task/reminder context present (BUG-05 fix)
    const isTaskOrReminderContext = /\b(task|list|grocery|todo|kaam|saaman|reminder|reminders|yaad|tasks|lists)\b/i.test(lowerMessage)
    const isDeleteContext = /\b(task|list|grocery|todo|tasks)\b/i.test(lowerMessage)

    // Negation/complaint guard — "maine X nahi bola", "mene X ko bola hi nhi", "I didn't say X"
    // These are user corrections/complaints, not commands. Never treat as actionable intents.
    const isNegationOrComplaint = /\b(nahi|nhi|nahin|never|bola\s+hi\s+nhi|bola\s+nahi|nai\s+bola|didn't|did\s+not|not\s+asked|nai\s+kaha|nahi\s+kaha)\b/i.test(lowerMessage)

    const isVaultDelete = !isNegationOrComplaint
      && /\b(vault|documents?|docs?|files?)\b/i.test(lowerMessage)
      && /\b(delete|hatao|mitao|remove|clear)\b/i.test(lowerMessage)

    // LIST_DOCUMENTS override — "sab documents", "meri files", "all docs"
    const isAllDocsQuery = /\b(sab|all|saari|meri)\s+(documents?|files?|photos?|pics?|docs?)\b/i.test(lowerMessage)
    if (isAllDocsQuery && (intentResult.intent === 'UNKNOWN' || intentResult.confidence < 0.7)) {
      intentResult.intent = 'LIST_DOCUMENTS'
      intentResult.confidence = 0.88
    }

    if (!isTaskOrReminderContext && (
      lowerMessage.includes('dikhao') || lowerMessage.includes('show') ||
      lowerMessage.includes('nikalo') || lowerMessage.includes('bhejo')
    )) {
      if (intentResult.intent === 'UNKNOWN' || intentResult.confidence < 0.7) {
        intentResult.intent = 'FIND_DOCUMENT'
        intentResult.confidence = 0.85
      }
    }

    // Deletion override — only for documents, not tasks/lists, and never for complaints/negations
    if (!isDeleteContext && !isNegationOrComplaint && (
      lowerMessage.includes('delete') || lowerMessage.includes('hatao') ||
      lowerMessage.includes('mitao') || lowerMessage.includes('remove') ||
      lowerMessage.includes('vault delete') || lowerMessage.includes('vault hatao')
    )) {
      if (isVaultDelete || intentResult.intent === 'UNKNOWN' || intentResult.confidence < 0.7) {
        intentResult.intent = 'DELETE_DOCUMENT'
        intentResult.confidence = 0.85
      }
    }

    // DELETE_DOCUMENT bulk override — "sab documents delete", "vault delete", "sab hatao"
    // MUST have explicit document keyword (vault/docs/files) — bare "sab delete" is ambiguous
    const isAllDocDelete = !isNegationOrComplaint
      && /\b(mera vault|vault|documents?|docs?|files?)\b/i.test(lowerMessage)
      && /\b(sab|all|saari|pure)?\b/i.test(lowerMessage)
      && /\b(delete|hatao|mitao|remove|clear)\b/i.test(lowerMessage)
      && !isTaskOrReminderContext

    if (isAllDocDelete && (intentResult.intent === 'UNKNOWN' || intentResult.intent === 'FIND_DOCUMENT' || intentResult.confidence < 0.75)) {
      intentResult.intent = 'DELETE_DOCUMENT'
      intentResult.confidence = 0.88
    }

    // ─── ABUSE/GALI DETECTION ────────────────────────────
    // BUG-22: Removed 'sale' (shopping sale) from abuse list
    const abusePattern = /\b(kutte|bc|bhenchod|madarchod|mc|hrami|saale|kamine|kutta)\b/i
    const hasAbuse = abusePattern.test(lowerMessage)
    let abuseWarning = ''

    if (hasAbuse) {
      abuseWarning = lang === 'hi' 
        ? '⚠️ Main yahan aapki help ke liye hoon professionally. Kripya respect ke saath baat karein taaki main behtar assist kar sakoon! 😊\n\n'
        : '⚠️ I am here to help you professionally. Please keep our conversation respectful so I can assist you better! 😊\n\n'
    }

    // ─── ROUTE TO FEATURE HANDLERS ────────────────────────
    let isHandled = false
    const { intent, extractedData } = intentResult

    try {
      switch (intent) {
        case 'SET_REMINDER':
          // BUG-04 FIX: Multi-reminder support
          if (extractedData.isMultiReminder && Array.isArray(extractedData.reminderItems) && extractedData.reminderItems.length > 0) {
            const fallbackItems = extractMultiReminderFallbackItems(processedMessage)
            const llmItems = extractedData.reminderItems
              .map((item, index) => ({
                title: item.title?.trim() || `Reminder ${index + 1}`,
                dateTimeText: item.dateTimeText?.trim() || ''
              }))
              .filter((item) => item.dateTimeText.length > 0)

            // ALWAYS prefer LLM items — they extract real titles like "doctor appointment"
            // Only use fallback if LLM gave no usable items at all
            const reminderItems = llmItems.length > 0 ? llmItems : fallbackItems

            // Pre-loop ambiguity check: if original message has no explicit day or AM/PM,
            // send ONE clarification message instead of N individual ones.
            const hasExplicitDay = /\b(kal|aaj|today|tomorrow|parso|monday|tuesday|wednesday|thursday|friday|saturday|sunday|som|mangal|budh|guru|shukra|shani|ravi|\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\d{1,2}\/\d{1,2})\b/i.test(processedMessage)
            const hasExplicitAmPm = /\b(am|pm|subah|dopahar|shaam|raat|morning|evening|night|afternoon)\b/i.test(processedMessage)

            if (!hasExplicitDay || !hasExplicitAmPm) {
              await sendWhatsAppMessage({
                to: cleanFromPhone,
                message: abuseWarning + (lang === 'hi'
                  ? `⏰ ${reminderItems.length} reminders set karne ke liye thoda aur detail chahiye:\n\n_Kaunse din ke liye? (Aaj/Kal)_\n_Subah ke liye ya Shaam ke liye? (AM/PM)_\n\nJaise: "Kal shaam 2, 3, 4, 7 baje" ya "Aaj subah 9am, 11am" 😊`
                  : `⏰ I need a bit more info to set your ${reminderItems.length} reminders:\n\n_Which day? (Today/Tomorrow)_\n_Morning or Evening? (AM/PM)_\n\nTry: "Tomorrow evening 2pm, 5pm, 8pm" or "Today morning 9am, 11am" 😊`)
              })
              isHandled = true
              break
            }

            const results: string[] = []
            for (const item of reminderItems) {
              await handleSetReminder({
                userId: user.id,
                phone: cleanFromPhone,
                language: lang,
                message: processedMessage,
                dateTimeText: item.dateTimeText || processedMessage,
                reminderTitle: item.title,
                prefix: abuseWarning
              })
              results.push(item.title)
            }
            logger.info(`Multi-reminder: set ${results.length} reminders`, { userId: user.id })
          } else {
            await handleSetReminder({
              userId: user.id,
              phone: cleanFromPhone,
              language: lang,
              message: processedMessage,
              dateTimeText: extractedData.dateTimeText || processedMessage,
              reminderTitle: extractedData.reminderTitle || undefined,
              prefix: abuseWarning
            })
          }
          isHandled = true
          break

        case 'LIST_REMINDERS':
          await handleListReminders({
            userId: user.id,
            phone: cleanFromPhone,
            language: lang,
          })
          isHandled = true
          break

        // BUG-08 FIX: Added missing SNOOZE_REMINDER case
        case 'SNOOZE_REMINDER':
          await handleSnoozeReminder({
            userId: user.id,
            phone: cleanFromPhone,
            language: lang,
            minutes: extractedData.snoozeMinutes,
            customText: extractedData.dateTimeText || undefined,
            prefix: abuseWarning
          })
          isHandled = true
          break

        // BUG-08 FIX: Added missing CANCEL_REMINDER case
        case 'CANCEL_REMINDER': {
          // Detect bulk cancel from message itself (LLM may miss isGenericSearch flag)
          const cancelBulkPattern = /\b(all|sab|saare|saari|everything|pure|dono|both)\b/i
          const isCancelAll = !!extractedData.isGenericSearch || cancelBulkPattern.test(processedMessage)
          const reminderLabel = isCancelAll
            ? (lang === 'hi' ? 'SAARE reminders' : 'ALL reminders')
            : extractedData.reminderTitle
              ? `*"${extractedData.reminderTitle}"* reminder`
              : (lang === 'hi' ? 'yeh reminder' : 'this reminder')
          const confirmMsg = lang === 'hi'
            ? `🗑️ Kya aap ${reminderLabel} cancel karna chahte ho?`
            : `🗑️ Are you sure you want to cancel ${reminderLabel}?`
          await updateContext(user.id, {
            pending_action: 'awaiting_delete_confirm',
            pending_delete: { intent: 'CANCEL_REMINDER', titleHint: extractedData.reminderTitle || undefined, isGenericSearch: isCancelAll, confirmMessage: confirmMsg } as PendingDelete,
          })
          await sendWhatsAppMessage({
            to: cleanFromPhone,
            message: abuseWarning + confirmMsg + (lang === 'hi' ? '\n\n_"Haan" / "Nahi"_' : '\n\n_Reply "Yes" or "No"_')
          })
          isHandled = true
          break
        }

        case 'ADD_TASK': {
          const rawTaskContent = extractedData.taskContent || processedMessage
          // Guard: vague/future-reference content should not be added literally
          const vaguePattern = /^(jo abhi boluga|jo bolunga|abhi nahi|baad mein|later|coming soon|jo bhi|kuch bhi|anything|something|ek list create karo|list create karo|list banao|list bana do|create karo|create list)$/i
          if (vaguePattern.test(rawTaskContent.trim().toLowerCase())) {
            await sendWhatsAppMessage({
              to: cleanFromPhone,
              message: abuseWarning + (lang === 'hi'
                ? '❓ Kya add karna hai? Please specific task batao jaise "milk", "call dentist" etc.'
                : '❓ What should I add? Please mention a specific item like "milk" or "call dentist".')
            })
            isHandled = true
            break
          }
          await handleAddTask({
            userId: user.id,
            phone: cleanFromPhone,
            language: lang,
            taskContent: rawTaskContent,
            listName: extractedData.listName || 'general',
            prefix: abuseWarning
          })
          isHandled = true
          break
        }

        case 'LIST_TASKS':
          await handleListTasks({
            userId: user.id,
            phone: cleanFromPhone,
            language: lang,
            listName: extractedData.listName || 'general',
            isGenericSearch: extractedData.isGenericSearch,
            prefix: abuseWarning
          })
          isHandled = true
          break

        case 'COMPLETE_TASK':
          await handleCompleteTask({
            userId: user.id,
            phone: cleanFromPhone,
            language: lang,
            taskContent: extractedData.taskContent || processedMessage,
            prefix: abuseWarning
          })
          isHandled = true
          break

        case 'DELETE_TASK': {
          const taskToDelete = extractedData.taskContent || processedMessage
          const confirmMsg = lang === 'hi'
            ? `🗑️ Kya aap *"${taskToDelete}"* task delete karna chahte ho?`
            : `🗑️ Are you sure you want to delete the task *"${taskToDelete}"*?`
          await updateContext(user.id, {
            pending_action: 'awaiting_delete_confirm',
            pending_delete: { intent: 'DELETE_TASK', taskContent: taskToDelete, confirmMessage: confirmMsg } as PendingDelete,
          })
          await sendWhatsAppMessage({
            to: cleanFromPhone,
            message: abuseWarning + confirmMsg + (lang === 'hi' ? '\n\n_"Haan" / "Nahi"_' : '\n\n_Reply "Yes" or "No"_')
          })
          isHandled = true
          break
        }

        case 'DELETE_LIST': {
          // Strong bulk detection — covers "delete all", "remove both", "delete all task list" etc
          const deleteBulkKeywords = /\b(all|both|everything|sab|saari|saare|sabke|pure|dono)\b/i
          const isBulkDelete = !!extractedData.isGenericSearch
            || deleteBulkKeywords.test(processedMessage)
            || !extractedData.listName
            || ['all', 'both', 'everything', 'sab', 'saari', 'saare'].includes((extractedData.listName || '').toLowerCase())
          const hasReminderContext = /\b(reminder|reminders|yaad|alarm)\b/i.test(lowerMessage)
          const finalIsBulkDelete = isBulkDelete && !hasReminderContext
          const listLabel = finalIsBulkDelete
            ? (lang === 'hi' ? 'SAARI task lists' : 'ALL task lists')
            : `*"${extractedData.listName}"*`
          const confirmMsg = lang === 'hi'
            ? `🗑️ Kya aap ${listLabel} delete karna chahte ho?`
            : `🗑️ Are you sure you want to delete ${listLabel}?`
          await updateContext(user.id, {
            pending_action: 'awaiting_delete_confirm',
            pending_delete: { intent: 'DELETE_LIST', listName: extractedData.listName || '', isBulk: finalIsBulkDelete, confirmMessage: confirmMsg } as PendingDelete,
          })
          await sendWhatsAppMessage({
            to: cleanFromPhone,
            message: abuseWarning + confirmMsg + (lang === 'hi' ? '\n\n_"Haan" / "Nahi"_' : '\n\n_Reply "Yes" or "No"_')
          })
          isHandled = true
          break
        }

        case 'FIND_DOCUMENT':
          try {
            const foundDocId = await handleFindDocument({
              userId: user.id,
              phone: cleanFromPhone,
              language: lang,
              query: extractedData?.documentQuery
                || processedMessage.replace(/(dikhao|show|bhejo|send|do|de|nikalo|lao|find|get|kahan|where)/gi, '').trim()
                || processedMessage,
            })
            if (foundDocId) {
              await updateContext(user.id, { last_referenced_id: foundDocId as string })
            }
            isHandled = true
          } catch (docErr) {
            logger.error('FindDocument internal fail', { userId: user.id }, docErr as Error)
            isHandled = true
          }
          break

        case 'LIST_DOCUMENTS':
          await handleListDocuments({
            userId: user.id,
            phone: cleanFromPhone,
            language: lang,
          })
          isHandled = true
          break

        case 'DELETE_DOCUMENT': {
          const docQuery = extractedData?.documentQuery
            || processedMessage.replace(/(delete|hatao|mitao|remove|hata)/gi, '').trim()
            || processedMessage
          const docLabel = extractedData?.documentQuery
            ? `*"${extractedData.documentQuery}"*`
            : (lang === 'hi' ? 'SAARE documents vault se' : 'ALL documents from your vault')
          const confirmMsg = lang === 'hi'
            ? `🗑️ Kya aap ${docLabel} delete karna chahte ho?`
            : `🗑️ Are you sure you want to delete ${docLabel}?`
          await updateContext(user.id, {
            pending_action: 'awaiting_delete_confirm',
            pending_delete: { intent: 'DELETE_DOCUMENT', query: docQuery, confirmMessage: confirmMsg } as PendingDelete,
          })
          await sendWhatsAppMessage({
            to: cleanFromPhone,
            message: abuseWarning + confirmMsg + (lang === 'hi' ? '\n\n_"Haan" / "Nahi"_' : '\n\n_Reply "Yes" or "No"_')
          })
          isHandled = true
          break
        }

        case 'GET_BRIEFING':
          await handleGetBriefing({
            userId: user.id,
            phone: cleanFromPhone,
            language: lang,
          })
          isHandled = true
          break

        case 'HELP': {
          // Don't send full help menu for greetings or very short messages
          const isGreeting = /^(hi|hey|hello|hlo|hii|helo|namaste|namaskar|kem cho|kaise ho|sup)$/i.test(lowerMessage)
          if (isGreeting) {
            // Route to autoResponder for warm greeting instead
            isHandled = false
          } else {
            await sendWhatsAppMessage({ to: cleanFromPhone, message: helpMessage(lang) })
            isHandled = true
          }
          break
        }

        default:
          break
      }

      // ─── CONTEXT & HISTORY UPDATE ─────────────────────────
      if (isHandled) {
        try {
          await updateContext(user.id, {
            last_intent: intent,
            last_list_name: extractedData?.listName || ctx.last_list_name || undefined,
            last_document_query: extractedData?.documentQuery || ctx.last_document_query || undefined,
            last_referenced_id: extractedData?.lastReferencedId || ctx.last_referenced_id || undefined
          })
          // BUG-17 FIX: Always log user message to history for feature handlers too
          await addToHistory(user.id, 'user', processedMessage)

          // Keep assistant side in session history as well so LLM gets full turn-by-turn context.
          const latestReply = await getLatestOutgoingReply(cleanToPhone, cleanFromPhone)
          if (latestReply) {
            await addToHistory(user.id, 'assistant', latestReply)
          }
        } catch (ctxErr) {
          logger.warn('Session context update failed (silent)', { userId: user.id, error: (ctxErr as Error).message })
        }
      } else {
        // Not handled by any feature? Use Auto-Responder (pass userId for unified history)
        const autoResp = await generateAutoResponse(cleanFromPhone, cleanToPhone, processedMessage, messageId, user.id)
        if (autoResp.response && autoResp.response !== 'Duplicate prevention' && autoResp.response !== 'Safety skip — recent reply detected') {
          // Store full conversation turn in history
          await addToHistory(user.id, 'user', processedMessage)
          await addToHistory(user.id, 'assistant', autoResp.response)
        }
        // Note: autoResponder.ts already claims/marks the message as responded atomically.
        // Skip the duplicate mark-as-responded below to avoid DB write conflicts.
        logger.info('✅ Message processed via auto-responder', { userId: user.id, sent: autoResp.sent })
        return NextResponse.json({ ok: true })
      }

      // Mark as responded ATOMICALLY (for feature-handled messages only)
      try {
        await supabaseAdmin.from('whatsapp_messages')
          .update({ is_responded: true, response_sent_at: new Date().toISOString() })
          .eq('message_id', messageId)
      } catch (markErr) {
        logger.error('Failed to mark as responded', { messageId }, markErr as Error)
      }

    } catch (featureErr) {
      logger.error('Feature handler error', { userId: user.id, intent }, featureErr as Error)

      if (!isHandled) {
        try {
          await generateAutoResponse(cleanFromPhone, cleanToPhone, processedMessage, messageId, user.id)
        } catch (fallbackErr) {
          logger.error('Auto-responder fail', fallbackErr as Error)
        }
      }
    }

    logger.info('✅ Message processed successfully', { userId: user.id, traceId })
    return NextResponse.json({ ok: true })

  } catch (err) {
    logger.error('Webhook error', { traceId }, err as Error)
    return createErrorResponse(err, traceId)
  }
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('hub.verify_token')
  const challenge = req.nextUrl.searchParams.get('hub.challenge')
  if (token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge ?? 'ok')
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
