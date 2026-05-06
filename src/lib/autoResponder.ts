// src/lib/autoResponder.ts
// AI Auto-Responder — RAG/general chat fallback, invoked after feature handlers.
// v2.0 — Professional Edition: improved response quality, better RAG context, retry logic

import { getSupabaseClient } from '@/lib/infrastructure/database'
import { getGroqClient } from '@/lib/ai/clients'
import { sendWhatsAppMessage } from '@/lib/whatsapp/client'
import { getContext } from '@/lib/infrastructure/sessionContext'
import { AI_MODELS, APP, WHATSAPP_AUTH_TOKEN, WHATSAPP_ORIGIN } from '@/config'
import type { AutoResponseResult } from '@/types'

// ─── Constants ────────────────────────────────────────────────

const GROQ_TEMPERATURE = 0.35        // Slightly higher → more natural, less robotic
const LLM_TIMEOUT_MS   = 12_000     // 12s max before aborting
const MAX_RAG_CHARS    = 1500       // Limit injected doc context to prevent token overflow
const HALLUCINATION_PATTERNS = [
  /\b(set\s+ho\s+gay[ia]|ban\s+gay[ia]|create\s+ho\s+gay[ia]|taiyaar\s+hai|ready\s+hai)\b/i,
  /\b(add\s+ho\s+gay[ia]|add\s+kar\s+diy[ia]|save\s+ho\s+gay[ia]|dal\s+diy[ia])\b/i,
  /\b(delete\s+ho\s+gay[ia]|hata\s+diy[ia]|remove\s+ho\s+gay[ia])\b/i,
  /\b(list\s+set|task\s+list\s+set|list\s+ban|list\s+create|list\s+taiyaar)\b/i,
  /\b(aapki\s+(task\s+)?list\s+khali|aapki\s+list\s+mein|aapke\s+paas.*list)\b/i,
  /\b(pehle.*add\s+kiya.*wo\s+bhi|restore|wapas\s+aa\s+gaya)\b/i,
]

// ─── ZARA System Personality ──────────────────────────────────

const ZARA_BASE_RULES = `
You are ${APP.NAME}, a warm and intelligent personal assistant on WhatsApp.

## PERSONALITY
- Reply in the SAME language/mix as the user (Hinglish, Hindi, Gujarati, or English).
- Be SHORT — 1 to 3 lines max for most replies. No long paragraphs.
- Be WARM and HUMAN — not robotic or stiff.
- Use emojis sparingly (1-2 per message max).
- Address user by name occasionally if you know it — not every message.
- Mirror the user's energy: casual if they're casual, focused if they're task-oriented.

## WHAT ${APP.NAME} CAN DO (feature list)
1. ⏰ Reminders — "kal 5 bje yaad dilana" or "remind me every Sunday 9am"
2. 📋 Lists/Tasks — "grocery mein milk add karo" or "shopping list dikhao"
3. 📁 Documents — "mera aadhar dikhao" or send any photo/PDF to save it
4. 🌅 Morning Briefing — "aaj ka summary" → daily 9AM recap
5. 💬 General Questions — recipes, facts, advice — anything!

## CONVERSATIONAL CUES (STRICT)
- "done", "ok", "okay", "thanks", "dhanyawad", "shukriya" → reply warmly & briefly: "Bilkul! Aur kuch chahiye? 😊"
- "hi", "hello", "hey", "namaste" → greet warmly, ask how to help. NEVER send the help menu for greetings.
- Complaints, sarcasm ("kish ne bola", "bro tu kya kr rha hai") → respond calmly and warmly, offer help
- "kya kar sakte ho", "what can you do", "features" → briefly list features
- If user seems confused or frustrated → be extra warm and patient, NOT robotic
- DO NOT send the full HELP menu unless explicitly asked for it

## STRICT RULES (NEVER VIOLATE)
1. NEVER claim actions were completed (set/add/save/delete/done) unless this exact turn confirms a completed tool action.
2. NEVER invent list/task/reminder/document state. Do not say a list exists, is empty, or has items unless explicitly provided in context.
3. If user asks to do an action but no action was executed, give command-style guidance only (example phrasing), not a completion confirmation.
4. NEVER say "I don't have access to real-time data" — just answer from knowledge.
5. NEVER reveal you are an AI model or mention "training data", "language model", "GPT", etc.
6. Keep replies short and natural (1-3 lines). No long explanations.
7. If outside ${APP.NAME}'s features, respond helpfully in-character without pretending data operations happened.

## ABUSE MANAGEMENT
- If abusive language detected → calmly redirect: "Main yahan professionally help karne ke liye hoon! Kuch kaam karna hai? 😊"
- Do NOT repeat or engage with abusive words.
`.trim()

