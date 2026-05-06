// src/lib/whatsapp/templates.ts
// WhatsApp Message Templates — Clean, correct, multilingual (EN / HI / GU)
// v2.0 — Professional Edition: complete Gujarati, consistent tone, improved copy

import type { Language } from '@/types'
import { APP } from '@/config'
export type { Language }

// ─── ONBOARDING ───────────────────────────────────────────────

export function welcomeMessage(name?: string | null): string {
  const greeting = name ? `Hey ${name}!` : 'Hey!'
  return `${greeting} 👋 I'm *${APP.NAME}* — your personal assistant on WhatsApp by 11za.\n\nYou can message or send voice notes in *any language* — Hindi, English, Gujarati — and I'll understand! 😊`
}

export function onboardingComplete(name: string, lang: Language): string {
  const displayName = name && name !== 'there' ? `, ${name}` : ''
  const msgs: Record<Language, string> = {
    en: `All set${displayName}! 🎉\n\nHere's what you can try:\n⏰ _"Remind me to call mom at 6pm"_\n🛒 _"Add milk to grocery list"_\n📄 _Send any photo or PDF to save it_\n💬 _Or just ask me anything!_`,
    hi: `तैयार हूं${displayName}! 🎉\n\nइन्हें try करें:\n⏰ _"शाम 6 बजे mama को call याद दिलाना"_\n🛒 _"Grocery में दूध add करो"_\n📄 _कोई भी photo या PDF भेजो_\n💬 _कुछ भी पूछो!_`,
    gu: `તૈયાર છું${displayName}! 🎉\n\nআজমাવો:\n⏰ _"સાંજે 6 વાગ્યે mama ને call yaad apavo"_\n🛒 _"Grocery ma dudh add karo"_\n📄 _Koi pan photo ya PDF moklo save karva_\n💬 _Kai pan pucho!_`,
  }
  return msgs[lang]
}

// ─── REMINDERS ────────────────────────────────────────────────

export function reminderSet(title: string, humanReadable: string, lang: Language): string {
  const msgs: Record<Language, string> = {
    en: `⏰ *Reminder set!*\n\n📝 ${title}\n🕐 ${humanReadable}\n\n_I'll notify you then!_`,
    hi: `⏰ *रिमाइंडर सेट!*\n\n📝 ${title}\n🕐 ${humanReadable}\n\n_Pakka yaad dilaaungi!_`,
    gu: `⏰ *રિમાઇન્ડર સેટ!*\n\n📝 ${title}\n🕐 ${humanReadable}\n\n_Tyare yaad apavish!_`,
  }
  return msgs[lang]
}

export function reminderAlert(title: string, note: string | null, lang: Language): string {
  const noteText = note ? `\n📌 ${note}` : ''
  const msgs: Record<Language, string> = {
    en: `⏰ *Reminder*\n\n📝 ${title}${noteText}`,
    hi: `⏰ *Reminder*\n\n📝 ${title}${noteText}`,
    gu: `⏰ *રિમાઇન્ડર*\n\n📝 ${title}${noteText}`,
  }
  return msgs[lang]
}

export function reminderSnoozed(humanReadable: string, lang: Language): string {
  const msgs: Record<Language, string> = {
    en: `⏰ *Snoozed!*\n\n_I'll remind you at ${humanReadable}_`,
    hi: `⏰ *Snooze ho gaya!*\n\n_${humanReadable} par yaad dilaaungi_`,
    gu: `⏰ *Snooze thayu!*\n\n_${humanReadable} vage yaad apavish_`,
  }
  return msgs[lang]
}

export function reminderList(
  reminders: Array<{ title: string; scheduledAt: Date; recurrence?: string | null }>,
  lang: Language
): string {
  if (reminders.length === 0) {
    const empty: Record<Language, string> = {
      en: '📭 You have no pending reminders.',
      hi: '📭 Abhi koi pending reminder nahi hai.',
      gu: '📭 કોઈ pending reminder નથી.',
    }
    return empty[lang]
  }

  const header: Record<Language, string> = {
    en: '⏰ *Your Reminders:*',
    hi: '⏰ *Aapke Reminders:*',
    gu: '⏰ *Aapna Reminders:*',
  }

  const items = reminders.map((r, i) => {
    const time = r.scheduledAt.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    })
    const recurTag = r.recurrence ? ` _(${r.recurrence})_` : ''
    return `${i + 1}. *${r.title}*${recurTag}\n    📅 ${time}`
  }).join('\n\n')

  return `${header[lang]}\n\n${items}`
}

// ─── TASKS ────────────────────────────────────────────────────

export function taskAdded(content: string, listName: string, lang: Language): string {
  const msgs: Record<Language, string> = {
    en: `✅ Added *${content}* to your *${listName}* list!`,
    hi: `✅ *${content}* ko *${listName}* list mein add kar diya!`,
    gu: `✅ *${content}* ne *${listName}* list ma add karyu!`,
  }
  return msgs[lang]
}

export function taskList(
  listName: string,
  tasks: Array<{ content: string; completed: boolean }>,
  lang: Language
): string {
  const pending = tasks.filter(t => !t.completed)
  const done    = tasks.filter(t => t.completed)

  const header: Record<Language, string> = {
    en: `📋 *${listName} List*`,
    hi: `📋 *${listName} List*`,
    gu: `📋 *${listName} List*`,
  }

  const nothingPending: Record<Language, string> = {
    en: '_Nothing pending_ ✨',
    hi: '_Kuch pending nahi hai_ ✨',
    gu: '_Koi baki nathi_ ✨',
  }

  const pendingItems = pending.length > 0
    ? pending.map(t => `☐ ${t.content}`).join('\n')
    : nothingPending[lang]

  const doneItems = done.length > 0
    ? '\n\n' + done.map(t => `✅ ~${t.content}~`).join('\n')
    : ''

  return `${header[lang]}\n\n${pendingItems}${doneItems}`
}

