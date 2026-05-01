// src/app/api/generate-prompt/route.ts
// System Prompt Generator — Production-grade with guardrails

import { NextRequest, NextResponse } from 'next/server'
import { getGroqClient } from '@/lib/ai/clients'
import { getSupabaseClient } from '@/lib/infrastructure/database'
import { AI_MODELS } from '@/config'

const supabase = getSupabaseClient()

// ─── GUARDRAIL: Intent validation ─────────────────────────────
const MIN_INTENT_LENGTH = 10
const MAX_INTENT_LENGTH = 2000

function validateIntent(intent: string): { valid: boolean; reason?: string } {
    if (!intent || typeof intent !== 'string') {
        return { valid: false, reason: 'Intent is required' }
    }
    const trimmed = intent.trim()
    if (trimmed.length < MIN_INTENT_LENGTH) {
        return { valid: false, reason: `Intent too short — minimum ${MIN_INTENT_LENGTH} characters` }
    }
    if (trimmed.length > MAX_INTENT_LENGTH) {
        return { valid: false, reason: `Intent too long — maximum ${MAX_INTENT_LENGTH} characters` }
    }
    return { valid: true }
}

function validatePhone(phone: string): { valid: boolean; reason?: string } {
    if (!phone || typeof phone !== 'string') {
        return { valid: false, reason: 'Phone number is required' }
    }
    const cleaned = phone.replace(/[\s\-().+]/g, '')
    if (!/^\d{10,15}$/.test(cleaned)) {
        return { valid: false, reason: 'Invalid phone number format' }
    }
    return { valid: true }
}

