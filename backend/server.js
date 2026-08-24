import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import { db, auth } from './firestore.js';
import {
  categoriesFor,
  toMonthlyAmount,
  incomeInEffectOn,
  lastNMonths,
  daysLeftInMonth,
  advanceDate,
  isScotiabankDayToDayStatement,
  parseScotiabankDayToDayStatement,
  chunkStatementText
} from './lib.js';
import { groq, callGroq, categorize } from './ai.js';

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
const VISION_MODEL = 'qwen/qwen3.6-27b'; // free-tier eligible, text + image input — used for receipt OCR

const SAVINGS_TYPES = ['Savings', 'Investment', 'Retirement', 'Other'];

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
    req.categories = categoriesFor(req.profile.purpose, req.profile.customCategories || []);

    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
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
    purpose: req.profile.purpose || null,
    phoneNumber: req.profile.phoneNumber || '',
    budgetNudgeThreshold: req.profile.budgetNudgeThreshold ?? 80,
    customCategories: req.profile.customCategories || [],
    photoURL: req.profile.photoURL || null,
    avatarEmoji: req.profile.avatarEmoji || null,
    photoGallery: req.profile.photoGallery || [],
    employmentType: req.profile.employmentType || null,
    jobTitle: req.profile.jobTitle || '',
    financialGoal: req.profile.financialGoal || null,
    householdId: req.profile.householdId || null
  });
});

app.post('/api/profile', requireAuth, async (req, res) => {
  const {
    displayName, purpose, phoneNumber, budgetNudgeThreshold, photoURL, avatarEmoji,
    employmentType, jobTitle, financialGoal
  } = req.body;

  if (!displayName || !displayName.trim()) {
    return res.status(400).json({ error: 'displayName is required' });
  }
  if (!['self', 'business', 'other'].includes(purpose)) {
    return res.status(400).json({ error: "purpose must be 'self', 'business', or 'other'" });
  }

  const update = { displayName: displayName.trim(), purpose };

  if (phoneNumber !== undefined) update.phoneNumber = phoneNumber.trim();
  if (photoURL !== undefined) update.photoURL = photoURL;
  if (avatarEmoji !== undefined) update.avatarEmoji = avatarEmoji; // short unicode string, e.g. "🐨"
  if (employmentType !== undefined) update.employmentType = employmentType;
  if (jobTitle !== undefined) update.jobTitle = jobTitle.trim();
  if (financialGoal !== undefined) update.financialGoal = financialGoal;

  if (budgetNudgeThreshold !== undefined) {
    const threshold = Number(budgetNudgeThreshold);
    if (isNaN(threshold) || threshold < 1 || threshold > 100) {
      return res.status(400).json({ error: 'budgetNudgeThreshold must be a number between 1 and 100' });
    }
    update.budgetNudgeThreshold = threshold;
  }

  await req.userDocRef.set(update, { merge: true });
  res.status(200).json(update);
});

// --- Photo gallery ---
// A personal set of images (up to 10, resized/compressed client-side) you
// can pick your active avatar from — separate from the single active
// photoURL, which is just "whichever gallery image is currently selected."

const MAX_GALLERY_SIZE = 10;

app.post('/api/profile/gallery', requireAuth, async (req, res) => {
  const { photoURL } = req.body;
  if (!photoURL || typeof photoURL !== 'string') {
    return res.status(400).json({ error: 'photoURL is required' });
  }

  const gallery = req.profile.photoGallery || [];
  if (gallery.length >= MAX_GALLERY_SIZE) {
    return res.status(400).json({ error: `You can only keep up to ${MAX_GALLERY_SIZE} images in your gallery — remove one first.` });
  }

  const updated = [...gallery, photoURL];
  await req.userDocRef.set({ photoGallery: updated }, { merge: true });
  res.status(201).json(updated);
});

