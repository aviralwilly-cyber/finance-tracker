import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import { db, auth } from './firestore.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// PDF statement uploads: kept in memory only, never written to disk —
// processed for text extraction, then discarded once the request ends.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const PORT = process.env.PORT || 8080;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const MODEL = 'openai/gpt-oss-120b'; // free-tier eligible (llama-3.3-70b-versatile was deprecated Aug 2026)

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// Category sets change based on why someone's using the app — set during
// onboarding. This is what makes the onboarding question actually matter,
// rather than just being a label stored and never used again.
const CATEGORY_SETS = {
  self: ['Groceries', 'Dining', 'Transport', 'Rent/Housing', 'Utilities', 'Entertainment', 'Shopping', 'Health', 'Travel', 'Subscriptions', 'Other'],
  business: ['Office Supplies', 'Client Meals', 'Software & Subscriptions', 'Business Travel', 'Marketing', 'Professional Services', 'Equipment', 'Rent/Utilities', 'Payroll', 'Other'],
  other: ['Groceries', 'Dining', 'Transport', 'Bills', 'Entertainment', 'Shopping', 'Health', 'Travel', 'Subscriptions', 'Other']
};

function categoriesFor(purpose) {
  return CATEGORY_SETS[purpose] || CATEGORY_SETS.self;
}

const SAVINGS_TYPES = ['Savings', 'Investment', 'Retirement', 'Other'];

// Converts any income entry to a monthly-equivalent amount.
// Biweekly = 26 pay periods/year, so monthly equivalent = amount * 26 / 12.
function toMonthlyAmount(amount, frequency) {
  if (frequency === 'biweekly') return amount * (26 / 12);
  return amount; // 'monthly'
}

// Given a list of income entries (each with amount, frequency, effectiveDate)
// and a target date, finds the entry that was in effect on that date —
// i.e. the most recent entry whose effectiveDate is on or before it.
// This is what makes income "history" actually work: a raise you log today
// doesn't retroactively change what your income was three months ago.
function incomeInEffectOn(incomeEntries, targetDate) {
  const applicable = incomeEntries
    .filter(e => e.effectiveDate <= targetDate)
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1));
  return applicable[0] || null;
}

// Builds the last `count` months (oldest first) as { month: 'YYYY-MM',
// lastDay: 'YYYY-MM-DD' } — the last day of each month is what we check
// income/spending/saving against, so a mid-month raise still counts for
// that whole month.
function lastNMonths(count) {
  const today = new Date();
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const lastDayNum = new Date(year, month, 0).getDate();
    const lastDay = `${monthStr}-${String(lastDayNum).padStart(2, '0')}`;
    months.push({ month: monthStr, lastDay });
  }
  return months;
}

// Advances a YYYY-MM-DD date by one period of the given recurring frequency.
function advanceDate(dateStr, frequency) {
  const d = new Date(dateStr + 'T00:00:00');
  if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'biweekly') d.setDate(d.getDate() + 14);
  else d.setMonth(d.getMonth() + 1); // 'monthly'
  return d.toISOString().slice(0, 10);
}

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
    req.userDocRef = db.collection('users').doc(req.uid);
    // Each user's data lives in their own subcollections: users/{uid}/...
    req.transactionsRef = req.userDocRef.collection('transactions');
    req.incomeRef = req.userDocRef.collection('income');
    req.savingsRef = req.userDocRef.collection('savings');
    req.budgetsRef = req.userDocRef.collection('budgets');
    req.chatRef = req.userDocRef.collection('chatHistory');
    req.recurringRef = req.userDocRef.collection('recurring');

    // Profile lives as fields on the user doc itself (not a subcollection) —
    // it determines which category set this request should use.
    const profileSnap = await req.userDocRef.get();
    req.profile = profileSnap.exists ? profileSnap.data() : {};
    req.categories = categoriesFor(req.profile.purpose);

    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// --- Groq helper (OpenAI-compatible chat completions API) ---
async function callGroq(prompt, maxTokens = 300, extraOptions = {}) {
  if (!groq) {
    throw new Error('GROQ_API_KEY is not set');
  }

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    ...extraOptions
  });

  return (completion.choices?.[0]?.message?.content || '').trim();
}