/** Strip AI self-reference phrases that would break the persona */
const FORBIDDEN_AI_PHRASE_PATTERN =
  /knowledge base|training data|I was trained|my dataset|as an AI language model|as a large language model|ChatGPT|OpenAI|Anthropic|Claude/gi

// ─── Supabase Client ──────────────────────────────────────────

const supabase = getSupabaseClient()

// ─── Types ────────────────────────────────────────────────────

export type { AutoResponseResult }

interface PhoneConfig {
  systemPrompt: string
  authToken: string
  origin: string
}

interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

interface GenerateLlmReplyParams {
  systemPrompt: string
  history: HistoryMessage[]
  userText: string
  documentContext?: string
}

// ─── Pure Helpers ─────────────────────────────────────────────

function normalizePhone(value: string): string {
  return value.replace(/\D/g, '')
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.substring(0, maxLength)}…` : text
}

/**
 * Merges ZARA base rules with optional per-phone custom prompt and doc context.
 * ORDER: base rules → custom persona → doc context
 */
function buildSystemPrompt(customPrompt?: string | null, documentContext?: string | null): string {
  const parts: string[] = [ZARA_BASE_RULES]

  if (customPrompt?.trim()) {
    parts.push(`\n## ADDITIONAL PERSONA / BUSINESS CONTEXT\n${customPrompt.trim()}`)
  }

  if (documentContext?.trim()) {
    const safeDoc = truncate(documentContext.trim(), MAX_RAG_CHARS)
    parts.push(
      `\n## RELEVANT DOCUMENT CONTEXT (use this to answer the user's question accurately)\n${safeDoc}\n\nAnswer naturally from this context — don't say "according to the document".`
    )
  }

  return parts.join('\n')
}

// ─── Supabase Helpers ─────────────────────────────────────────

async function claimMessageForProcessing(messageId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('whatsapp_messages')
      .update({ is_responded: true, response_sent_at: new Date().toISOString() })
      .eq('message_id', messageId)
      .eq('is_responded', false)

    return !error
  } catch {
    return false
  }
}

async function releaseMessageClaim(messageId: string): Promise<void> {
  try {
    await supabase
      .from('whatsapp_messages')
      .update({ is_responded: false, response_sent_at: null })
      .eq('message_id', messageId)
  } catch {
    // Silent — best-effort
  }
}

async function hasRecentOutgoingMessage(toPhone: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - APP.RECENT_OUTGOING_WINDOW_MS).toISOString()
  try {
    const { count } = await supabase
      .from('whatsapp_messages')
      .select('*', { count: 'exact', head: true })
      .eq('from_number', toPhone)
      .eq('event_type', 'MtMessage')
      .gte('received_at', windowStart)

    return (count ?? 0) > 0
  } catch {
    return false
  }
}

async function fetchPhoneConfig(toPhone: string): Promise<PhoneConfig> {
  try {
    const { data } = await supabase
      .from('phone_document_mapping')
      .select('system_prompt, auth_token, origin')
      .eq('phone_number', toPhone)
      .limit(1)
      .single()

    return {
      systemPrompt: safeString(data?.system_prompt),
      authToken:    safeString(data?.auth_token) || WHATSAPP_AUTH_TOKEN,
      origin:       safeString(data?.origin)     || WHATSAPP_ORIGIN,
    }
  } catch {
    return {
      systemPrompt: '',
      authToken:    WHATSAPP_AUTH_TOKEN,
      origin:       WHATSAPP_ORIGIN,
    }
  }
}

/**
 * Fetches conversation history — prefers session context (faster, consistent)
 * over raw DB. Falls back to DB if session unavailable.
 */