app.delete('/api/profile/gallery/:index', requireAuth, async (req, res) => {
  const index = Number(req.params.index);
  const gallery = req.profile.photoGallery || [];
  const updated = gallery.filter((_, i) => i !== index);

  const update = { photoGallery: updated };
  // If the image being removed was the active avatar, clear it too so we
  // don't leave photoURL pointing at something no longer in the gallery.
  if (gallery[index] === req.profile.photoURL) {
    update.photoURL = null;
  }

  await req.userDocRef.set(update, { merge: true });
  res.status(200).json(update);
});

// --- Data export & account deletion ---

// Bundles up everything this user has stored, for download as a backup or
// before deleting their account.
app.get('/api/export', requireAuth, async (req, res) => {
  const [txSnap, incomeSnap, savingsSnap, budgetsSnap, recurringSnap] = await Promise.all([
    req.transactionsRef.get(),
    req.incomeRef.get(),
    req.savingsRef.get(),
    req.budgetsRef.get(),
    req.recurringRef.get()
  ]);

  res.json({
    exportedAt: new Date().toISOString(),
    profile: req.profile,
    transactions: txSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    income: incomeSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    savings: savingsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    budgets: budgetsSnap.docs.map(d => ({ category: d.id, ...d.data() })),
    recurring: recurringSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  });
});

// Deletes every Firestore document this user owns. Does NOT delete the
// Firebase Auth account itself — the frontend does that separately with the
// Firebase client SDK, since that requires the user's live session.
app.delete('/api/account', requireAuth, async (req, res) => {
  const collections = [req.transactionsRef, req.incomeRef, req.savingsRef, req.budgetsRef, req.recurringRef, req.chatRef];

  for (const ref of collections) {
    const snapshot = await ref.get();
    await Promise.all(snapshot.docs.map(doc => doc.ref.delete()));
  }

  await req.userDocRef.delete();
  res.status(204).end();
});

// Lets the frontend build category dropdowns without hardcoding a list that
// might not match what this particular user's purpose actually uses.
app.get('/api/categories', requireAuth, (req, res) => {
  res.json(req.categories);
});

// --- Custom categories ---
// Additive only — these sit on top of the preset list for your purpose
// (self/business/other), rather than replacing it. Existing budgets/
// transactions referencing preset categories can't be orphaned this way.

app.get('/api/categories/custom', requireAuth, (req, res) => {
  res.json(req.profile.customCategories || []);
});

app.post('/api/categories/custom', requireAuth, async (req, res) => {
  const { category } = req.body;
  if (!category || !category.trim()) {
    return res.status(400).json({ error: 'category is required' });
  }
  const trimmed = category.trim();

  const existingLower = req.categories.map(c => c.toLowerCase());
  if (existingLower.includes(trimmed.toLowerCase())) {
    return res.status(400).json({ error: 'That category already exists.' });
  }

  const updated = [...(req.profile.customCategories || []), trimmed];
  await req.userDocRef.set({ customCategories: updated }, { merge: true });
  res.status(201).json(updated);
});