// Parses a free-text phrase like "Starbucks 5.50 today" into structured
// transaction fields. Only extraction is AI's job here — the actual
// transaction creation, validation, and categorization all happen through
// the normal deterministic code path afterward.
async function parseQuickAddText(text, today) {
  if (!groq) {
    throw new Error('GROQ_API_KEY is not set — quick-add needs AI to parse free text.');
  }

  const prompt = `Today's date is ${today}. Parse this into a bank transaction.
Interpret relative dates like "today", "yesterday", or a weekday name relative to today's date.
If no date is mentioned, use today's date.

Text: "${text}"

Respond with ONLY valid JSON, no markdown fences, no explanation, in exactly this shape:
{"description": "string", "amount": number, "date": "YYYY-MM-DD"}`;

  const raw = await callGroq(prompt);
  const cleaned = raw.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('Could not understand that — try something like "Starbucks 5.50 today".');
  }

  if (!parsed.description || typeof parsed.amount !== 'number' || !parsed.date) {
    throw new Error('Could not extract a description, amount, and date from that text.');
  }

  return parsed;
}

// Splits extracted PDF text into manageable chunks for the AI to parse —
// prefers splitting on page breaks (what pdf-parse inserts between pages),
// falling back to a character-count split for PDFs with no page markers.
// Every chunk is then hard-capped in size regardless of source, since
// Groq's free tier caps openai/gpt-oss-120b at 8000 tokens TOTAL per
// request (input + output combined) — an oversized single page could
// otherwise slip through the page-break path uncapped.
const MAX_STATEMENT_CHUNKS = 8;
const MAX_CHUNK_CHARS = 3500;

function splitToMaxSize(str) {
  const parts = [];
  for (let i = 0; i < str.length; i += MAX_CHUNK_CHARS) {
    parts.push(str.slice(i, i + MAX_CHUNK_CHARS));
  }
  return parts;
}

function chunkStatementText(text) {
  let pages = text.split('\f').map(p => p.trim()).filter(Boolean);
  if (pages.length <= 1) {
    pages = splitToMaxSize(text); // no page markers — fall back to fixed-size chunks
  } else {
    pages = pages.flatMap(splitToMaxSize); // guard against any oversized individual page
  }
  const truncated = pages.length > MAX_STATEMENT_CHUNKS;
  return { chunks: pages.slice(0, MAX_STATEMENT_CHUNKS), truncated };
}

// Extracts transaction line items from one chunk of statement text. AI's
// job is identifying and structuring the lines — nothing gets saved to the
// database from this step; it only returns a proposed list for review.
async function extractTransactionsFromChunk(chunkText, currentYear) {
  if (!groq) return [];

  const prompt = `Below is raw text extracted from a page of a bank statement PDF. The
extraction process sometimes loses spaces between words (e.g. "TORONTOON" instead of
"TORONTO ON") — account for this when reading merchant names and numbers.

Extract ONLY the actual transaction line items (ignore account numbers, balances,
statement summaries, headers, and any other non-transaction text).

For each transaction, identify:
- date: convert to YYYY-MM-DD format. If the year is missing, assume ${currentYear}.
- description: the merchant or transaction description
- amount: a positive number, no currency symbols or commas
- type: "debit" if money left the account (purchases, payments, withdrawals), or "credit" if money came into the account (deposits, refunds, transfers in)

Respond with ONLY a valid JSON array, no markdown fences, no explanation. If there are
no transactions on this page, respond with an empty array. Exact shape:
[{"date":"YYYY-MM-DD","description":"string","amount":number,"type":"debit"|"credit"}]

Statement text:
${chunkText}`;

  let raw;
  try {
    // 4000 output tokens + a ~3500-char chunk (~1000-1500 input tokens) +
    // prompt overhead stays comfortably under Groq's 8000-token combined cap.
    raw = await callGroq(prompt, 4000, { reasoning_effort: 'low' });
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(t => t.date && t.description && typeof t.amount === 'number' && (t.type === 'debit' || t.type === 'credit'));
  } catch (err) {
    console.error('Statement chunk parsing failed:', err.message);
    if (typeof raw === 'string') {
      console.error('[import-pdf] redacted raw AI response (first 500 chars):', raw.slice(0, 500).replace(/\d/g, '#'));
    }
    return []; // skip a bad chunk rather than failing the whole import
  }
}

async function categorize(description, amount, categories) {
  if (!groq) return 'Other';

  const prompt = `Categorize this bank transaction into exactly ONE of these categories: ${categories.join(', ')}

Transaction description: "${description}"
Amount: ${amount}

Respond with ONLY the category name, nothing else.`;

  try {
    const result = (await callGroq(prompt)).trim();
    const match = categories.find(c => c.toLowerCase() === result.toLowerCase());
    return match || 'Other';
  } catch (err) {
    console.error('Categorization failed:', err.message);
    return 'Other';
  }
}