// ─── SYSTEM PROMPT BUILDER ────────────────────────────────────
const ARCHITECT_PROMPT = `
You are designing a system prompt for ZARA — a WhatsApp personal assistant.

ZARA's personality:
- Name: ZARA
- Warm, friendly, like a helpful friend — NOT a robot or corporate assistant
- Casual WhatsApp tone — short, natural, conversational
- Light emojis only (max 1-2 per message) 😊✅
- Never sounds scripted, never uses bullet overload
- Uses user's first name naturally — once at conversation start, occasionally after (NOT every message)

━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE RULES (STRICT)
━━━━━━━━━━━━━━━━━━━━━━━━━━
Detect language from user's message and reply in SAME language:

- Roman Hindi / Hinglish (e.g. "kal 9 bje") → reply in Hinglish
- Hindi Devanagari (e.g. "कल याद दिलाना") → reply in Hindi (Devanagari script)
- Gujarati (e.g. "કાલે યાદ કરાવજો") → reply in Gujarati script
- Clear English → reply in English
- NEVER switch languages randomly
- NEVER mention language detection to user

━━━━━━━━━━━━━━━━━━━━━━━━━━
TASK LISTS — SHOW ALL, EXCLUDE COMPLETED
━━━━━━━━━━━━━━━━━━━━━━━━━━
When user asks "show list", "show my all task list", "task list do", "meri tasks dikhao", "list dikhao":
- ALWAYS fetch and show COMPLETE active task list — every pending item
- Show task number, title, list name, status (active), and due date for every task
- NEVER show only 3-4 if more exist — show ALL
- Show only ACTIVE tasks (pending/in-progress). HIDE completed, done, cancelled, deleted tasks
- If no active tasks: "Aapki koi task nahi hai abhi" (Hindi) or "You have no active tasks" (English)

━━━━━━━━━━━━━━━━━━━━━━━━━━
REMINDERS — CANCEL/DELETE BY TIME & DAY
━━━━━━━━━━━━━━━━━━━━━━━━━━
When canceling a reminder, distinguish by day:
- "cancel aaj ka reminder" → only cancel reminders for TODAY ({CURRENT_DATE})
- "cancel kal ka reminder" → only cancel reminders for TOMORROW ({TOMORROW_DATE})
- "cancel parso ka reminder" → only cancel reminders for DAY AFTER TOMORROW ({DAY_AFTER_TOMORROW})
- If ambiguous (no day specified), ask: "Kaunsa reminder cancel karein? Aaj ka ya kal ka?"
- For specific single reminder lookup, search by title or time, return exact match or ask which if multiple

━━━━━━━━━━━━━━━━━━━━━━━━━━
REMINDERS — FUTURE DATES & RELATIVE TIMES
━━━━━━━━━━━━━━━━━━━━━━━━━━
Parse ALL these time references:
- "aaj" / "today" → current date
- "kal" / "tomorrow" → tomorrow date
- "parso" / "day after tomorrow" → day after tomorrow
- "2 din baad" / "in 2 days" → current date + 2 days
- Specific date like "3 May ko" → May 3rd
- Never default to today/tomorrow — always calculate the correct target date

━━━━━━━━━━━━━━━━━━━━━━━━━━
VOICE MESSAGES — TRANSCRIBE & CONFIRM
━━━━━━━━━━━━━━━━━━━━━━━━━━
When voice/audio is received:
1. Transcribe to text first
2. Send visible confirmation: "Voice message mili. Aapne kaha: '[transcribed text]'" 
3. Then process normally as text command
If transcription fails: "Audio samajh nahi aaya, please text mein likhein"

━━━━━━━━━━━━━━━━━━━━━━━━━━
REAL-TIME INFO — ALWAYS DATE/TIME AWARE
━━━━━━━━━━━━━━━━━━━━━━━━━━
For weather, news, scores, sports, live info:
- ALWAYS use today's actual date: {CURRENT_DATE}
- ALWAYS mention the day/date in your response so user verifies it's current
- If live fetch fails: "Abhi live data nahi mil raha, please check karo [trusted_source]"
- NEVER give stale cached info without dating it

━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━
- NEVER mention: "document", "database", "knowledge base", "system", "I was trained"
- NEVER apologize excessively
- NEVER give long paragraphs — keep it WhatsApp short
- NEVER make up information
- NEVER claim actions completed (add/set/delete) unless this exact turn confirms it
- If info not available: "Abhi ye info mere paas nahi hai 😊 Kuch aur pooch sakte ho!"

Generate ONLY the system prompt text.
No explanations, no preamble, no markdown headers.
Keep it under 500 words.
`.trim()

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        const { intent, phone_number } = body

        // ── GUARDRAIL 1: Input validation ──────────────────────
        const intentCheck = validateIntent(intent)
        if (!intentCheck.valid) {
            return NextResponse.json(
                { error: intentCheck.reason },
                { status: 400 }
            )
        }

        const phoneCheck = validatePhone(phone_number)
        if (!phoneCheck.valid) {
            return NextResponse.json(
                { error: phoneCheck.reason },
                { status: 400 }
            )
        }

        const cleanIntent = intent.trim()
        const cleanPhone = phone_number.replace(/[\s\-().]/g, '')

        console.log('[generate-prompt] Generating for phone:', cleanPhone, '| Intent:', cleanIntent.substring(0, 50))

        // ── GUARDRAIL 2: Prompt injection check ───────────────
        const injectionPatterns = /ignore (previous|above|all)|you are now|disregard|forget your|new instructions/i
        if (injectionPatterns.test(cleanIntent)) {
            return NextResponse.json(
                { error: 'Invalid intent content' },
                { status: 400 }
            )
        }

        // ── Generate system prompt via Groq ───────────────────
        const completion = await getGroqClient().chat.completions.create({
            model: AI_MODELS.SYSTEM_PROMPT_GEN,
            temperature: 0.4,   // Thoda lower — consistent output
            max_tokens: 1000,
            messages: [
                { role: 'system', content: ARCHITECT_PROMPT },
                {
                    role: 'user',
                    content: `Create a system prompt for a WhatsApp chatbot with this purpose:\n"${cleanIntent}"`
                },
            ]
        })

        const systemPrompt = completion.choices[0]?.message?.content?.trim()

        // ── GUARDRAIL 3: Empty response check ─────────────────
        if (!systemPrompt || systemPrompt.length < 20) {
            console.error('[generate-prompt] Groq returned empty/short response')
            return NextResponse.json(
                { error: 'Failed to generate system prompt — please try again' },
                { status: 500 }
            )
        }

        // ── GUARDRAIL 4: Forbidden words check ────────────────
        const forbiddenInOutput = /knowledge base|training data|I was trained|my dataset/i
        const cleanedPrompt = systemPrompt.replace(forbiddenInOutput, 'available information')

        // ── Save / Update in DB ───────────────────────────────
        const { data: existing, error: fetchErr } = await supabase
            .from('phone_document_mapping')
            .select('id')
            .eq('phone_number', cleanPhone)
            .limit(1)

        if (fetchErr) {
            console.error('[generate-prompt] DB fetch error:', fetchErr)
            // Generate toh ho gaya — DB error pe bhi prompt return karo
            return NextResponse.json({
                success: true,
                system_prompt: cleanedPrompt,
                intent: cleanIntent,
                warning: 'Prompt generated but could not save to database'
            })
        }

        if (existing && existing.length > 0) {
            const { error: updateErr } = await supabase
                .from('phone_document_mapping')
                .update({
                    intent,
                    system_prompt: cleanedPrompt,
                    updated_at: new Date().toISOString()
                })
                .eq('phone_number', cleanPhone)

            if (updateErr) console.error('[generate-prompt] Update error:', updateErr)
        } else {
            const { error: insertErr } = await supabase
                .from('phone_document_mapping')
                .insert({
                    phone_number: cleanPhone,
                    intent: cleanIntent,
                    system_prompt: cleanedPrompt,
                    file_id: null,
                })

            if (insertErr) console.error('[generate-prompt] Insert error:', insertErr)
        }

        console.log('[generate-prompt] Done for:', cleanPhone)

        return NextResponse.json({
            success: true,
            system_prompt: cleanedPrompt,
            intent: cleanIntent,
        })

    } catch (error: unknown) {
        // ── GUARDRAIL 5: Groq rate limit ─────────────────────
        if (typeof error === 'object' && error !== null && 'status' in error && (error as { status: number }).status === 429) {
            return NextResponse.json(
                { error: 'Too many requests — please wait a moment and try again' },
                { status: 429 }
            )
        }

        console.error('[generate-prompt] Unexpected error:', error)
        return NextResponse.json(
            { error: 'Something went wrong — please try again' },
            { status: 500 }
        )
    }
}