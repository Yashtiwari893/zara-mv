# ZARA System Prompt & Behavior Fixes — Implementation Summary

## Issues Resolved

This patch addresses 7 core issues reported in the ZARA BOT issues list.

---

## Issue 1: Task List — Not showing ALL tasks
**Problem:** User asks "show list" or "show all tasks", but only a generic list summary is returned.  
**Fix:** 
- Modified [src/lib/features/task.ts](src/lib/features/task.ts) to implement `handleListAllActiveTasks()` 
- Fetches ALL active (pending) tasks across all lists
- Excludes completed, cancelled, or deleted tasks
- Shows task #, title, list name, status, and due date for each item
- If no tasks: shows "Aapki koi task nahi hai abhi" (Hindi) or "You have no active tasks" (English)

**Code Changes:**
- Added `formatActiveTaskLines()` helper to structure task output
- Added `getNoTaskMessage()` for consistent empty-state text
- New `handleListAllActiveTasks()` function for generic list requests
- Routes generic `LIST_TASKS` intent to fetch complete active task list instead of list summary

---

## Issue 2: Reminders — Confusing cancellation without day clarity
**Problem:** User says "cancel kal ka reminder" but gets confused about which day or shows wrong reminder.  
**Fix:**
- Modified [src/lib/features/reminder.ts](src/lib/features/reminder.ts) to parse day scope
- Added `parseDayScope()` to extract today/tomorrow/parso from user message
- Added `isSameIstDay()` to filter reminders by calendar date
- Enhanced `handleListReminders()` to accept `dateTimeHint` and search by specific day
- Enhanced `handleCancelReminder()` to disambiguate by day before deleting
- Webhook now passes day context through reminder matching flow

**Code Changes:**
- Added reminder day-scope filtering (today/tomorrow/day-after-tomorrow)
- `handleListReminders()` now returns specific reminder when searched by time/title/day
- `handleCancelReminder()` asks for confirmation with day label
- Webhook: extended `PendingDelete` interface with `dateTimeHint` field

---

## Issue 3: Reminders — Not getting single reminder details
**Problem:** User says "mera 3 baje ka reminder" but only sees generic list.  
**Fix:**
- Enhanced `handleListReminders()` to detect specific reminder queries
- If user provides title hint or exact time, search and return ONLY that reminder
- If multiple match, list all matches and ask which one
- If no match: "Koi reminder nahi mila is description ke liye"

**Code Changes:**
- `handleListReminders()` now accepts `titleHint`, `dateTimeHint`, `rawQuery` parameters
- Filters by title and/or time window (±90 minutes) for matching
- Shows all matching reminders if ambiguous, shows single if exact match

---

## Issue 4: Tasks — Old/completed tasks showing in active list
**Problem:** User sees both old completed tasks AND new ones in task list display.  
**Fix:**
- Modified task list queries to filter `.eq('completed', false)`
- Only pending/active tasks are shown
- Completed, done, cancelled, or deleted tasks are excluded from output
- Clearing completed tasks is a separate explicit command

**Code Changes:**
- Updated `handleListTasks()` query to include `.eq('completed', false)`
- Updated `handleListAllActiveTasks()` to filter only active tasks
- Task formatter (`formatActiveTaskLines`) marks all as "active" status

---

## Issue 5: Reminders — Not parsing future date references
**Problem:** User says "parso" or "2 din baad" but reminder defaults to today/tomorrow.  
**Fix:**
- Modified [src/lib/ai/dateParser.ts](src/lib/ai/dateParser.ts) to recognize:
  - "parso" / "day after tomorrow" → day + 2
  - "X din baad" / "in X days" → day + X
  - Specific dates like "3 May ko"
- Enforces strict date calculation instead of defaulting to today/tomorrow

**Code Changes:**
- Added `dayMatch` regex for relative "in X days" parsing
- Added `.replace(/\b(day\s+after\s+tomorrow)\b/gi, 'parso')` normalization
- Updated ambiguity flags to include parso and relative date patterns
- Returns high-confidence date when explicit day + time provided

---