export function taskCompleted(content: string, lang: Language): string {
  const msgs: Record<Language, string> = {
    en: `✅ *${content}* marked as done!`,
    hi: `✅ *${content}* complete ho gaya!`,
    gu: `✅ *${content}* purn thayu!`,
  }
  return msgs[lang]
}

// ─── DOCUMENTS ────────────────────────────────────────────────

export function documentSaved(label: string, lang: Language): string {
  const msgs: Record<Language, string> = {
    en: `📁 *Saved as "${label}"!*\n\n_Say "${label} dikhao" anytime to get it back._`,
    hi: `📁 *"${label}" ke naam se save ho gaya!*\n\n_"${label} dikhao" bolke wapas paa sakte ho._`,
    gu: `📁 *"${label}" tarike save thayu!*\n\n_"${label} dikhao" boli ne pachi malo._`,
  }
  return msgs[lang]
}

export function documentNotFound(query: string, lang: Language): string {
  const msgs: Record<Language, string> = {
    en: `🔍 No document found for "*${query}*".\n\nSend me a photo or PDF to save it!`,
    hi: `🔍 "*${query}*" se koi document nahi mila.\n\nKoi photo ya PDF bhejo save karne ke liye!`,
    gu: `🔍 "*${query}*" mate koi document nathi malyo.\n\nKoi photo ya PDF moklo save karva!`,
  }
  return msgs[lang]
}

// ─── MORNING BRIEFING ─────────────────────────────────────────

export function morningBriefing(
  name: string,
  pendingTasks: number,
  todayReminders: number,
  lang: Language
): string {
  const msgs: Record<Language, string> = {
    en: `🌅 *Good Morning, ${name}!*\n\nHere's your day:\n\n📋 Tasks: *${pendingTasks} pending*\n⏰ Reminders: *${todayReminders} today*\n\n_Have a great day!_ ☀️`,
    hi: `🌅 *सुप्रभात, ${name}!*\n\nआज का summary:\n\n📋 Tasks: *${pendingTasks} pending*\n⏰ Reminders: *${todayReminders} aaj*\n\n_Shubh din ho!_ ☀️`,
    gu: `🌅 *Suprabhat, ${name}!*\n\nAaj no summary:\n\n📋 Tasks: *${pendingTasks} pending*\n⏰ Reminders: *${todayReminders} aaj*\n\n_Shubh din!_ ☀️`,
  }
  return msgs[lang]
}

// ─── HELP / MENU ──────────────────────────────────────────────

export function helpMessage(lang: Language): string {
  const msgs: Record<Language, string> = {
    en: `🤖 *Here's what I can do:*\n\n⏰ *Reminders*\n_"Remind me to call mom at 6pm"_\n_"Remind me every Sunday at 9am"_\n\n📋 *Lists & Tasks*\n_"Add milk to grocery list"_\n_"Show my grocery list"_\n_"Milk done"_\n\n📁 *Document Vault*\n_Send any photo or PDF → I'll save it_\n_"Show my aadhar"_\n\n🌅 *Morning Briefing*\n_Automatic daily at 9 AM_\n\n💬 *AI Chat*\n_Ask me anything!_`,

    hi: `🤖 *मैं क्या कर सकती हूं:*\n\n⏰ *Reminders*\n_"शाम 6 बजे मम्मी को call याद दिलाना"_\n_"हर Sunday 9am पर याद दिलाना"_\n\n📋 *Lists & Tasks*\n_"Grocery में दूध add करो"_\n_"मेरी grocery list दिखाओ"_\n_"दूध हो गया"_\n\n📁 *Document Vault*\n_कोई भी photo/PDF भेजो → save होगा_\n_"मेरा आधार दिखाओ"_\n\n💬 *AI Chat*\n_कुछ भी पूछो!_`,

    gu: `🤖 *Hu shu kari shakoo:*\n\n⏰ *Reminders*\n_"Sanje 6 vage mama ne call yaad apavo"_\n_"Har Sunday 9am e yaad apavo"_\n\n📋 *Lists & Tasks*\n_"Grocery ma dudh add karo"_\n_"Mari grocery list dikhao"_\n_"Dudh thai gayu"_\n\n📁 *Document Vault*\n_Koi pan photo ya PDF moklo → save thase_\n_"Maro aadhar dikhao"_\n\n💬 *AI Chat*\n_Kai pan pucho!_`,
  }
  return msgs[lang]
}

// ─── ERROR ────────────────────────────────────────────────────

export function errorMessage(lang: Language): string {
  const msgs: Record<Language, string> = {
    en: `😕 Something went wrong. Please try again!\n\nSay *"help"* to see what I can do.`,
    hi: `😕 Kuch gadbad ho gayi. Fir koshish karo!\n\n*"help"* likho to dekho main kya kar sakti hoon.`,
    gu: `😕 Koi takleef aayi. Fari try karo!\n\n*"help"* lakho shu kari shakoo te jovaa mate.`,
  }
  return msgs[lang]
}

// ─── GENERIC FALLBACK ─────────────────────────────────────────

export function unknownMessage(lang: Language): string {
  const msgs: Record<Language, string> = {
    en: `🤔 I didn't quite get that.\n\nSay *"help"* to see everything I can do!`,
    hi: `🤔 Mujhe samajh nahi aaya.\n\n*"help"* likho to dekho main kya kya kar sakti hoon!`,
    gu: `🤔 Mane samajh na padyu.\n\n*"help"* lakho to juo hu shu kari shakoo!`,
  }
  return msgs[lang]
}
