# 💰 AI Finance Tracker

Full-stack expense tracker with AI auto-categorization, per-user login, and a
chat box for asking questions about your spending.

**Stack:** React & JavaScript · Node/Express · Firebase (Auth + Firestore) · Groq API

## Run it
```bash
# backend
cd backend && npm install && cp .env.example .env
npm start

# frontend
cd frontend && npm install
npm run dev
```

You'll need a free Firebase project (Auth + Firestore) and a free Groq API
key — see `.env.example` and `firebase.js` for where they go.