## Issue 6: Voice Messages — No user acknowledgment or proper failure handling
**Problem:** User sends audio but no confirmation shown; failures silently fallback to original message.  
**Fix:**
- Modified [src/app/api/webhook/whatsapp/route.ts](src/app/api/webhook/whatsapp/route.ts) to:
  - Send explicit confirmation: "Voice message mili. Aapne kaha: '[transcribed_text]'"
  - Fail gracefully if transcription fails: "Audio samajh nahi aaya, please text mein likhein"
  - Return early on failure instead of silent fallback

**Code Changes:**
- Added visible voice-message confirmation flow
- Changed voice-transcription error handling from silent fallback to user message
- Early return on audio processing failure to prevent double-processing

---

## Issue 7: Real-Time Info — Wrong/stale data without date context
**Problem:** User asks "today's weather" or "today's match" but gets yesterday's cached info or no date context.  
**Fix:**
- Updated auto-responder system prompt rules (both base and generator)
- Enforces: Always mention today's date ({CURRENT_DATE}) in weather/sports/news responses
- If live data unavailable: "Abhi live data nahi mil raha, please check karo [source]"
- Never present stale cached info as current

**Code Changes:**
- Updated `ZARA_BASE_RULES` in [src/lib/autoResponder.ts](src/lib/autoResponder.ts) with strict live-data rules
- Updated `ARCHITECT_PROMPT` in [src/app/api/generate-system-prompt/route.ts](src/app/api/generate-system-prompt/route.ts) with real-time context requirement
- Prompt generator now enforces date-stamping for all real-time queries

---

## Summary of Modified Files

1. **[src/lib/features/task.ts](src/lib/features/task.ts)** — Task list fetching and formatting
2. **[src/lib/features/reminder.ts](src/lib/features/reminder.ts)** — Reminder day-scope filtering and single-reminder lookup
3. **[src/app/api/webhook/whatsapp/route.ts](src/app/api/webhook/whatsapp/route.ts)** — Voice confirmation and reminder cancellation context
4. **[src/lib/infrastructure/sessionContext.ts](src/lib/infrastructure/sessionContext.ts)** — Extended `PendingDelete` with `dateTimeHint`
5. **[src/lib/ai/dateParser.ts](src/lib/ai/dateParser.ts)** — Enhanced future date parsing (parso, "in X days")
6. **[src/lib/autoResponder.ts](src/lib/autoResponder.ts)** — System prompt rules for live-data date-stamping
7. **[src/app/api/generate-system-prompt/route.ts](src/app/api/generate-system-prompt/route.ts)** — Architect prompt with issue-fix guidelines

---

## Testing Recommendations

### Issue 1 & 4 — Task List Completeness
```
User: "show list" or "meri tasks dikhao"
Expected: ALL active tasks across lists with number, title, list name, status, due date
Not: Old completed tasks or 3-4 sample items
```

### Issue 2 & 3 — Reminder Cancellation & Lookup
```
User: "cancel kal ka reminder" or "show 3 baje ka reminder"
Expected: Filter by day/time, show exact match or ask for clarification
Not: Show all reminders or cancel wrong day's reminder
```

### Issue 5 — Future Dates
```
User: "reminder set kar parso 5 baje" or "2 din baad yaad dilana"
Expected: Set reminder for correct future date
Not: Default to today or tomorrow
```

### Issue 6 — Voice Messages
```
User: [sends audio]
Expected: 
  1. "Voice message mili. Aapne kaha: '[transcription]'"
  2. Process as text command
  3. On failure: "Audio samajh nahi aaya..."
Not: Silent fallback or double-processing
```

### Issue 7 — Live Data
```
User: "today's weather" or "today ka match score"
Expected: Response mentions {CURRENT_DATE} and clearly identifies as today's data
Not: Stale cached info without date context
```

---

## Deployment Notes

- **No database schema changes** required
- **No new environment variables** needed
- **Type-safe**: All changes validated with TypeScript (no errors)
- **Backwards compatible**: Existing reminders/tasks unaffected
- **Graceful degradation**: Voice failures handled cleanly

This patch is ready for production deployment.
