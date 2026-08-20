import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import { db, auth } from './firestore.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const MODEL = 'openai/gpt-oss-120b'; // free-tier eligible (llama-3.3-70b-versatile was deprecated Aug 2026)

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

const CATEGORIES = [
  'Groceries', 'Dining', 'Transport', 'Rent/Housing', 'Utilities',
  'Entertainment', 'Shopping', 'Health', 'Travel', 'Subscriptions', 'Other'
];

// --- Auth middleware: verifies the Firebase ID token sent from the frontend
// and scopes every request to that user's own data. ---
async function requireAuth(req, res, next) {
  if (!db || !auth) {
    return res.status(503).json({ error: 'Firestore is not configured. See README for setup (serviceAccountKey.json).' });
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization: Bearer <token> header' });
  }

  try {
    const decoded = await auth.verifyIdToken(token);
    req.uid = decoded.uid;
    // Each user's transactions live in their own subcollection: users/{uid}/transactions
    req.transactionsRef = db.collection('users').doc(req.uid).collection('transactions');
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// --- Groq helper (OpenAI-compatible chat completions API) ---
async function callGroq(prompt) {
  if (!groq) {
    throw new Error('GROQ_API_KEY is not set');
  }

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 300
  });

  return (completion.choices?.[0]?.message?.content || '').trim();
}

async function categorize(description, amount) {
  if (!groq) return 'Other';

  const prompt = `Categorize this bank transaction into exactly ONE of these categories: ${CATEGORIES.join(', ')}

Transaction description: "${description}"
Amount: ${amount}

Respond with ONLY the category name, nothing else.`;

  try {
    const result = (await callGroq(prompt)).trim();
    const match = CATEGORIES.find(c => c.toLowerCase() === result.toLowerCase());
    return match || 'Other';
  } catch (err) {
    console.error('Categorization failed:', err.message);
    return 'Other';
  }
}

async function chatAboutFinances(question, transactionsSummary) {
  if (!groq) {
    return "AI chat isn't configured yet — set GROQ_API_KEY on the backend.";
  }

  const prompt = `You are a helpful personal finance assistant. Here is a summary of the user's recent transactions (date, category, amount, description):

${transactionsSummary}

Answer the user's question using only this data. Be concise and specific with numbers.

Question: ${question}`;

  try {
    return await callGroq(prompt);
  } catch (err) {
    return `AI request failed: ${err.message}`;
  }
}

// --- Routes ---
// All routes require a valid Firebase ID token; data is scoped to req.uid automatically.

app.get('/api/transactions', requireAuth, async (req, res) => {
  const snapshot = await req.transactionsRef.orderBy('date', 'desc').get();
  const transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  res.json(transactions);
});

app.post('/api/transactions', requireAuth, async (req, res) => {
  const { description, amount, date, category } = req.body;

  if (!description || amount === undefined || !date) {
    return res.status(400).json({ error: 'description, amount, and date are required' });
  }

  let finalCategory = category;
  if (!finalCategory || !finalCategory.trim()) {
    finalCategory = await categorize(description, amount);
  }

  const transaction = {
    description,
    amount: Number(amount),
    date,
    category: finalCategory
  };

  const docRef = await req.transactionsRef.add(transaction);
  res.status(201).json({ id: docRef.id, ...transaction });
});

app.delete('/api/transactions/:id', requireAuth, async (req, res) => {
  await req.transactionsRef.doc(req.params.id).delete();
  res.status(204).end();
});

app.get('/api/transactions/summary', requireAuth, async (req, res) => {
  const snapshot = await req.transactionsRef.get();
  const summary = {};
  snapshot.docs.forEach(doc => {
    const t = doc.data();
    summary[t.category] = (summary[t.category] || 0) + t.amount;
  });
  res.json(summary);
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'question is required' });
  }

  const snapshot = await req.transactionsRef.orderBy('date', 'desc').get();
  const summary = snapshot.docs
    .map(doc => {
      const t = doc.data();
      return `${t.date} | ${t.category} | $${t.amount} | ${t.description}`;
    })
    .join('\n');

  const answer = await chatAboutFinances(question, summary);
  res.json({ answer });
});

app.listen(PORT, () => {
  console.log(`Finance tracker backend running on http://localhost:${PORT}`);
  if (!groq) {
    console.warn('⚠️  GROQ_API_KEY is not set — AI categorization and chat will fall back to defaults.');
  }
  if (!db) {
    console.warn('⚠️  Firestore is not configured — see README for setup.');
  }
});