async function chatAboutFinances(question, transactionsSummary, incomeContext, savingsContext, historyContext) {
  if (!groq) {
    return "AI chat isn't configured yet — set GROQ_API_KEY on the backend.";
  }

  const prompt = `You are a helpful personal finance assistant. Here is a summary of the user's recent transactions (date, category, amount, description):

${transactionsSummary}

${incomeContext}

${savingsContext}

${historyContext}

Answer the user's question using only this data. Be concise and specific with numbers.
Respond in plain conversational sentences only — do NOT use markdown tables, pipe characters,
bullet lists, or headers. If the user's question refers back to something from the recent
conversation (like "how about August?" after asking about July), use that context to understand
what they mean.

Question: ${question}`;

  try {
    const result = await callGroq(prompt);
    return result || "I wasn't able to come up with an answer to that — could you try rephrasing?";
  } catch (err) {
    return `AI request failed: ${err.message}`;
  }
}

function daysLeftInMonth(today) {
  const [year, month] = today.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
  const currentDay = Number(today.slice(8, 10));
  return lastDay - currentDay;
}

// Deterministic math (percent spent, over/under) happens in code before this
// is ever called — the AI's only job is turning near-limit/over-limit
// categories into a short, plain-language nudge. One call covers every
// category that needs a mention, instead of one call per category.
async function generateBudgetNudge(nearOrOverBudgets, daysLeft) {
  if (!groq || nearOrOverBudgets.length === 0) return null;

  const lines = nearOrOverBudgets
    .map(b => `${b.category}: $${b.spent.toFixed(2)} spent of $${b.limit.toFixed(2)} limit (${b.percent.toFixed(0)}%)`)
    .join('\n');

  const prompt = `The user has these budget categories that are close to or over their monthly limit, with ${daysLeft} days left in the month:

${lines}

Write a short, friendly 1-2 sentence nudge mentioning the most urgent one(s) by name with specific numbers. Do not restate every category if there are several — focus on the most over-budget one. Be direct, not preachy.`;

  try {
    return await callGroq(prompt);
  } catch (err) {
    return null; // fail silently — progress bars still work without the nudge
  }
}

// --- Routes ---
// All routes require a valid Firebase ID token; data is scoped to req.uid automatically.

// --- Profile / onboarding routes ---
// A user with no displayName set hasn't completed onboarding yet — the
// frontend uses that to decide whether to show the onboarding form.

app.get('/api/profile', requireAuth, async (req, res) => {
  res.json({
    displayName: req.profile.displayName || null,
    purpose: req.profile.purpose || null
  });
});

app.post('/api/profile', requireAuth, async (req, res) => {
  const { displayName, purpose } = req.body;

  if (!displayName || !displayName.trim()) {
    return res.status(400).json({ error: 'displayName is required' });
  }
  if (!['self', 'business', 'other'].includes(purpose)) {
    return res.status(400).json({ error: "purpose must be 'self', 'business', or 'other'" });
  }

  await req.userDocRef.set({ displayName: displayName.trim(), purpose }, { merge: true });
  res.status(200).json({ displayName: displayName.trim(), purpose });
});

// Lets the frontend build category dropdowns without hardcoding a list that
// might not match what this particular user's purpose actually uses.
app.get('/api/categories', requireAuth, (req, res) => {
  res.json(req.categories);
});

app.get('/api/transactions', requireAuth, async (req, res) => {
  const snapshot = await req.transactionsRef.orderBy('date', 'desc').get();
  const transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  res.json(transactions);
});

// Shared by the manual-add and quick-add routes: categorize if needed, save,
// return the created transaction with its new id.
async function createTransaction(req, { description, amount, date, category }) {
  let finalCategory = category;
  if (!finalCategory || !finalCategory.trim()) {
    finalCategory = await categorize(description, amount, req.categories);
  }
  const transaction = { description, amount: Number(amount), date, category: finalCategory };
  const docRef = await req.transactionsRef.add(transaction);
  return { id: docRef.id, ...transaction };
}

app.post('/api/transactions', requireAuth, async (req, res) => {
  const { description, amount, date, category } = req.body;

  if (!description || amount === undefined || !date) {
    return res.status(400).json({ error: 'description, amount, and date are required' });
  }

  const transaction = await createTransaction(req, { description, amount, date, category });
  res.status(201).json(transaction);
});