async function fetchConversationHistory(
  userId?: string,
  fromPhone?: string
): Promise<HistoryMessage[]> {
  // 1. Try session context first
  if (userId) {
    try {
      const ctx = await getContext(userId)
      const sessionHistory = (ctx?.conversation_history ?? []) as Array<{
        role: string
        content: string
      }>
      if (sessionHistory.length > 0) {
        return sessionHistory
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({
            role: m.role as 'user' | 'assistant',
            content: truncate(safeString(m.content), APP.MAX_PER_MESSAGE_LENGTH),
          }))
          .slice(-APP.CONVERSATION_HISTORY_LIMIT)
      }
    } catch {
      // Fall through to DB
    }
  }

  // 2. Fallback: fetch from DB
  if (!fromPhone) return []

  try {
    const windowStart = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() // last 6h
    const { data } = await supabase
      .from('whatsapp_messages')
      .select('event_type, content_text, received_at')
      .or(`from_number.eq.${fromPhone},to_number.eq.${fromPhone}`)
      .gte('received_at', windowStart)
      .order('received_at', { ascending: true })
      .limit(20)

    const messages: HistoryMessage[] = []
    let lastKey = ''

    for (const row of data ?? []) {
      if (
        typeof row.content_text !== 'string' ||
        !row.content_text.trim() ||
        (row.event_type !== 'MoMessage' && row.event_type !== 'MtMessage')
      ) continue

      const role: 'user' | 'assistant' = row.event_type === 'MoMessage' ? 'user' : 'assistant'
      const content = truncate(safeString(row.content_text), APP.MAX_PER_MESSAGE_LENGTH)
      const key = `${role}:${content}`

      if (key !== lastKey) {
        messages.push({ role, content })
        lastKey = key
      }
    }

    return messages.slice(-APP.CONVERSATION_HISTORY_LIMIT)
  } catch (err) {
    console.warn('[autoResponder] fetchConversationHistory failed:', (err as Error).message)
    return []
  }
}

// ─── LLM Call ─────────────────────────────────────────────────

async function generateLlmReply(params: GenerateLlmReplyParams): Promise<string | null> {
  const { systemPrompt, history, userText, documentContext } = params

  const finalUserContent = documentContext
    ? `${userText}\n\n[Relevant context has been provided in the system prompt — use it to answer accurately.]`
    : userText

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
    console.warn('[autoResponder] LLM call timed out after', LLM_TIMEOUT_MS, 'ms')
  }, LLM_TIMEOUT_MS)

  try {
    const completion = await getGroqClient().chat.completions.create(
      {
        model: AI_MODELS.AUTO_RESPONDER,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: finalUserContent },
        ],
        temperature: GROQ_TEMPERATURE,
        max_tokens:  APP.MAX_REPLY_TOKENS,
      },
      { signal: controller.signal }
    )

    const raw = completion.choices[0]?.message?.content?.trim()
    if (!raw || raw.length < 2) return null

    return raw
      .replace(FORBIDDEN_AI_PHRASE_PATTERN, 'available information')
      .trim()

  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Static fallback reply when LLM fails — warm, in-character.
 * Avoids dead silence (worst UX possible).
 */
function getFallbackReply(userMessage: string): string {
  const lower = userMessage.toLowerCase().trim()

  if (['hi', 'hello', 'hey', 'hii', 'hlo', 'helo', 'namaste', 'namaskar', 'kem cho'].includes(lower)) {
    return 'Hey! 👋 Kaise madad karoon aapki?'
  }
  if (/\b(abhi\s*nahi|abhi\s*nahin|not\s*now|later|baad\s*mein|baadme)\b/i.test(lower)) {
    return 'Theek hai, jab chahiye bol dena 😊'
  }
  if (['done', 'ok', 'okay', 'k', 'thanks', 'thank you', 'thnx', 'thx', 'shukriya', 'dhanyawad', 'wow', 'good', 'great', 'nice', 'perfect', 'bilkul', 'acha', 'accha'].includes(lower)) {
    return 'Bilkul! Aur kuch chahiye toh batao 😊'
  }

  return '😕 Abhi thodi mushkil aa rahi hai. Thodi der mein fir try karein!\n\n_"help" likhein available features dekhne ke liye._'
}

// ─── Main Export ──────────────────────────────────────────────

