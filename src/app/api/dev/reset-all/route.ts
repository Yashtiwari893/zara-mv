import { NextRequest, NextResponse } from "next/server"
import { getSupabaseClient } from "@/lib/infrastructure/database"

export const runtime = "nodejs"

const supabaseAdmin = getSupabaseClient()

export async function DELETE(req: NextRequest) {
  // SECURITY: Always require DEV_SECRET, even in development
  const devSecret = req.headers.get("x-dev-secret")
  if (!devSecret || devSecret !== process.env.DEV_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // SECURITY: Block in production unless explicitly overridden
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Disabled in production" }, { status: 403 })
  }

  try {
    // Clear session data
    const { error: sessErr } = await supabaseAdmin.from("sessions").delete().not("id", "is", null)
    if (sessErr) console.warn("[dev/reset] sessions:", sessErr.message)

    // Clear tasks
    const { error: taskErr } = await supabaseAdmin.from("tasks").delete().not("id", "is", null)
    if (taskErr) console.warn("[dev/reset] tasks:", taskErr.message)

    // Clear lists
    const { error: listErr } = await supabaseAdmin.from("lists").delete().not("id", "is", null)
    if (listErr) console.warn("[dev/reset] lists:", listErr.message)

    // Clear reminders
    const { error: remErr } = await supabaseAdmin.from("reminders").delete().not("id", "is", null)
    if (remErr) console.warn("[dev/reset] reminders:", remErr.message)

    // Clear documents metadata (not storage files)
    const { error: docErr } = await supabaseAdmin.from("documents").delete().not("id", "is", null)
    if (docErr) console.warn("[dev/reset] documents:", docErr.message)

    // Clear messages
    const { error: msgErr } = await supabaseAdmin.from("whatsapp_messages").delete().not("id", "is", null)
    if (msgErr) console.warn("[dev/reset] whatsapp_messages:", msgErr.message)

    return NextResponse.json({ success: true, message: "All user data reset (dev mode)" })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[dev/reset] Error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