app.delete('/api/categories/custom/:category', requireAuth, async (req, res) => {
  const current = req.profile.customCategories || [];
  const updated = current.filter(c => c.toLowerCase() !== req.params.category.toLowerCase());
  await req.userDocRef.set({ customCategories: updated }, { merge: true });
  res.status(200).json(updated);
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
  const threshold = req.profile.budgetNudgeThreshold ?? 80;
  const nearOrOver = progress.filter(b => b.percent >= threshold);
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

// --- Spend prediction / what-if simulator ---
// All projection math (category averages, net worth over time) happens
// here in code — deterministic and auditable. The frontend runs sliders
// against this same math client-side for instant feedback; AI is only
// ever asked to narrate numbers that were already computed, never to do
// the arithmetic itself.

app.get('/api/predict/baseline', requireAuth, async (req, res) => {
  const monthsBack = 3;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const [txSnapshot, savingsSnapshot, incomeSnapshot] = await Promise.all([
    req.transactionsRef.get(),
    req.savingsRef.get(),
    req.incomeRef.get()
  ]);

  const recentTx = txSnapshot.docs.map(d => d.data()).filter(t => t.date >= cutoffStr);
  const categoryTotals = {};
  recentTx.forEach(t => {
    categoryTotals[t.category] = (categoryTotals[t.category] || 0) + t.amount;
  });
  const categoryAverages = {};
  Object.entries(categoryTotals).forEach(([cat, total]) => {
    categoryAverages[cat] = total / monthsBack;
  });

  const currentNetWorth = savingsSnapshot.docs.reduce((sum, d) => sum + d.data().amount, 0);

  const today = new Date().toISOString().slice(0, 10);
  const incomeEntries = incomeSnapshot.docs.map(d => d.data());
  const activeIncome = incomeInEffectOn(incomeEntries, today);
  const monthlyIncome = activeIncome ? toMonthlyAmount(activeIncome.amount, activeIncome.frequency) : 0;

  res.json({ categoryAverages, currentNetWorth, monthlyIncome });
});

// Client already computed both the baseline and scenario final numbers
// using the same deterministic formula — this endpoint's only job is
// turning those two numbers into a plain-language sentence.
app.post('/api/predict/narrate', requireAuth, async (req, res) => {
  const { adjustments, incomeDeltaPercent, months, baselineFinal, scenarioFinal } = req.body;

  if (!groq) {
    return res.json({ narrative: "AI narration isn't configured — set GROQ_API_KEY on the backend." });
  }

  const adjustmentsText = (adjustments || [])
    .filter(a => a.deltaAmount)
    .map(a => `${a.category}: ${a.deltaAmount > 0 ? '+' : ''}$${a.deltaAmount}/month`)
    .join(', ') || 'no category changes';
  const incomeText = incomeDeltaPercent
    ? `income changed by ${incomeDeltaPercent > 0 ? '+' : ''}${incomeDeltaPercent}%`
    : 'no income change';

  const prompt = `A user is exploring a what-if financial scenario over ${months} months.
Adjustments: ${adjustmentsText}. ${incomeText}.
Baseline projected net worth after ${months} months (no changes): $${Number(baselineFinal).toFixed(2)}.
Scenario projected net worth after ${months} months (with the changes above): $${Number(scenarioFinal).toFixed(2)}.

Write one or two short, plain-language sentences explaining what these numbers mean for the user.
Use these exact numbers — do not recalculate or estimate anything yourself.`;

  try {
    const narrative = await callGroq(prompt, 300);
    res.json({ narrative });
  } catch (err) {
    res.json({ narrative: null });
  }
});

// --- Financial health score ---
// Every component score is computed deterministically from real data.
// AI's only job is a short encouragement + tip sentence at the end, using
// the exact scores already calculated — never asked to grade anything itself.

app.get('/api/health-score', requireAuth, async (req, res) => {
  const months = lastNMonths(3);
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);

  const [txSnapshot, incomeSnapshot, savingsSnapshot, budgetsSnapshot] = await Promise.all([
    req.transactionsRef.get(),
    req.incomeRef.get(),
    req.savingsRef.get(),
    req.budgetsRef.get()
  ]);

  const transactions = txSnapshot.docs.map(d => d.data());
  const incomeEntries = incomeSnapshot.docs.map(d => d.data());
  const savingsEntries = savingsSnapshot.docs.map(d => d.data());

  // Spending consistency (0-30): lower month-to-month variance = higher score.
  const monthlySpends = months.map(({ month }) =>
    transactions.filter(t => t.date.startsWith(month)).reduce((s, t) => s + t.amount, 0)
  );
  const avgSpend = monthlySpends.reduce((s, v) => s + v, 0) / monthlySpends.length || 0;
  const variance = monthlySpends.reduce((s, v) => s + Math.pow(v - avgSpend, 2), 0) / monthlySpends.length || 0;
  const coefficientOfVariation = avgSpend > 0 ? Math.sqrt(variance) / avgSpend : 0;
  const consistencyScore = Math.max(0, Math.min(30, 30 - coefficientOfVariation * 60));

  // Savings rate (0-40): % of this month's income actually saved.
  const activeIncome = incomeInEffectOn(incomeEntries, today);
  const monthlyIncome = activeIncome ? toMonthlyAmount(activeIncome.amount, activeIncome.frequency) : 0;
  const savedThisMonth = savingsEntries.filter(s => s.date.startsWith(currentMonth)).reduce((s, v) => s + v.amount, 0);
  const savingsRate = monthlyIncome > 0 ? (savedThisMonth / monthlyIncome) * 100 : 0;
  const savingsScore = Math.max(0, Math.min(40, (savingsRate / 30) * 40));

  // Budget adherence (0-30): % of your set budgets you're staying within this month.
  const budgetsList = budgetsSnapshot.docs.map(d => ({ category: d.id, limit: d.data().limit }));
  let budgetScore = 15; // neutral default if no budgets are set yet
  if (budgetsList.length > 0) {
    const spentByCategory = {};
    transactions.filter(t => t.date.startsWith(currentMonth)).forEach(t => {
      spentByCategory[t.category] = (spentByCategory[t.category] || 0) + t.amount;
    });
    const withinBudget = budgetsList.filter(b => (spentByCategory[b.category] || 0) <= b.limit).length;
    budgetScore = (withinBudget / budgetsList.length) * 30;
  }

  const score = Math.round(savingsScore + budgetScore + consistencyScore);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  let tip = null;
  if (groq) {
    const prompt = `A user's financial health score is ${score}/100 (grade ${grade}), made up of:
- Savings rate: ${savingsScore.toFixed(0)}/40 (they saved ${savingsRate.toFixed(0)}% of income this month)
- Budget adherence: ${budgetScore.toFixed(0)}/30
- Spending consistency: ${consistencyScore.toFixed(0)}/30

Write one short, encouraging sentence naming their strongest area, then one practical tip for
their weakest area. Use only the numbers given — do not recalculate anything.`;
    try {
      tip = await callGroq(prompt, 200);
    } catch (err) {
      tip = null;
    }
  }

  res.json({
    score,
    grade,
    components: {
      savingsRate: { score: Math.round(savingsScore), max: 40, value: Math.round(savingsRate) },
      budgetAdherence: { score: Math.round(budgetScore), max: 30 },
      consistency: { score: Math.round(consistencyScore), max: 30 }
    },
    tip
  });
});

// --- Household mode (MVP) ---
// Two-person shared spending view: invite by email, accept/decline, then
// see a combined category breakdown and a 50/50 settle-up for the current
// month. Deliberately scoped down from "merge everything" — budgets,
// recurring transactions, income, and chat all stay private to each
// person; only the read-only spending aggregate is shared.
//
// Security note: reading another member's transactionsRef only ever
// happens after explicitly verifying, server-side, that both users are
// confirmed members of the same household document — the Admin SDK can
// read any user's data, so that verification step is what keeps this safe.

app.post('/api/household/invite', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.trim()) {
    return res.status(400).json({ error: 'email is required' });
  }
  if (req.profile.householdId) {
    return res.status(400).json({ error: "You're already in a household — leave it first to invite someone new." });
  }

  let targetUser;
  try {
    targetUser = await auth.getUserByEmail(email.trim());
  } catch (err) {
    return res.status(404).json({ error: 'No account found with that email.' });
  }

  if (targetUser.uid === req.uid) {
    return res.status(400).json({ error: "You can't invite yourself." });
  }

  const inviteRef = await db.collection('householdInvites').add({
    fromUid: req.uid,
    fromEmail: req.profile.email || null,
    fromName: req.profile.displayName || null,
    toUid: targetUser.uid,
    toEmail: targetUser.email,
    status: 'pending',
    createdAt: new Date().toISOString()
  });

  res.status(201).json({ id: inviteRef.id });
});