// Natural-language quick-add: "Starbucks 5.50 today" → a real transaction.
// AI only extracts the fields; createTransaction() does the actual
// deterministic categorization/save work, same as the manual form.
app.post('/api/transactions/quick-add', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const parsed = await parseQuickAddText(text.trim(), today);
    const transaction = await createTransaction(req, parsed);
    res.status(201).json(transaction);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// pdf-parse's default renderer sometimes concatenates text fragments with no
// space between them on complex/multi-column layouts (common in bank
// statements) — e.g. "TORONTOON" instead of "TORONTO ON". This custom
// renderer walks the raw positioned text items directly and inserts a space
// between fragments (and a newline when the vertical position jumps to a
// new line), which fixes that for the vast majority of statements.
async function renderPageWithSpacing(pageData) {
  const textContent = await pageData.getTextContent();
  let lastY = null;
  let text = '';
  for (const item of textContent.items) {
    const y = item.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 2) {
      text += '\n';
    } else if (text && !text.endsWith('\n')) {
      text += ' ';
    }
    text += item.str;
    lastY = y;
  }
  return text;
}

// --- Known statement format templates ---
// For statement layouts we've seen before, parse them deterministically —
// no AI call needed, no token limits, no risk of a number being misread.
// AI extraction (further below) is only used as a fallback for formats we
// don't have a template for yet.

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function isScotiabankDayToDayStatement(text) {
  // "Scotiabank" and "Day-to-Day Banking" in the header are part of a logo
  // graphic, not real text — pdf-parse never sees them. These signals ARE
  // genuinely present in the extracted text: the internal reference code
  // format, the support phone number, and the transaction table headers.
  const hasScotiabankMarker = /SBSAV\d/i.test(text) || /4-SCOTIA/i.test(text) || /472-6842/.test(text);
  const hasTransactionTable = /withdrawn\s*\(\$\)/i.test(text) && /deposited\s*\(\$\)/i.test(text);
  return hasScotiabankMarker && hasTransactionTable;
}

// Lines that are headers, footers, addresses, marketing blurbs, or other
// non-transaction noise repeated on every page of this statement format.
const SCOTIABANK_NOISE_PATTERNS = [
  /^continued on next page$/i,
  /^Page \d+ of \d+$/i,
  /^Your account number:?$/i,
  /^\d{5}\s+\d{5}\s+\d{2}$/,
  /^Questions\?$/i,
  /^Call /i,
  /^For online account access:?$/i,
  /^www\./i,
  /^Here'?s what happened/i,
  /^Date\s+Transactions/i,
  /^Amounts$/i,
  /^withdrawn/i,
  /^deposited/i,
  /^Balance/i,
  /^MR |^MS |^MRS /,
  /^Your .*account/i,
  /^Opening Balance on/i,
  /^Minus total/i,
  /^Plus total/i,
  /^Closing Balance on/i,
  /^SBSAV/,
  /^\*\d+\*$/,
  /Scotiabank/i,
  /Day-to-Day Banking/i,
  /SQUARE ONE|MISSISSAUGA|CITY CENTRE DRIVE/i,
  /Take steps towards|Scotia Insurance|scotiainsurance/i,
  /^----\s*\|?$/
];

