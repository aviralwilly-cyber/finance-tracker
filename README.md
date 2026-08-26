# AI Finance Tracker

A personal finance app where AI reads, extracts, and explains — but never calculates.

**Live:** [finance-tracker-pi-five-59.vercel.app](https://finance-tracker-pi-five-59.vercel.app)

> Hosted on free tiers. The backend sleeps after ~15 minutes of inactivity, so the first request may take up to a minute to wake it.

## Tech stack

| Layer | Tools |
|---|---|
| **Frontend** | React 18, Vite, Tailwind CSS, Framer Motion, Recharts, ogl (WebGL background) |
| **Backend** | Node.js, Express, Firebase Admin SDK |
| **Data & auth** | Firebase Auth + Firestore |
| **AI** | Groq (`gpt-oss-120b`) for categorization, chat, and extraction · Groq Vision for receipts · NVIDIA Nemotron via OpenRouter for agentic deep analysis |
| **Testing** | Vitest, GitHub Actions CI |
| **Hosting** | Vercel (frontend) · Render (backend) |

## Setup

### 1. Firebase

Create a project at [console.firebase.google.com](https://console.firebase.google.com), then:

1. **Authentication** → enable Email/Password
2. **Firestore Database** → create it
3. **Project settings → Service accounts** → Generate new private key → save as `backend/serviceAccountKey.json`
4. **Project settings → General → Your apps** → register a web app → paste the config into `frontend/src/firebase.js`

### 2. API keys

Both have free tiers and neither requires a card:

- **Groq** — [console.groq.com/keys](https://console.groq.com/keys) (required)
- **OpenRouter** — [openrouter.ai/keys](https://openrouter.ai/keys) (optional; only powers Deep Analysis)

### 3. Install and run

```bash
# one-time
cd backend && npm install && cp .env.example .env # add your keys to .env
cd ../frontend && npm install
cd .. && npm install

# every time
npm run dev
```

Frontend on `localhost:5173`, backend on `localhost:8080` (auto-restarts on save).

### 4. Optional

```bash
cd backend
npm test # 40 unit tests
npm run eval # categorization accuracy against 147 labeled transactions
```

**Admin panel:** set `role: "admin"` on your user document in Firestore, then log out and back in.

## Everyday use

- **Log an expense** — type it ("Starbucks 5.50 today"), speak it, snap a receipt, or upload a bank statement PDF. AI fills in the details; you confirm.
- **Import a statement** — every transaction gets auto-categorized so a raw statement turns into a spending breakdown.
- **Run a "what if"** — drag sliders on spending or income to see the effect on your savings projection before committing to a change.
- **Ask a money question** — Deep Analysis breaks down multi-step questions ("why am I saving less than last year?") and shows the numbers it used.
- **Share with a partner** — Household mode gives a combined view without exposing either person's full transaction history.

## Notes

- `backend/.env` and `backend/serviceAccountKey.json` are git-ignored. Never commit them.
- Firestore rules deny all direct client access — every read and write goes through the token-verified backend.