app.get('/api/household/invites', requireAuth, async (req, res) => {
  const snapshot = await db.collection('householdInvites')
    .where('toUid', '==', req.uid)
    .where('status', '==', 'pending')
    .get();
  res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.post('/api/household/invites/:id/accept', requireAuth, async (req, res) => {
  const inviteRef = db.collection('householdInvites').doc(req.params.id);
  const inviteSnap = await inviteRef.get();
  if (!inviteSnap.exists) return res.status(404).json({ error: 'Invite not found' });

  const invite = inviteSnap.data();
  if (invite.toUid !== req.uid) return res.status(403).json({ error: 'Not your invite' });
  if (invite.status !== 'pending') return res.status(400).json({ error: 'Invite already handled' });

  const householdRef = await db.collection('households').add({
    members: [invite.fromUid, invite.toUid],
    createdAt: new Date().toISOString()
  });

  await Promise.all([
    inviteRef.update({ status: 'accepted' }),
    db.collection('users').doc(invite.fromUid).set({ householdId: householdRef.id }, { merge: true }),
    db.collection('users').doc(invite.toUid).set({ householdId: householdRef.id }, { merge: true })
  ]);

  res.json({ householdId: householdRef.id });
});

app.post('/api/household/invites/:id/decline', requireAuth, async (req, res) => {
  const inviteRef = db.collection('householdInvites').doc(req.params.id);
  const inviteSnap = await inviteRef.get();
  if (!inviteSnap.exists) return res.status(404).json({ error: 'Invite not found' });
  if (inviteSnap.data().toUid !== req.uid) return res.status(403).json({ error: 'Not your invite' });

  await inviteRef.update({ status: 'declined' });
  res.status(204).end();
});

app.get('/api/household', requireAuth, async (req, res) => {
  if (!req.profile.householdId) {
    return res.json({ household: null });
  }
  const householdSnap = await db.collection('households').doc(req.profile.householdId).get();
  if (!householdSnap.exists) {
    return res.json({ household: null });
  }
  const { members } = householdSnap.data();
  const memberInfo = await Promise.all(members.map(async uid => {
    const [profileSnap, authUser] = await Promise.all([
      db.collection('users').doc(uid).get(),
      auth.getUser(uid).catch(() => null)
    ]);
    return {
      uid,
      displayName: profileSnap.data()?.displayName || authUser?.email || 'Member',
      email: authUser?.email || null
    };
  }));

  res.json({ household: { id: req.profile.householdId, members: memberInfo } });
});

app.delete('/api/household/leave', requireAuth, async (req, res) => {
  if (!req.profile.householdId) {
    return res.status(400).json({ error: 'Not in a household' });
  }
  const householdRef = db.collection('households').doc(req.profile.householdId);
  const householdSnap = await householdRef.get();

  if (householdSnap.exists) {
    const { members } = householdSnap.data();
    const otherMember = members.find(uid => uid !== req.uid);
    await Promise.all([
      householdRef.delete(),
      db.collection('users').doc(req.uid).set({ householdId: null }, { merge: true }),
      otherMember ? db.collection('users').doc(otherMember).set({ householdId: null }, { merge: true }) : Promise.resolve()
    ]);
  } else {
    await db.collection('users').doc(req.uid).set({ householdId: null }, { merge: true });
  }

  res.status(204).end();
});

// Combined current-month category spending across both household members,
// plus a simple 50/50 settle-up: who owes whom to make this month even.
app.get('/api/household/spending', requireAuth, async (req, res) => {
  if (!req.profile.householdId) {
    return res.status(400).json({ error: 'Not in a household' });
  }
  const householdSnap = await db.collection('households').doc(req.profile.householdId).get();
  if (!householdSnap.exists) {
    return res.status(404).json({ error: 'Household not found' });
  }
  const { members } = householdSnap.data();
  // Explicit membership check — this is what makes it safe to read another
  // user's transactions with the Admin SDK below.
  if (!members.includes(req.uid)) {
    return res.status(403).json({ error: 'Not a member of this household' });
  }

  const currentMonth = new Date().toISOString().slice(0, 7);

  const memberSpending = await Promise.all(members.map(async uid => {
    const [profileSnap, txSnapshot] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(uid).collection('transactions').get()
    ]);
    const transactions = txSnapshot.docs.map(d => d.data()).filter(t => t.date.startsWith(currentMonth));
    const total = transactions.reduce((sum, t) => sum + t.amount, 0);
    const byCategory = {};
    transactions.forEach(t => { byCategory[t.category] = (byCategory[t.category] || 0) + t.amount; });
    return {
      uid,
      displayName: profileSnap.data()?.displayName || 'Member',
      total,
      byCategory
    };
  }));

  const combinedTotal = memberSpending.reduce((sum, m) => sum + m.total, 0);
  const fairShare = combinedTotal / memberSpending.length;

  const settleUp = memberSpending.map(m => ({
    uid: m.uid,
    displayName: m.displayName,
    spent: m.total,
    balance: m.total - fairShare // positive = they overpaid, owed money; negative = they owe
  }));

  res.json({ memberSpending, combinedTotal, settleUp });
});