function parseScotiabankDayToDayStatement(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const isNoise = (line) => SCOTIABANK_NOISE_PATTERNS.some(re => re.test(line));

  const yearMatch = text.match(/Opening Balance on \w+\s+\d{1,2},\s*(\d{4})/);
  let year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
  let prevMonthIndex = null;
  let prevBalance = null;

  const transactionLineRe = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(.*)$/;
  const transactions = [];
  let current = null;

  for (const line of lines) {
    if (isNoise(line)) continue;

    const m = line.match(transactionLineRe);
    if (m) {
      if (current) transactions.push(current);
      current = null;

      const [, monName, dayStr, rest] = m;
      const monthIndex = MONTHS[monName];
      if (prevMonthIndex !== null && monthIndex < prevMonthIndex) year++; // crossed a year boundary
      prevMonthIndex = monthIndex;

      const date = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(Number(dayStr)).padStart(2, '0')}`;
      const numbers = (rest.match(/[\d,]+\.\d{2}/g) || []).map(n => Number(n.replace(/,/g, '')));
      const description = rest.replace(/[\d,]+\.\d{2}/g, '').replace(/\s{2,}/g, ' ').trim();

      if (numbers.length === 1) {
        // Opening/Closing Balance line — no transaction, just a balance checkpoint.
        prevBalance = numbers[0];
        continue;
      }
      if (numbers.length < 2) continue;

      const [amount, balance] = numbers;
      // The deterministic signal: did the running balance go up or down?
      const type = prevBalance === null
        ? (/dep\.|deposit|transfer from/i.test(description) ? 'credit' : 'debit') // no reference yet — fall back to keywords
        : (balance > prevBalance ? 'credit' : 'debit');
      prevBalance = balance;

      current = { date, description: description || 'Transaction', amount, type };
    } else if (current) {
      // A continuation line (merchant detail below the transaction row).
      current.description = `${current.description} ${line}`.trim();
    }
  }
  if (current) transactions.push(current);

  return transactions;
}

const STATEMENT_TEMPLATES = [
  { id: 'scotiabank-day-to-day', matches: isScotiabankDayToDayStatement, parse: parseScotiabankDayToDayStatement }
];

// --- PDF statement import ---
// Step 1: upload a PDF, get back a PROPOSED list of transactions. Nothing
// is saved yet — the frontend shows this list for the user to review, edit,
// and select before anything touches the database. See import-confirm below.
app.post('/api/transactions/import-pdf', requireAuth, upload.single('statement'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded (expected field name "statement")' });
  }
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'Only PDF files are supported' });
  }

  let text;
  try {
    const data = await pdfParse(req.file.buffer, { pagerender: renderPageWithSpacing });
    text = data.text;
  } catch (err) {
    return res.status(422).json({ error: "Couldn't read that PDF — it may be corrupted or password-protected." });
  }

  if (!text || !text.trim()) {
    return res.status(422).json({
      error: "Couldn't find any readable text in that PDF — it may be a scanned image rather than a digital statement, which isn't supported yet."
    });
  }

  let extracted = [];
  let truncated = false;
  let usedTemplate = null;

  for (const template of STATEMENT_TEMPLATES) {
    if (template.matches(text)) {
      const parsedByTemplate = template.parse(text);
      if (parsedByTemplate.length > 0) {
        extracted = parsedByTemplate;
        usedTemplate = template.id;
      }
      break; // first matching template wins, whether or not it found transactions
    }
  }

  if (usedTemplate) {
    console.log(`[import-pdf] matched known format "${usedTemplate}" — parsed deterministically, no AI call needed. ${extracted.length} transactions found.`);
  } else {
    // No known template matched — fall back to AI-based extraction.
    const currentYear = new Date().getFullYear();
    const chunkResult = chunkStatementText(text);
    truncated = chunkResult.truncated;

    console.log(`[import-pdf] no known format matched — using AI extraction. ${text.length} chars split into ${chunkResult.chunks.length} chunk(s)`);
    console.log('[import-pdf] redacted preview of first 300 chars:', text.slice(0, 300).replace(/\d/g, '#'));

    // Process chunks sequentially (not in parallel) to stay well within
    // Groq's free-tier rate limits on a single import.
    for (const [i, chunk] of chunkResult.chunks.entries()) {
      const fromChunk = await extractTransactionsFromChunk(chunk, currentYear);
      console.log(`[import-pdf] chunk ${i + 1}/${chunkResult.chunks.length}: ${chunk.length} chars in, ${fromChunk.length} transactions parsed out`);
      extracted = extracted.concat(fromChunk);
    }
  }

  if (extracted.length === 0) {
    return res.status(422).json({ error: "Couldn't find any transactions in that PDF. It may not be a bank statement, or the format isn't recognized." });
  }

  // Duplicate detection: flag (don't block) any parsed transaction that
  // matches an existing one on date + amount, so the review screen can
  // warn the user instead of silently double-counting.
  const existingSnapshot = await req.transactionsRef.get();
  const existingKeys = new Set(
    existingSnapshot.docs.map(doc => {
      const t = doc.data();
      return `${t.date}|${t.amount.toFixed(2)}`;
    })
  );

  const proposed = [];
  for (const t of extracted) {
    const category = await categorize(t.description, t.amount, req.categories);
    const isDuplicate = existingKeys.has(`${t.date}|${t.amount.toFixed(2)}`);
    proposed.push({
      date: t.date,
      description: t.description,
      amount: t.amount,
      type: t.type,
      category,
      isDuplicate
    });
  }

  res.json({ transactions: proposed, truncated });
});

// Step 2: the user has reviewed/edited/selected rows from step 1 — this
// actually creates them. Nothing here calls AI; it's a plain bulk insert.
app.post('/api/transactions/import-confirm', requireAuth, async (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ error: 'transactions must be a non-empty array' });
  }

  let created = 0;
  for (const t of transactions) {
    if (!t.description || typeof t.amount !== 'number' || !t.date || !t.category) continue;
    await req.transactionsRef.add({
      description: t.description,
      amount: t.amount,
      date: t.date,
      category: t.category
    });
    created++;
  }

  res.json({ created });
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

// --- Recurring transactions ---
// A rule creates real transactions automatically when its due date arrives —
// it doesn't just remind you, it actually logs them (e.g. rent every month).

app.get('/api/recurring', requireAuth, async (req, res) => {
  const snapshot = await req.recurringRef.orderBy('nextDueDate', 'asc').get();
  const rules = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  res.json(rules);
});

app.post('/api/recurring', requireAuth, async (req, res) => {
  const { description, amount, category, frequency, startDate } = req.body;

  if (!description || amount === undefined || !frequency || !startDate) {
    return res.status(400).json({ error: 'description, amount, frequency, and startDate are required' });
  }
  if (!['weekly', 'biweekly', 'monthly'].includes(frequency)) {
    return res.status(400).json({ error: "frequency must be 'weekly', 'biweekly', or 'monthly'" });
  }

  // Categorize once at creation time so every future auto-generated
  // transaction from this rule uses the same category consistently.
  let finalCategory = category;
  if (!finalCategory || !finalCategory.trim()) {
    finalCategory = await categorize(description, amount, req.categories);
  }

  const rule = {
    description,
    amount: Number(amount),
    category: finalCategory,
    frequency,
    nextDueDate: startDate,
    active: true
  };

  const docRef = await req.recurringRef.add(rule);
  res.status(201).json({ id: docRef.id, ...rule });
});

app.delete('/api/recurring/:id', requireAuth, async (req, res) => {
  await req.recurringRef.doc(req.params.id).delete();
  res.status(204).end();
});

// Call this on every dashboard load: catches up any recurring rule whose
// nextDueDate has arrived (or passed, if the app wasn't opened for a
// while), generating a real transaction for each missed period.
app.post('/api/recurring/process', requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const snapshot = await req.recurringRef.where('active', '==', true).get();

  let createdCount = 0;

  for (const doc of snapshot.docs) {
    const rule = doc.data();
    let nextDue = rule.nextDueDate;
    let iterations = 0;

    // Loop in case the app wasn't opened for multiple periods — catches up
    // all of them, capped so a stale rule can't create unbounded entries.
    while (nextDue <= today && iterations < 36) {
      await req.transactionsRef.add({
        description: rule.description,
        amount: rule.amount,
        date: nextDue,
        category: rule.category
      });
      createdCount++;
      nextDue = advanceDate(nextDue, rule.frequency);
      iterations++;
    }

    if (nextDue !== rule.nextDueDate) {
      await doc.ref.update({ nextDueDate: nextDue });
    }
  }

  res.json({ created: createdCount });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'question is required' });
  }

  const today = new Date().toISOString().slice(0, 10);

  const [txSnapshot, incomeSnapshot, savingsSnapshot, historySnapshot] = await Promise.all([
    req.transactionsRef.orderBy('date', 'desc').get(),
    req.incomeRef.get(),
    req.savingsRef.get(),
    req.chatRef.orderBy('createdAt', 'desc').limit(6).get() // last 3 Q&A pairs
  ]);

  const summary = txSnapshot.docs
    .map(doc => {
      const t = doc.data();
      return `${t.date} | ${t.category} | $${t.amount} | ${t.description}`;
    })
    .join('\n');

  const incomeEntries = incomeSnapshot.docs.map(doc => doc.data());
  const activeIncome = incomeInEffectOn(incomeEntries, today);
  const incomeContext = activeIncome
    ? `The user's current income is $${activeIncome.amount} (${activeIncome.frequency}), which is about $${toMonthlyAmount(activeIncome.amount, activeIncome.frequency).toFixed(2)}/month.`
    : 'The user has not set up their income yet.';

  const savingsEntries = savingsSnapshot.docs.map(doc => doc.data());
  const totalSaved = savingsEntries.reduce((sum, s) => sum + s.amount, 0);
  const savingsContext = savingsEntries.length > 0
    ? `The user has saved/invested a total of $${totalSaved.toFixed(2)} across these entries:\n` +
      savingsEntries.map(s => `${s.date} | ${s.type} | $${s.amount} | ${s.description}`).join('\n')
    : 'The user has not logged any savings or investments yet.';

  // Recent exchanges give the model context for follow-ups like "how about
  // August?" — without this, every question was answered in total isolation.
  const recentHistory = historySnapshot.docs.map(doc => doc.data()).reverse();
  const historyContext = recentHistory.length > 0
    ? 'Recent conversation (for context on follow-up questions):\n' +
      recentHistory.map(h => `User: ${h.question}\nAssistant: ${h.answer}`).join('\n')
    : '';

  const answer = await chatAboutFinances(question, summary, incomeContext, savingsContext, historyContext);

  // Persist this exchange so it survives a page refresh and informs future context.
  await req.chatRef.add({ question, answer, createdAt: new Date().toISOString() });

  res.json({ answer });
});

