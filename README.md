# AI Personal Finance Tracker

Full-stack app: log transactions, get them auto-categorized by AI, see a spending
breakdown, and chat with your data ("how much did I spend on dining last month?").

**Stack:** Node.js + Express backend (in-memory store), React (Vite) frontend,
Gemini API (free tier) for categorization + chat.

## 1. Get a free API key
Go to https://aistudio.google.com, sign in with a Google account, click "Get API key"
→ "Create API key". No credit card required — just don't enable billing on the project,
or you'll lose free-tier access. The app uses `gemini-2.5-flash`, which is free-tier eligible.

## 2. Run the backend
You need Node.js installed (v18+, since it uses the built-in `fetch`). Check with `node -v`.

```bash
cd backend
npm install
```

Then set your key. Easiest way: copy `.env.example` to `.env` and paste your key in:
```bash
cp .env.example .env
# open .env and paste your key after GEMINI_API_KEY=
```

Then start the server:
```bash
npm start
```

Backend runs on **http://localhost:8080**.

(Alternative: instead of a `.env` file, you can set the variable directly in your
terminal before `npm start` — PowerShell: `$env:GEMINI_API_KEY="your-key"`,
Mac/Linux: `export GEMINI_API_KEY=your-key`.)

## 3. Run the frontend
In a separate terminal:
```bash
cd frontend
npm install
npm run dev
```
Frontend runs on **http://localhost:5173**.

## 4. Try it out
- Add a transaction like "Whole Foods" / $84.20 / today's date — it'll be auto-categorized
  as "Groceries" by Gemini.
- Add a few more across categories (Uber, Netflix, rent, restaurant, etc.)
- Watch the pie chart update.
- Ask the chat box something like "What's my biggest spending category?"

## Notes
- Data is in-memory — it resets every time you restart the backend (`Ctrl+C` then
  `npm start` again wipes it). To persist data, swap the in-memory array in `server.js`
  for a real database (SQLite is the easiest upgrade — `better-sqlite3` needs no server).
- Don't commit your API key. `.env` is already git-ignored.
- `server.js` has all the AI logic in `callGemini`, `categorize`, and `chatAboutFinances`
  — that's the place to look if you want to change the model or tweak prompts.
- The free tier has rate limits (roughly 15 requests/minute as of mid-2026, subject to
  change). Fine for personal use and demos; if you ever see 429 errors in the backend
  console, you've hit the limit — wait a bit or check current quotas at aistudio.google.com.

## Ideas to extend it
- Persist to SQLite or Postgres so data survives restarts.
- Add a monthly view / trend line instead of just a snapshot pie chart.
- Let AI flag "unusual" transactions (spending spikes vs. your normal pattern).
- Add auth so it's multi-user.
- Import a real CSV bank statement instead of manual entry.