// --- Receipt OCR ---
// Same "review before saving" philosophy as PDF import: AI extracts
// proposed line items from a photo, nothing is saved until the user
// reviews and confirms via the existing /api/transactions/import-confirm
// route (shared with the PDF import flow — no new confirm endpoint needed).

app.post('/api/transactions/receipt', requireAuth, upload.single('receipt'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded (expected field name "receipt")' });
  }
  if (!req.file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: 'Only image files are supported' });
  }
  if (!groq) {
    return res.status(503).json({ error: 'AI is not configured on the backend' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const base64Image = req.file.buffer.toString('base64');

  const prompt = `Extract the transaction details from this receipt image. Identify the merchant
name, the purchase date (YYYY-MM-DD format — if no date is visible, use ${today}), and every
line item with its price. If tax is shown separately, include it as its own item named "Tax".

Respond with ONLY valid JSON, no markdown fences, no explanation, in exactly this shape:
{"merchant": "string", "date": "YYYY-MM-DD", "items": [{"description": "string", "amount": number}]}

If you can't read any items clearly, respond with {"merchant": null, "date": "${today}", "items": []}`;

  try {
    const completion = await groq.chat.completions.create({
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${req.file.mimetype};base64,${base64Image}` } }
        ]
      }],
      max_tokens: 2000
    });

    const raw = completion.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.items || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      return res.status(422).json({ error: "Couldn't find any items on that receipt — try a clearer photo." });
    }

    const existingSnapshot = await req.transactionsRef.get();
    const existingKeys = new Set(
      existingSnapshot.docs.map(doc => {
        const t = doc.data();
        return `${t.date}|${t.amount.toFixed(2)}`;
      })
    );

    const proposed = [];
    for (const item of parsed.items) {
      if (!item.description || typeof item.amount !== 'number') continue;
      const description = parsed.merchant ? `${item.description} (${parsed.merchant})` : item.description;
      const category = await categorize(description, item.amount, req.categories);
      const isDuplicate = existingKeys.has(`${parsed.date}|${item.amount.toFixed(2)}`);
      proposed.push({ date: parsed.date, description, amount: item.amount, category, isDuplicate, type: 'debit' });
    }

    res.json({ merchant: parsed.merchant || null, transactions: proposed });
  } catch (err) {
    console.error('Receipt OCR failed:', err.message);
    res.status(422).json({ error: "Couldn't read that receipt — try a clearer, well-lit photo." });
  }
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