app.get('/api/chat/history', requireAuth, async (req, res) => {
  const snapshot = await req.chatRef.orderBy('createdAt', 'asc').get();
  const history = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  res.json(history);
});

app.delete('/api/chat/history', requireAuth, async (req, res) => {
  const snapshot = await req.chatRef.get();
  await Promise.all(snapshot.docs.map(doc => doc.ref.delete()));
  res.status(204).end();
});

// --- Income routes ---

app.get('/api/income', requireAuth, async (req, res) => {
  const snapshot = await req.incomeRef.orderBy('effectiveDate', 'desc').get();
  const income = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  res.json(income);
});

app.post('/api/income', requireAuth, async (req, res) => {
  const { amount, frequency, effectiveDate } = req.body;

  if (amount === undefined || !frequency || !effectiveDate) {
    return res.status(400).json({ error: 'amount, frequency, and effectiveDate are required' });
  }
  if (!['monthly', 'biweekly'].includes(frequency)) {
    return res.status(400).json({ error: "frequency must be 'monthly' or 'biweekly'" });
  }

  const entry = { amount: Number(amount), frequency, effectiveDate };
  const docRef = await req.incomeRef.add(entry);
  res.status(201).json({ id: docRef.id, ...entry });
});

app.delete('/api/income/:id', requireAuth, async (req, res) => {
  await req.incomeRef.doc(req.params.id).delete();
  res.status(204).end();
});

