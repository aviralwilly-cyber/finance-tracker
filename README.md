# 💰 AI Finance Tracker

![Tests](https://github.com/aviralwilly-cyber/finance-tracker/actions/workflows/test.yml/badge.svg)

A full-stack, multi-user personal finance app with AI woven throughout — automatic
transaction categorization, natural-language chat over your own data, AI-parsed bank
statement imports, and AI-narrated budget nudges — all built on top of deterministic,
auditable code for anything involving real numbers.

**Live stack:** React (Vite) · Tailwind CSS · Node/Express · Firebase (Auth + Firestore) · Groq API

---

## Features

### Transactions
- Manual entry, AI auto-categorization on every transaction
- Natural-language quick-add ("Starbucks 5.50 today")
- Search, category filter, month filter, pagination
- Recurring transactions (weekly/biweekly/monthly) that auto-generate on login
- PDF bank statement import — deterministic parser for known formats (currently
  Scotiabank Day-to-Day), AI-based extraction fallback for anything else, with a
  review-and-confirm screen before anything is saved (never auto-imports blindly)

### Income & savings
- Income entries with full history (a raise doesn't rewrite the past), monthly or
  biweekly with automatic monthly-equivalent conversion
- Savings/investments log (Savings, Investment, Retirement, Other), with a running
  "net worth" total
- Monthly trend chart comparing income vs. spending vs. saving over the last 6 months

### Budgets
- Per-category monthly limits with live progress bars
- AI-narrated nudge when a category crosses your configurable threshold — the math
  (percent used, which categories qualify) is deterministic; AI only writes the sentence

### AI chat
- Ask questions about your own transactions, income, and savings in plain English
- Persisted conversation history with context, so follow-up questions work
- Speech-to-text input

### Multi-user & personalization
- Firebase Auth (email/password), each user's data fully isolated in Firestore
- Onboarding sets your purpose (Personal / Business / Other), which changes your
  default category set
- Custom categories — add your own on top of the presets
- Reorderable, renameable sidebar navigation

### Settings
- Profile: name, purpose, phone number, avatar (upload-and-resize into Firestore, or
  pick from a built-in emoji set)
- Financial preferences: budget nudge threshold
- Account & security: change password/email, export all data as JSON, delete account
- App preferences: toggle the animated background, default landing tab, transactions
  per page

### UI
- Dark-mode-only design with an animated WebGL shader background (togglable)
- Collapsible sidebar, hide-on-scroll header
- Toast notifications, confirm dialogs on destructive actions, loading skeletons

---

## Tech stack

**Frontend:** React 18, Vite, Tailwind CSS, Framer Motion, Recharts, Lucide icons, `ogl` (WebGL)
**Backend:** Node.js, Express, Firebase Admin SDK, Groq SDK, Multer, `pdf-parse`
**Data:** Firebase Firestore (per-user subcollections), Firebase Auth
**AI:** Groq (`openai/gpt-oss-120b`) — categorization, chat, quick-add parsing, statement extraction, budget nudges

---

## Setup

### 1. Firebase (free)
1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
2. **Authentication** → Sign-in method → enable Email/Password
3. **Firestore Database** → Create database → test mode
4. **Project settings → Service accounts** → Generate new private key → save as
   `backend/serviceAccountKey.json`
5. **Project settings → General → Your apps** → register a web app → copy the config
   into `frontend/src/firebase.js`

### 2. Groq (free AI API)
Get a key at [console.groq.com/keys](https://console.groq.com/keys) — no card required.

### 3. Run it
```bash
# one-time setup
cd backend && npm install && cp .env.example .env   # paste your Groq key in
cd ../frontend && npm install
cd ..
npm install   # root — installs `concurrently`

# every time after that, from the project root:
npm run dev
# → backend on http://localhost:8080 (auto-restarts on save)
# → frontend on http://localhost:5173
```

Prefer separate terminals, or need to run just one side? That still works:
```bash
cd backend && npm run dev     # auto-restarts on save
cd frontend && npm run dev
```

---

## Project structure

```
backend/
  server.js          All API routes, AI prompts, deterministic parsers/helpers
  firestore.js       Firebase Admin (Firestore + Auth) initialization

frontend/src/
  App.jsx            Routes between Login / Onboarding / Dashboard based on auth state
  Login.jsx          Sign in / sign up
  Onboarding.jsx     First-run setup (name, purpose)
  Dashboard.jsx       Main app shell — tabs, data loading, most feature UI
  Sidebar.jsx         Collapsible, reorderable/renameable navigation
  Settings.jsx        Profile, preferences, account & security
  ImportWizard.jsx    PDF statement upload → review → confirm flow
  Lightfall.jsx       Animated shader background
  api.js              Shared authenticated-fetch helper
  firebase.js         Firebase client config
```

---

## Testing

`backend/lib.js` holds every piece of genuinely deterministic logic — income
conversion, date math, category merging, and the Scotiabank statement parser —
kept separate from Express/Firestore/Groq specifically so it can be unit
tested with zero external dependencies.

```bash
cd backend
npm test          # run once
npm run test:watch  # re-run on change
```

Runs automatically on every push/PR via GitHub Actions (see the badge above).

## AI evaluation

`backend/eval/` measures categorization accuracy for real, instead of just
trusting that the AI works:

- **`eval/dataset.js`** — 147 hand-labeled transactions across all 11
  personal-use categories, including deliberately ambiguous ones (Costco,
  Amazon, Uber Eats) rather than only easy cases
- **`eval/run-eval.js`** — runs the exact `categorize()` logic the live app
  uses (imported, not reimplemented) against every labeled item, and
  compares it against a second prompt variant that adds explicit merchant
  examples for the categories most likely to be confused

```bash
cd backend
npm run eval
```

### Results

| | Run 1 | Run 2 | Fallback-to-"Other" triggered |
|---|---|---|---|
| Baseline prompt | 91.2% (134/147) | 93.9% (138/147) | 0/147 both runs |
| Improved prompt (merchant examples) | 90.5% (133/147) | 91.8% (135/147) | 0/147 both runs |
| Surgical prompt (Transport/Travel only) | — | 91.2% (134/147) | 0/147 |

The zero fallback rate across every run is worth noting on its own: across
hundreds of total calls, the model never once returned something the code
couldn't parse or match to a real category — the `usedFallback` safety net
exists, but it was never actually needed here.

**The most important finding isn't which prompt "won" — it's that baseline
itself swung by 2.7 points between two identical runs.** Comparing the
actual misses between those two runs (not just the aggregate number), 6
items that were wrong in run 1 were correct in run 2 with the *exact same
prompt*, while 2 different items broke that hadn't before. That's genuine
answer-level non-determinism, not just noisy rounding — and it's the same
magnitude as the 2-3 point differences the prompt variants showed. That
means the original single-run comparison wasn't actually strong enough
evidence to declare either variant better or worse than baseline; it could
easily have been measuring sampling noise.

**The fix:** `categorizeWithDetails()` now pins `temperature: 0` on every
categorization call, minimizing the model's sampling randomness. This
doesn't just make future evals more trustworthy — there's rarely a good
reason for the same transaction description to get categorized differently
on different days in the live app either.

**What did hold up across every run:** the "improved" prompt's Transport-
vs-Travel merchant examples reliably fixed that specific confusion, but
just as reliably introduced new misses in Rent/Housing (insurance, repairs,
storage) that the prompt never mentioned — that pattern repeated across
both runs, so unlike the aggregate percentage, that particular regression
looks like a real effect, not noise. The surgical prompt (only the
Transport/Travel guidance, none of the other category examples) was
built specifically to test whether the fix could be isolated from the
regression — it wasn't: it still came in below baseline, with a different
and somewhat unexpected set of new misses (Costco → Shopping instead of
Groceries, two new Utilities misses). That's a legitimate negative result,
not a bug — sometimes a hypothesis about *why* a prompt regressed turns
out to be wrong, and the only way to know is to actually test it.

**Conclusion:** the baseline prompt is what ships in this app. None of the
two variants tested has demonstrated a reliable improvement over it, and
now that `temperature: 0` is in place, a future re-run of all three would
be a meaningfully more trustworthy comparison than the ones documented
here. The eval didn't just fail to justify a change — it caught a real
regression pattern, and separately surfaced a measurement-reliability
problem in the eval process itself before either could go unnoticed.

## Security model

**Threat model:** someone with a stolen or self-issued Firebase Auth token
trying to read or write data that isn't theirs — either another user's
transactions, or bypassing an authorization check (like household
membership) that only exists in application code.

**The client never talks to Firestore directly.** The browser only ever
does two things: (1) authenticate with Firebase Auth to get an ID token,
and (2) send that token as a `Bearer` header to this app's own Express API.
Firestore itself is only ever touched server-side, via the Firebase Admin
SDK — which is a privileged connection that bypasses Firestore security
rules by design.

That means the actual authorization boundary is **`requireAuth`, the
middleware every route runs through** (`backend/server.js`): it verifies
the token, extracts the real `uid` from it (never trusts a client-supplied
one), and scopes every Firestore reference for that request to
`users/{uid}/...`. There's no query a client could construct to read
`users/{someone-else}/transactions` — the backend never lets `uid` come
from anywhere but the verified token.

The one place this gets more complex is **Household mode**, which
deliberately reads a *different* user's transactions to build the shared
spending view. That's handled by an explicit membership check in code
before the cross-user read happens (`GET /api/household/spending`) —
Firestore rules can't express "these two specific users agreed to share
data with each other," so that check has to live in application logic,
verified on every request rather than assumed from a cached state.

**`firestore.rules`** backs this up by denying all direct client access to
Firestore outright:
```
match /{document=**} {
  allow read, write: if false;
}
```
Since the client is never supposed to touch Firestore directly, this rule
costs nothing functionally — the Admin SDK ignores it — but it closes the
door on anyone who obtained the Firebase client config and tried to query
Firestore directly from the browser, skipping the backend's authorization
logic entirely.

Deploy it with the Firebase CLI: `firebase deploy --only firestore:rules`
(or paste `firestore.rules` into the console's Rules tab).

## Notes

- **Secrets:** `backend/.env` and `backend/serviceAccountKey.json` are git-ignored —
  never commit them.
- **AI usage:** Groq's free tier is rate-limited (fine for personal use). Statement
  parsing chunks long PDFs and caps output tokens to stay within per-request limits.

## Ideas for what's next
- CSV import, bulk transaction actions
- Financial goals with dedicated progress tracking
- Real deployment (currently local-only), with a public demo account
- Deterministic parsers for other Canadian banks (BMO, CIBC, TD, RBC) — needs
  a real sample statement per bank to build against safely; the AI extraction
  fallback already handles any bank without a dedicated parser
