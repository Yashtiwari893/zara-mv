# 11za Personal Assistant — WhatsApp Assistant by 11za

> Reminders, Lists, Document Vault, AI Chat — sab kuch WhatsApp pe. Hindi, English, Gujarati etc.

## Architecture

```
┌────────────────────┐     ┌──────────────┐     ┌──────────────┐
│   WhatsApp User    │────▶│  11za API    │────▶│  Vercel Edge │
│  (Hindi/Eng/Guj)   │◀────│  (Gateway)   │◀────│  (Next.js)   │
└────────────────────┘     └──────────────┘     └──────┬───────┘
                                                       │
                              ┌─────────────────────────┤
                              ▼                         ▼
                     ┌──────────────┐          ┌──────────────┐
                     │   Supabase   │          │   Groq AI    │
                     │  (Postgres)  │          │ (LLaMA 3.3)  │
                     └──────────────┘          └──────────────┘
```

## Features

| Feature | Description |
|---------|-------------|
| ⏰ Smart Reminders | "Kal 5 bje yaad dilana" — one-time, recurring, multi-reminder |
| 📋 Lists & Tasks | Grocery, office, shopping — multi-item add, complete, delete |
| 📁 Document Vault | Send photo/PDF → saved. "Mera aadhar dikhao" → retrieved |
| 🌅 Morning Briefing | Daily 9 AM summary of pending tasks & reminders |
| 🎙️ Voice Notes | Send voice → transcribed → processed as text command |
| 💬 AI Chat | General questions, recipes, advice — 24/7 |
| 🌐 Multilingual | Hindi, English, Gujarati — auto-detected |

## Tech Stack

- **Framework**: Next.js 16 (App Router, Vercel Serverless)
- **Database**: Supabase (PostgreSQL + Storage + Auth)
- **AI**: Groq (LLaMA 3.3 70B + Whisper STT)
- **WhatsApp**: 11za API Gateway
- **Embeddings**: Mistral AI
- **Storage**: Supabase Storage + Google Drive (optional)

## Quick Start

### 1. Clone & Install

```bash
git clone <repo-url>
cd zara2
npm install
```

### 2. Environment Setup

```bash
cp .env.example .env.local
# Fill in all required values
```

### 3. Database Setup

Run the migration in Supabase SQL Editor:

```bash
# Copy contents of migrations/MASTER_SCHEMA.sql
# Paste into Supabase SQL Editor → Run
```

### 4. Run Locally

```bash
npm run dev
```

### 5. Deploy to Vercel

```bash
vercel --prod
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/webhook/whatsapp` | POST/GET | 11za webhook (main entry point) |
| `/api/health` | GET | Health check for all dependencies |
| `/api/cron/reminders` | GET/POST | Process due reminders (every minute) |
| `/api/cron/briefing` | GET/POST | Send morning briefings (9 AM IST) |
| `/api/whatsapp/auto-respond` | POST | Manual auto-responder trigger |
| `/api/generate-system-prompt` | POST | AI system prompt generator |
| `/api/auth/google` | GET | Google OAuth flow start |
| `/api/auth/google/callback` | GET | Google OAuth callback |
| `/api/reminders/trigger` | POST | Manual reminder trigger |

## Cron Jobs (cronsjob.org)

Set these URLs in [cronsjob.org](https://cronsjob.org):

| Job | URL | Schedule | Method |
|-----|-----|----------|--------|
| Reminders | `https://your-domain.vercel.app/api/cron/reminders?secret=YOUR_CRON_SECRET` | Every 1 minute | GET |
| Morning Briefing | `https://your-domain.vercel.app/api/cron/briefing?secret=YOUR_CRON_SECRET` | `30 3 * * *` (9:00 AM IST) | GET |

> Replace `YOUR_CRON_SECRET` with the value from your `.env.local`

## Environment Variables

See `.env.example` for complete list. Critical ones:

- `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — Database
- `GROQ_API_KEY` — AI (intent, date parsing, chat, STT)
- `WHATSAPP_AUTH_TOKEN` / `WHATSAPP_ORIGIN` — 11za WhatsApp
- `CRON_SECRET` — Secure cron endpoints
- `WEBHOOK_VERIFY_TOKEN` — WhatsApp webhook verification

## Production Checklist

- [ ] All env vars set in Vercel dashboard
- [ ] Supabase schema migrated (MASTER_SCHEMA.sql)
- [ ] `due_reminders_view` created in Supabase
- [ ] `users_due_for_briefing` view created
- [ ] `get_or_create_list` RPC function created
- [ ] Webhook URL registered in 11za dashboard
- [ ] Cron jobs verified in Vercel dashboard
- [ ] Health check returns `healthy`: `/api/health`
- [ ] Test webhook with sample message

## License

Proprietary — Engees Communications Pvt Ltd