// --- Savings / investments routes ---

app.get('/api/savings', requireAuth, async (req, res) => {
  const snapshot = await req.savingsRef.orderBy('date', 'desc').get();
  const savings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  res.json(savings);
});

app.post('/api/savings', requireAuth, async (req, res) => {
  const { type, description, amount, date } = req.body;

  if (!type || amount === undefined || !date) {
    return res.status(400).json({ error: 'type, amount, and date are required' });
  }
  if (!SAVINGS_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${SAVINGS_TYPES.join(', ')}` });
  }

  const entry = { type, description: description || '', amount: Number(amount), date };
  const docRef = await req.savingsRef.add(entry);
  res.status(201).json({ id: docRef.id, ...entry });
});

app.delete('/api/savings/:id', requireAuth, async (req, res) => {
  await req.savingsRef.doc(req.params.id).delete();
  res.status(204).end();
});

app.get('/api/savings/summary', requireAuth, async (req, res) => {
  const snapshot = await req.savingsRef.get();
  const summary = {};
  snapshot.docs.forEach(doc => {
    const s = doc.data();
    summary[s.type] = (summary[s.type] || 0) + s.amount;
  });
  res.json(summary);
});

// --- Budget routes ---
// Budgets are keyed by category (one limit per category, not per-month) —
// simpler than income history since a budget is a standing guardrail you
// adjust occasionally, not something that needs to be reconstructed for
// past months.

app.get('/api/budgets', requireAuth, async (req, res) => {
  const snapshot = await req.budgetsRef.get();
  const budgets = snapshot.docs.map(doc => ({ category: doc.id, ...doc.data() }));
  res.json(budgets);
});

app.post('/api/budgets', requireAuth, async (req, res) => {
  const { category, limit } = req.body;

  if (!category || limit === undefined) {
    return res.status(400).json({ error: 'category and limit are required' });
  }
  if (!req.categories.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${req.categories.join(', ')}` });
  }

  // Doc ID = category name, so setting a budget for a category that already
  // has one just updates it (upsert) instead of creating a duplicate.
  await req.budgetsRef.doc(category).set({ limit: Number(limit) });
  res.status(200).json({ category, limit: Number(limit) });
});

app.delete('/api/budgets/:category', requireAuth, async (req, res) => {
  await req.budgetsRef.doc(req.params.category).delete();
  res.status(204).end();
});

