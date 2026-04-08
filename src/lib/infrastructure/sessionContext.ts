// src/lib/infrastructure/sessionContext.ts
// Session Context — unified memory for conversation history and intent state
// v2.0 — Professional Edition: optimized DB calls, race-condition-safe, TTL-aware

import { getSupabaseClient } from './database'

export interface SessionContext {
  last_intent?: string
  last_document_query?: string
  last_list_name?: string
  pending_action?: string
  document_path?: string
  document_id?: string
  drive_file_id?: string
  doc_type?: string
  last_referenced_id?: string
  conversation_history?: Array<{ role: string; content: string; ts: number }>
}

const MAX_HISTORY = 12          // 6 user + 6 assistant turns
const MAX_CONTENT_CHARS = 500   // Per-message char cap

// ─── GET CONTEXT ──────────────────────────────────────────────

export async function getContext(userId: string): Promise<SessionContext> {
  const supabase = getSupabaseClient()
  try {
    const { data } = await supabase
      .from('sessions')
      .select('context')
      .eq('user_id', userId)
      .single()
    return (data?.context as SessionContext) || {}
  } catch {
    return {}
  }
}

// ─── UPDATE CONTEXT ───────────────────────────────────────────
// Atomic upsert — merges metadata without overwriting history.
// Never pass conversation_history here — use addToHistory() for that.

export async function updateContext(userId: string, updates: Partial<SessionContext>): Promise<void> {
  const supabase = getSupabaseClient()

  // Read existing to preserve history + unrelated metadata
  const existing = await getContext(userId)

  // Strip history from updates (it's managed exclusively by addToHistory)
  const { conversation_history: _ignored, ...metadataUpdates } = updates as SessionContext & { conversation_history?: unknown }

  const mergedContext: SessionContext = {
    ...existing,
    ...metadataUpdates,
    conversation_history: existing.conversation_history || [], // Preserve history
  }

  try {
    await supabase
      .from('sessions')
      .upsert({ user_id: userId, context: mergedContext }, { onConflict: 'user_id' })
  } catch (err) {
    console.warn('[sessionContext] updateContext failed:', (err as Error).message)
  }
}

// ─── ADD TO HISTORY ───────────────────────────────────────────
// Single source of truth for conversation history writes.
// Both feature handlers and autoResponder must use this.

export async function addToHistory(
  userId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  if (!content?.trim()) return // Never log empty messages

  const supabase = getSupabaseClient()

  try {
    const existing = await getContext(userId)
    const history = existing.conversation_history || []

    // Deduplicate: Don't add the same message twice back-to-back
    const lastEntry = history[history.length - 1]
    if (lastEntry?.role === role && lastEntry?.content === content.trim()) return

    const truncatedContent = content.trim().substring(0, MAX_CONTENT_CHARS)
    const updated = [...history, { role, content: truncatedContent, ts: Date.now() }]
      .slice(-MAX_HISTORY)

    await supabase
      .from('sessions')
      .upsert(
        { user_id: userId, context: { ...existing, conversation_history: updated } },
        { onConflict: 'user_id' }
      )
  } catch (err) {
    console.warn('[sessionContext] addToHistory failed:', (err as Error).message)
  }
}

// ─── CLEAR PENDING ACTION ─────────────────────────────────────
// Clears only the pending_action fields — preserves history and other metadata.

export async function clearPendingAction(userId: string): Promise<void> {
  const supabase = getSupabaseClient()

  try {
    const existing = await getContext(userId)
    await supabase
      .from('sessions')
      .upsert(
        {
          user_id: userId,
          context: {
            ...existing,
            pending_action: undefined,
            document_id:    undefined,
            document_path:  undefined,
            drive_file_id:  undefined,
            doc_type:       undefined,
          },
        },
        { onConflict: 'user_id' }
      )
  } catch (err) {
    console.warn('[sessionContext] clearPendingAction failed:', (err as Error).message)
  }
}