export async function generateAutoResponse(
  fromNumber:       string,
  toNumber:         string,
  messageText:      string,
  messageId:        string,
  userId?:          string,
  documentContext?: string,
): Promise<AutoResponseResult> {
  try {
    console.log('[autoResponder] Triggered for messageId:', messageId)

    if (!fromNumber || !toNumber || !messageId) {
      return { success: false, error: 'Missing required parameters' }
    }

    const cleanFrom = normalizePhone(fromNumber)
    const cleanTo   = normalizePhone(toNumber)

    if (cleanFrom.length < APP.MIN_PHONE_LENGTH || cleanTo.length < APP.MIN_PHONE_LENGTH) {
      return { success: false, error: 'Invalid phone numbers' }
    }

    const userText = safeString(messageText)
    if (!userText) {
      return { success: false, error: 'Empty message — nothing to respond to' }
    }

    // ── Atomic idempotency claim ──────────────────────────────
    const claimed = await claimMessageForProcessing(messageId)
    if (!claimed) {
      console.log('[autoResponder] Duplicate or already claimed:', messageId)
      return { success: true, response: 'Duplicate prevention', sent: false }
    }

    // ── Suppress double-replies ───────────────────────────────
    if (await hasRecentOutgoingMessage(cleanFrom)) {
      console.log('[autoResponder] Recent outgoing — releasing claim and skipping')
      await releaseMessageClaim(messageId)
      return { success: true, response: 'Safety skip — recent reply detected', sent: false }
    }

    const safeUserText = truncate(userText, APP.MAX_MESSAGE_LENGTH)
    console.log('[autoResponder] From:', cleanFrom, '| To:', cleanTo)

    const [phoneConfig, history] = await Promise.all([
      fetchPhoneConfig(cleanTo),
      fetchConversationHistory(userId, cleanFrom),
    ])

    if (!phoneConfig.authToken || !phoneConfig.origin) {
      console.error('[autoResponder] WhatsApp credentials missing for:', cleanTo)
      await releaseMessageClaim(messageId)
      return { success: false, error: 'WhatsApp API credentials not configured' }
    }

    const systemPrompt = buildSystemPrompt(phoneConfig.systemPrompt, documentContext)
    console.log('[autoResponder] History length:', history.length, '| Has doc context:', !!documentContext)

    // ── LLM call with timeout ─────────────────────────────────
    let reply: string | null
    try {
      reply = await generateLlmReply({ systemPrompt, history, userText: safeUserText, documentContext })
      console.log('[autoResponder] LLM response:', reply ? `"${reply.substring(0, 80)}…"` : 'EMPTY')
    } catch (llmErr: unknown) {
      const isAbort = llmErr instanceof Error && llmErr.name === 'AbortError'
      console.error('[autoResponder] LLM error:', isAbort ? 'Timed out' : (llmErr as Error).message)
      await releaseMessageClaim(messageId)

      // Send warm fallback instead of silence
      const fallback = getFallbackReply(safeUserText)
      await sendWhatsAppMessage({
        to: cleanFrom,
        message: fallback,
        authToken: phoneConfig.authToken,
        origin: phoneConfig.origin,
      })
      return {
        success: false,
        response: fallback,
        sent: true,
        error: isAbort ? 'AI response timed out' : 'AI generation failed',
      }
    }

    // ── Use fallback if LLM returned empty ────────────────────
    if (!reply) {
      console.warn('[autoResponder] LLM returned empty — using fallback reply')
      reply = getFallbackReply(safeUserText)
    }

    // ── HARD FILTER: Block hallucinated action confirmations ──────
    const isHindi = /\b(hai|karo|karna|mein|meri|mujhe|chahiye|chahte|bolo|bola|kya)\b/i.test(safeUserText)
    if (reply) {
      const isHallucination = HALLUCINATION_PATTERNS.some(pattern => pattern.test(reply!))
      if (isHallucination) {
        console.warn('[autoResponder] Blocked hallucinated action confirmation:', reply.substring(0, 80))
        reply = isHindi
          ? 'Bas aisa bolo: "grocery mein milk add karo" ya "task mein meeting add karo" — main turant kar dungi! 😊'
          : 'Just say something like "add milk to grocery" or "add meeting to task list" — I\'ll do it right away! 😊'
      }
    }

    // ── Send ──────────────────────────────────────────────────
    const sendResult = await sendWhatsAppMessage({
      to: cleanFrom,
      message: reply,
      authToken: phoneConfig.authToken,
      origin: phoneConfig.origin,
    })

    if (!sendResult.success) {
      console.error('[autoResponder] WhatsApp send failed:', sendResult.error)
      await releaseMessageClaim(messageId)
      return { success: false, response: reply, sent: false, error: 'WhatsApp send failed' }
    }

    console.log('[autoResponder] ✅ Response sent for:', messageId)
    return { success: true, response: reply, sent: true }

  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && (err as { status?: number }).status === 429) {
      console.warn('[autoResponder] Groq rate limit hit (429)')
      return { success: false, error: 'AI service busy — please try again in a moment' }
    }

    console.error('[autoResponder] Unexpected error:', err)
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}