// Combines budgets with this month's actual spending per category, computes
// percent used, and asks the AI for a short nudge if anything's close to or
// over its limit. All the math is deterministic; only the sentence is AI.
app.get('/api/budgets/progress', requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);

  const [budgetsSnapshot, txSnapshot] = await Promise.all([
    req.budgetsRef.get(),
    req.transactionsRef.get()
  ]);

  const spentByCategory = {};
  txSnapshot.docs
    .map(doc => doc.data())
    .filter(t => t.date.startsWith(currentMonth))
    .forEach(t => {
      spentByCategory[t.category] = (spentByCategory[t.category] || 0) + t.amount;
    });

  const progress = budgetsSnapshot.docs.map(doc => {
    const category = doc.id;
    const limit = doc.data().limit;
    const spent = spentByCategory[category] || 0;
    const percent = limit > 0 ? (spent / limit) * 100 : 0;
    return { category, limit, spent, percent, remaining: limit - spent };
  });

  const daysLeft = daysLeftInMonth(today);
  const nearOrOver = progress.filter(b => b.percent >= 80);
  const nudge = await generateBudgetNudge(nearOrOver, daysLeft);

  res.json({ budgets: progress, daysLeftInMonth: daysLeft, nudge });
});

// Ties income + spending + savings together for the current month: monthly-
// equivalent income, total spent this month, total saved/invested this month,
// what's genuinely left unallocated, a real savings rate, and a running
// "net worth" total (cumulative savings/investments logged over time).
app.get('/api/overview', requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const currentMonth = today.slice(0, 7); // YYYY-MM

  const [incomeSnapshot, txSnapshot, savingsSnapshot] = await Promise.all([
    req.incomeRef.get(),
    req.transactionsRef.get(),
    req.savingsRef.get()
  ]);

  const incomeEntries = incomeSnapshot.docs.map(doc => doc.data());
  const activeIncome = incomeInEffectOn(incomeEntries, today);
  const monthlyIncome = activeIncome ? toMonthlyAmount(activeIncome.amount, activeIncome.frequency) : 0;

  const spentThisMonth = txSnapshot.docs
    .map(doc => doc.data())
    .filter(t => t.date.startsWith(currentMonth))
    .reduce((sum, t) => sum + t.amount, 0);

  const savingsEntries = savingsSnapshot.docs.map(doc => doc.data());
  const savedThisMonth = savingsEntries
    .filter(s => s.date.startsWith(currentMonth))
    .reduce((sum, s) => sum + s.amount, 0);
  const totalSaved = savingsEntries.reduce((sum, s) => sum + s.amount, 0); // running "net worth"

  const savingsByType = {};
  savingsEntries.forEach(s => {
    savingsByType[s.type] = (savingsByType[s.type] || 0) + s.amount;
  });

  // "Remaining" is now truly unallocated money — income minus what was spent
  // AND minus what was deliberately set aside, so it doesn't double-count
  // money that's already earmarked as savings.
  const remaining = monthlyIncome - spentThisMonth - savedThisMonth;
  // Savings rate is now the real thing: % of income actually saved/invested
  // this month, not just "whatever wasn't spent."
  const savingsRate = monthlyIncome > 0 ? (savedThisMonth / monthlyIncome) * 100 : null;

  res.json({
    monthlyIncome,
    spentThisMonth,
    savedThisMonth,
    totalSaved,
    savingsByType,
    remaining,
    savingsRate,
    hasIncomeConfigured: !!activeIncome
  });
});

// Compares income, spending, and saving side by side across the last 6
// months — this is what lets you see "did my salary actually go up in
// October?" and "did my spending track it?" instead of only ever seeing
// the current month in isolation.
app.get('/api/trend', requireAuth, async (req, res) => {
  const months = lastNMonths(6);

  const [incomeSnapshot, txSnapshot, savingsSnapshot] = await Promise.all([
    req.incomeRef.get(),
    req.transactionsRef.get(),
    req.savingsRef.get()
  ]);

  const incomeEntries = incomeSnapshot.docs.map(doc => doc.data());
  const transactions = txSnapshot.docs.map(doc => doc.data());
  const savingsEntries = savingsSnapshot.docs.map(doc => doc.data());

  const trend = months.map(({ month, lastDay }) => {
    const activeIncome = incomeInEffectOn(incomeEntries, lastDay);
    const income = activeIncome ? toMonthlyAmount(activeIncome.amount, activeIncome.frequency) : 0;

    const spent = transactions
      .filter(t => t.date.startsWith(month))
      .reduce((sum, t) => sum + t.amount, 0);

    const saved = savingsEntries
      .filter(s => s.date.startsWith(month))
      .reduce((sum, s) => sum + s.amount, 0);

    return { month, income, spent, saved };
  });

  res.json(trend);
});

// Catches multer errors (e.g. file too large) so they return a clean JSON
// error instead of crashing or hanging the request.
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That PDF is too large (10MB max).' });
  }
  if (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong processing that request.' });
  }
  next();
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
