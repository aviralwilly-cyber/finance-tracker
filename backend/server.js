// MUST be first: ES module imports are all evaluated before any statement
// in this file runs, and ./ai.js and ./firestore.js both read process.env
// at import time. Importing 'dotenv/config' (rather than calling
// dotenv.config() further down) guarantees .env is loaded before they are.
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
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
import {
  logError,
  logFunnelStep,
  logCategoryOverride,
  getAiUsageStats,
  getRecentErrors,
  getFunnelStats,
  getCategoryAccuracy
} from './telemetry.js';
import { runFinancialAgent, agentAvailable } from './agent.js';

const app = express();
// In deployment, set FRONTEND_URL to the Vercel origin so only that site
// can call this API from a browser. Left unset (local dev), CORS stays
// open so localhost:5173 works without extra config.
app.use(cors({
  origin: process.env.FRONTEND_URL || true
}));
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

    // Activity tracking for admin analytics. Throttled to at most one write
    // per hour per user — without this, every single API call would issue a
    // Firestore write, which is both slow and needlessly expensive.
    const nowIso = new Date().toISOString();
    const lastActive = req.profile.lastActiveAt;
    if (!lastActive || (Date.now() - new Date(lastActive).getTime()) > 60 * 60 * 1000) {
      const update = { lastActiveAt: nowIso };
      if (!req.profile.createdAt) update.createdAt = nowIso; // backfill for pre-existing accounts
      req.userDocRef.set(update, { merge: true }).catch(() => {}); // never block the request
    }

    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// --- Admin authorization ---
//
// Runs AFTER requireAuth, so req.uid is already a verified token identity.
// The role is read from Firestore server-side — never from anything the
// client sends — so a user can't grant themselves admin by tampering with
// a request body, header, or local state.
//
// There is deliberately no "make me an admin" endpoint. The first admin is
// set by hand in the Firebase console (users/{uid}, add role: "admin"),
// because any self-service path here would be the weakest link in the app.
function requireAdmin(req, res, next) {
  if (req.profile?.role !== 'admin') {
    // Deliberately identical to a missing-resource response: a non-admin
    // shouldn't be able to discover which admin endpoints exist.
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

// Records every privileged read of another user's data. Admin analytics
// (aggregate counts) don't need this — nothing identifiable is exposed —
// but any endpoint that surfaces a specific person's financial records
// writes an entry here first, so privileged access is always attributable
// after the fact rather than invisible.
async function logAdminAccess(adminUid, targetUid, action) {
  try {
    await db.collection('adminAuditLog').add({
      adminUid,
      targetUid,
      action,
      at: new Date().toISOString()
    });
  } catch (err) {
    // Logging must not silently fail open — if we can't record the access,
    // we don't perform it.
    console.error('Admin audit log write failed:', err.message);
    throw new Error('Audit logging unavailable');
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

  const raw = await callGroq(prompt, 300, {}, 'quick_add_parse');
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
    raw = await callGroq(prompt, 4000, { reasoning_effort: 'low' }, 'statement_extract');
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(t => t.date && t.description && typeof t.amount === 'number' && (t.type === 'debit' || t.type === 'credit'));
  } catch (err) {
    console.error('Statement chunk parsing failed:', err.message);
    logError({ feature: 'statement_extract', message: err.message });
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
    const result = await callGroq(prompt, 300, {}, 'chat');
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
    return await callGroq(prompt, 300, {}, 'budget_nudge');
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
    householdId: req.profile.householdId || null,
    role: req.profile.role || 'user'
  });
});

app.post('/api/profile', requireAuth, async (req, res) => {
  // Deliberately an allowlist, not a spread of req.body. `role` is absent
  // and must stay absent — accepting it here would let any user promote
  // themselves to admin with a single crafted request.
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
  logFunnelStep({ feature: 'statement_import', step: 'started', uid: req.uid });
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
  // `source` is optional and only used for funnel attribution — both the
  // PDF and receipt wizards share this endpoint, so without it the two
  // flows would be indistinguishable in the drop-off stats.
  const { transactions, source } = req.body;
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

  logFunnelStep({
    feature: source === 'receipt' ? 'receipt_import' : 'statement_import',
    step: 'confirmed',
    uid: req.uid
  });

  res.json({ created });
});

// Changing a transaction's category. Beyond being useful on its own, this
// is the app's real-world accuracy signal for categorization: when a user
// corrects a category the AI assigned, that's a production miss on a real
// transaction description — messier and more honest than any hand-written
// eval set. Logged for the admin accuracy view.
app.patch('/api/transactions/:id', requireAuth, async (req, res) => {
  const { category } = req.body;
  if (!category || !req.categories.includes(category)) {
    return res.status(400).json({ error: 'A valid category is required' });
  }

  const docRef = req.transactionsRef.doc(req.params.id);
  const snap = await docRef.get();
  if (!snap.exists) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  const existing = snap.data();
  if (existing.category !== category) {
    logCategoryOverride({
      uid: req.uid,
      description: existing.description,
      aiCategory: existing.category,
      userCategory: category
    });
  }

  await docRef.update({ category });
  res.json({ id: req.params.id, ...existing, category });
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
    req.chatRef.orderBy('createdAt', 'desc').limit(6).get() // last 6 Q&A exchanges
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
    const narrative = await callGroq(prompt, 300, {}, 'predict_narrate');
    res.json({ narrative });
  } catch (err) {
    res.json({ narrative: null });
  }
});

// --- Financial health score ---
// Every component score is computed deterministically from real data.
// AI's only job is a short encouragement + tip sentence at the end, using
// the exact scores already calculated — never asked to grade anything itself.

// --- Deep analysis (agentic) ---
// Unlike /chat, which makes one Groq call with a pre-assembled context,
// this hands a reasoning model a set of deterministic tools and lets it
// decide what to investigate. See agent.js for why a second provider.

app.post('/api/analyze', requireAuth, async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }
  if (!agentAvailable) {
    return res.status(503).json({ error: 'Deep analysis is not configured — set OPENROUTER_API_KEY on the backend.' });
  }

  try {
    const result = await runFinancialAgent(question.trim(), req);
    res.json(result);
  } catch (err) {
    if (err.status === 429) {
      return res.status(429).json({ error: "Deep analysis has hit today's free-tier limit. Regular chat still works." });
    }
    res.status(502).json({ error: "The analysis didn't complete. Try again in a moment." });
  }
});

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

  // A brand-new account has no spending, which makes variance zero — which
  // the consistency formula reads as "perfectly consistent" and awards a
  // full 30/30 for. Combined with the neutral budget default, that hands
  // out 45 points for having done nothing, and then has the AI congratulate
  // the user on it. Refuse to score at all until there's something to
  // measure; an honest "not yet" beats a flattering fiction.
  const missing = [];
  if (transactions.length === 0) missing.push('some transactions');
  if (incomeEntries.length === 0) missing.push('your income');

  if (missing.length > 0) {
    return res.json({
      insufficientData: true,
      missing,
      message: `Add ${missing.join(' and ')} and your score will appear here.`
    });
  }

  // Spending consistency (0-30): lower month-to-month variance = higher score.
  // Only months that actually have data count — otherwise a new account's
  // empty back-months would drag an active user's variance around.
  const monthlySpends = months
    .map(({ month }) => transactions.filter(t => t.date.startsWith(month)).reduce((s, t) => s + t.amount, 0))
    .filter(total => total > 0);

  // With fewer than two months of real spending there's no variance to
  // measure yet, so award the neutral midpoint rather than a perfect score.
  let consistencyScore = 15;
  if (monthlySpends.length >= 2) {
    const avgSpend = monthlySpends.reduce((s, v) => s + v, 0) / monthlySpends.length;
    const variance = monthlySpends.reduce((s, v) => s + Math.pow(v - avgSpend, 2), 0) / monthlySpends.length;
    const coefficientOfVariation = avgSpend > 0 ? Math.sqrt(variance) / avgSpend : 0;
    consistencyScore = Math.max(0, Math.min(30, 30 - coefficientOfVariation * 60));
  }

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
      tip = await callGroq(prompt, 200, {}, 'health_score_tip');
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

  // Email lives in Firebase Auth, not the Firestore profile doc — reading
  // it off req.profile silently produced null on every invite.
  const inviter = await auth.getUser(req.uid).catch(() => null);

  // Don't stack duplicates — re-inviting the same person should be a no-op
  // rather than filling their list with identical pending invites.
  const existing = await db.collection('householdInvites')
    .where('fromUid', '==', req.uid)
    .where('toUid', '==', targetUser.uid)
    .where('status', '==', 'pending')
    .get();

  if (!existing.empty) {
    return res.status(200).json({ id: existing.docs[0].id, alreadyPending: true });
  }

  const inviteRef = await db.collection('householdInvites').add({
    fromUid: req.uid,
    fromEmail: inviter?.email || null,
    fromName: req.profile.displayName || null,
    toUid: targetUser.uid,
    toEmail: targetUser.email,
    status: 'pending',
    createdAt: new Date().toISOString()
  });

  res.status(201).json({ id: inviteRef.id });
});

app.get('/api/household/invites', requireAuth, async (req, res) => {
  const [receivedSnap, sentSnap] = await Promise.all([
    db.collection('householdInvites').where('toUid', '==', req.uid).where('status', '==', 'pending').get(),
    db.collection('householdInvites').where('fromUid', '==', req.uid).where('status', '==', 'pending').get()
  ]);

  res.json({
    received: receivedSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    // Without this the sender gets no feedback that the invite exists —
    // it just silently sits in the recipient's tab.
    sent: sentSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  });
});

app.delete('/api/household/invites/:id', requireAuth, async (req, res) => {
  const inviteRef = db.collection('householdInvites').doc(req.params.id);
  const snap = await inviteRef.get();
  if (!snap.exists) return res.status(404).json({ error: 'Invite not found' });
  if (snap.data().fromUid !== req.uid) return res.status(403).json({ error: 'Not your invite' });

  await inviteRef.delete();
  res.status(204).end();
});

app.post('/api/household/invites/:id/accept', requireAuth, async (req, res) => {
  const inviteRef = db.collection('householdInvites').doc(req.params.id);
  const inviteSnap = await inviteRef.get();
  if (!inviteSnap.exists) return res.status(404).json({ error: 'Invite not found' });

  const invite = inviteSnap.data();
  if (invite.toUid !== req.uid) return res.status(403).json({ error: 'Not your invite' });
  if (invite.status !== 'pending') return res.status(400).json({ error: 'Invite already handled' });
  if (req.profile.householdId) {
    return res.status(400).json({ error: "You're already in a household — leave it before joining another." });
  }

  const inviterSnap = await db.collection('users').doc(invite.fromUid).get();
  const existingHouseholdId = inviterSnap.data()?.householdId || null;

  let householdId;

  if (existingHouseholdId) {
    // The inviter is already in a household — join THAT one rather than
    // creating a second one, which would silently orphan the original.
    const householdRef = db.collection('households').doc(existingHouseholdId);
    const householdSnap = await householdRef.get();

    if (!householdSnap.exists) {
      return res.status(404).json({ error: 'That household no longer exists.' });
    }
    const members = householdSnap.data().members || [];
    if (members.length >= MAX_HOUSEHOLD_MEMBERS) {
      return res.status(400).json({ error: `That household is full (${MAX_HOUSEHOLD_MEMBERS} members max).` });
    }

    await householdRef.update({ members: [...members, req.uid] });
    householdId = existingHouseholdId;
  } else {
    const householdRef = await db.collection('households').add({
      members: [invite.fromUid, invite.toUid],
      createdAt: new Date().toISOString()
    });
    await db.collection('users').doc(invite.fromUid).set({ householdId: householdRef.id }, { merge: true });
    householdId = householdRef.id;
  }

  await Promise.all([
    inviteRef.update({ status: 'accepted' }),
    db.collection('users').doc(req.uid).set({ householdId }, { merge: true })
  ]);

  res.json({ householdId });
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

  if (!householdSnap.exists) {
    await db.collection('users').doc(req.uid).set({ householdId: null }, { merge: true });
    return res.status(204).end();
  }

  // Previously this deleted the whole household and evicted "the other
  // member" — which was survivable with exactly two people but would
  // dissolve the group for everyone once there are more. Now leaving
  // removes only the person leaving; the household is deleted only when
  // the last member walks out.
  const remaining = (householdSnap.data().members || []).filter(uid => uid !== req.uid);

  if (remaining.length === 0) {
    await householdRef.delete();
  } else {
    await householdRef.update({ members: remaining });
  }

  await db.collection('users').doc(req.uid).set({ householdId: null }, { merge: true });
  res.status(204).end();
});

// Current-month spending per household member. Read-only: each member's
// own transactions stay theirs, this only aggregates totals and category
// breakdowns for a shared view.
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

    // Most recent few, so the shared view shows activity rather than just
    // a bar height. Amount + category + date only — no merchant detail.
    const recent = transactions
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 3)
      .map(t => ({ date: t.date, category: t.category, amount: t.amount }));

    return {
      uid,
      displayName: profileSnap.data()?.displayName || 'Member',
      total,
      byCategory,
      recent
    };
  }));

  const combinedTotal = memberSpending.reduce((sum, m) => sum + m.total, 0);

  res.json({ memberSpending, combinedTotal });
});

// --- Shared household bills ---
// A list the household maintains together, separate from anyone's personal
// recurring transactions. Deliberately not derived from those: a shared
// hydro bill is a household fact, and shouldn't depend on one member
// having set it up privately (or disappear if they leave).

const HOUSEHOLD_MAX_MEMBERS = 10;

async function requireHouseholdMember(req, res) {
  if (!req.profile.householdId) {
    res.status(400).json({ error: 'Not in a household' });
    return null;
  }
  const ref = db.collection('households').doc(req.profile.householdId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).json({ error: 'Household not found' });
    return null;
  }
  if (!(snap.data().members || []).includes(req.uid)) {
    res.status(403).json({ error: 'Not a member of this household' });
    return null;
  }
  return { ref, data: snap.data() };
}

app.get('/api/household/bills', requireAuth, async (req, res) => {
  const household = await requireHouseholdMember(req, res);
  if (!household) return;

  const snapshot = await household.ref.collection('bills').orderBy('dueDate', 'asc').get();
  res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.post('/api/household/bills', requireAuth, async (req, res) => {
  const household = await requireHouseholdMember(req, res);
  if (!household) return;

  const { name, amount, dueDate, splitBetween } = req.body;
  if (!name || !name.trim() || amount === undefined || !dueDate) {
    return res.status(400).json({ error: 'name, amount, and dueDate are required' });
  }

  // Default to splitting across everyone; an explicit list lets a bill be
  // shared by only some members (e.g. only the two people with parking).
  const members = household.data.members || [];
  const split = Array.isArray(splitBetween) && splitBetween.length > 0
    ? splitBetween.filter(uid => members.includes(uid))
    : members;

  const bill = {
    name: name.trim(),
    amount: Number(amount),
    dueDate,
    splitBetween: split,
    paid: false,
    addedBy: req.uid,
    createdAt: new Date().toISOString()
  };

  const docRef = await household.ref.collection('bills').add(bill);
  res.status(201).json({ id: docRef.id, ...bill });
});

app.post('/api/household/bills/:id/paid', requireAuth, async (req, res) => {
  const household = await requireHouseholdMember(req, res);
  if (!household) return;

  const { paid } = req.body;
  await household.ref.collection('bills').doc(req.params.id).update({ paid: !!paid });
  res.json({ id: req.params.id, paid: !!paid });
});

app.delete('/api/household/bills/:id', requireAuth, async (req, res) => {
  const household = await requireHouseholdMember(req, res);
  if (!household) return;

  await household.ref.collection('bills').doc(req.params.id).delete();
  res.status(204).end();
});

// --- Household chat ---
// Plain messages between members. Not AI-backed — this is people talking
// to each other about shared costs, which doesn't need a model involved.

app.get('/api/household/messages', requireAuth, async (req, res) => {
  const household = await requireHouseholdMember(req, res);
  if (!household) return;

  const snapshot = await household.ref.collection('messages')
    .orderBy('at', 'desc').limit(100).get();

  // Reverse so the client renders oldest-first without re-sorting.
  res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })).reverse());
});

app.post('/api/household/messages', requireAuth, async (req, res) => {
  const household = await requireHouseholdMember(req, res);
  if (!household) return;

  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const message = {
    text: text.trim().slice(0, 1000),
    fromUid: req.uid,
    fromName: req.profile.displayName || 'Member',
    at: new Date().toISOString()
  };

  const docRef = await household.ref.collection('messages').add(message);
  res.status(201).json({ id: docRef.id, ...message });
});

// --- Admin ---
// Every route below is requireAuth + requireAdmin. See requireAdmin above
// for why the role is read server-side only.

// (A) Aggregate analytics. Reads counts and metadata only — deliberately
// never reads transaction contents, amounts, or descriptions, so even a
// bug here can't leak anyone's actual finances.
app.get('/api/admin/analytics', requireAuth, requireAdmin, async (req, res) => {
  const usersSnapshot = await db.collection('users').get();

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  let totalTransactions = 0;
  let usersWithIncome = 0;
  let usersWithBudgets = 0;
  let usersWithRecurring = 0;
  let usersInHousehold = 0;
  let activeThisWeek = 0;
  const purposeBreakdown = {};
  const signupsByDay = {};

  for (const doc of usersSnapshot.docs) {
    const profile = doc.data();

    if (profile.purpose) {
      purposeBreakdown[profile.purpose] = (purposeBreakdown[profile.purpose] || 0) + 1;
    }
    if (profile.householdId) usersInHousehold++;

    if (profile.createdAt) {
      const day = profile.createdAt.slice(0, 10);
      if (profile.createdAt >= thirtyDaysAgo) {
        signupsByDay[day] = (signupsByDay[day] || 0) + 1;
      }
    }
    if (profile.lastActiveAt && profile.lastActiveAt >= weekAgo) activeThisWeek++;

    // Counts only — .size never exposes document contents.
    const [txSnap, incomeSnap, budgetsSnap, recurringSnap] = await Promise.all([
      doc.ref.collection('transactions').get(),
      doc.ref.collection('income').get(),
      doc.ref.collection('budgets').get(),
      doc.ref.collection('recurring').get()
    ]);

    totalTransactions += txSnap.size;
    if (incomeSnap.size > 0) usersWithIncome++;
    if (budgetsSnap.size > 0) usersWithBudgets++;
    if (recurringSnap.size > 0) usersWithRecurring++;
  }

  res.json({
    totalUsers: usersSnapshot.size,
    activeThisWeek,
    totalTransactions,
    avgTransactionsPerUser: usersSnapshot.size > 0 ? Math.round(totalTransactions / usersSnapshot.size) : 0,
    featureAdoption: {
      income: usersWithIncome,
      budgets: usersWithBudgets,
      recurring: usersWithRecurring,
      household: usersInHousehold
    },
    purposeBreakdown,
    signupsByDay
  });
});

// (B) Account management. Returns account-level metadata and activity
// counts — never transaction contents. Enough to help someone with a
// login or account problem, not enough to see what they spend money on.
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const usersSnapshot = await db.collection('users').get();

  const users = await Promise.all(usersSnapshot.docs.map(async doc => {
    const profile = doc.data();
    const authUser = await auth.getUser(doc.id).catch(() => null);
    const [txSnap, savingsSnap] = await Promise.all([
      doc.ref.collection('transactions').get(),
      doc.ref.collection('savings').get()
    ]);

    return {
      uid: doc.id,
      email: authUser?.email || null,
      displayName: profile.displayName || null,
      purpose: profile.purpose || null,
      role: profile.role || 'user',
      disabled: authUser?.disabled ?? false,
      createdAt: authUser?.metadata?.creationTime || null,
      lastSignIn: authUser?.metadata?.lastSignInTime || null,
      transactionCount: txSnap.size,
      savingsCount: savingsSnap.size,
      inHousehold: !!profile.householdId
    };
  }));

  res.json(users);
});

app.post('/api/admin/users/:uid/disable', requireAuth, requireAdmin, async (req, res) => {
  const { disabled } = req.body;
  if (req.params.uid === req.uid) {
    return res.status(400).json({ error: "You can't disable your own admin account." });
  }
  try {
    await auth.updateUser(req.params.uid, { disabled: !!disabled });
    await logAdminAccess(req.uid, req.params.uid, disabled ? 'disable_account' : 'enable_account');
    res.json({ uid: req.params.uid, disabled: !!disabled });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/users/:uid/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const authUser = await auth.getUser(req.params.uid);
    // Generates a link rather than setting a password directly — the admin
    // never learns or chooses the user's new credentials.
    const link = await auth.generatePasswordResetLink(authUser.email);
    await logAdminAccess(req.uid, req.params.uid, 'generate_password_reset');
    res.json({ link });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// (C) Privileged read of a specific user's financial data, for debugging
// reports like "the import mangled my statement".
//
// This is the one endpoint that exposes another person's actual
// transactions, so the audit entry is written BEFORE the data is read —
// if logging fails, the request fails and no data is returned. Access is
// always attributable after the fact.
app.get('/api/admin/users/:uid/transactions', requireAuth, requireAdmin, async (req, res) => {
  try {
    await logAdminAccess(req.uid, req.params.uid, 'view_transactions');
  } catch (err) {
    return res.status(503).json({ error: 'Audit logging is unavailable, so this request was refused.' });
  }

  const snapshot = await db.collection('users').doc(req.params.uid)
    .collection('transactions').orderBy('date', 'desc').limit(100).get();

  res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
});

// The audit log itself, so privileged access can be reviewed.
// Operational observability. Aggregates only — except category overrides,
// which include transaction descriptions by design (they're the accuracy
// signal itself). No amounts or balances are exposed here.
app.get('/api/admin/observability', requireAuth, requireAdmin, async (req, res) => {
  const [aiUsage, errors, funnels, accuracy] = await Promise.all([
    getAiUsageStats(7),
    getRecentErrors(50),
    getFunnelStats(30),
    getCategoryAccuracy(30)
  ]);

  res.json({
    aiUsage,
    errors,
    funnels,
    accuracy,
    // Groq's documented free-tier ceiling, so the UI can show usage
    // against the actual limit rather than an unlabelled number.
    dailyTokenLimit: 200000,      // Groq free tier: tokens/day
    dailyRequestLimit: 200        // OpenRouter free tier: requests/day
  });
});

// --- Admin actions (group 2) ---

// Promote/demote admins. Guarded so the last admin can't be removed —
// otherwise a single misclick locks everyone out of admin permanently,
// recoverable only by hand-editing Firestore.
app.post('/api/admin/users/:uid/role', requireAuth, requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: "role must be 'user' or 'admin'" });
  }

  if (role === 'user') {
    const adminsSnapshot = await db.collection('users').where('role', '==', 'admin').get();
    if (adminsSnapshot.size <= 1) {
      return res.status(400).json({ error: "Can't demote the last admin — promote someone else first." });
    }
  }

  await db.collection('users').doc(req.params.uid).set({ role }, { merge: true });
  await logAdminAccess(req.uid, req.params.uid, `set_role_${role}`);
  res.json({ uid: req.params.uid, role });
});

// App-wide settings: broadcast banner and signup gating. Kept in a single
// document so the public read below is one cheap fetch.
const APP_SETTINGS_DOC = () => db.collection('appSettings').doc('global');

app.get('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  const snap = await APP_SETTINGS_DOC().get();
  const data = snap.exists ? snap.data() : {};
  res.json({
    broadcastMessage: data.broadcastMessage || '',
    signupsEnabled: data.signupsEnabled !== false
  });
});

app.post('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  const { broadcastMessage, signupsEnabled } = req.body;
  const update = {};
  if (broadcastMessage !== undefined) update.broadcastMessage = String(broadcastMessage).slice(0, 300);
  if (signupsEnabled !== undefined) update.signupsEnabled = !!signupsEnabled;

  await APP_SETTINGS_DOC().set(update, { merge: true });
  res.json(update);
});

// Read-only, unauthenticated: the login page needs to know whether signups
// are open before anyone has an account, and every logged-in user needs the
// broadcast banner. Exposes nothing sensitive.
app.get('/api/public-settings', async (req, res) => {
  if (!db) return res.json({ broadcastMessage: '', signupsEnabled: true });
  const snap = await APP_SETTINGS_DOC().get();
  const data = snap.exists ? snap.data() : {};
  res.json({
    broadcastMessage: data.broadcastMessage || '',
    signupsEnabled: data.signupsEnabled !== false
  });
});

// All users as CSV. Account metadata and counts only — same boundary as the
// users table, so this can't become a backdoor around it.
app.get('/api/admin/users/export', requireAuth, requireAdmin, async (req, res) => {
  const usersSnapshot = await db.collection('users').get();

  const rows = await Promise.all(usersSnapshot.docs.map(async doc => {
    const profile = doc.data();
    const authUser = await auth.getUser(doc.id).catch(() => null);
    const txSnap = await doc.ref.collection('transactions').get();
    return {
      uid: doc.id,
      email: authUser?.email || '',
      displayName: profile.displayName || '',
      purpose: profile.purpose || '',
      role: profile.role || 'user',
      disabled: authUser?.disabled ? 'yes' : 'no',
      createdAt: authUser?.metadata?.creationTime || '',
      lastSignIn: authUser?.metadata?.lastSignInTime || '',
      transactionCount: txSnap.size
    };
  }));

  const headers = Object.keys(rows[0] || { uid: '' });
  const escape = (v) => `"${String(v).replace(/"/g, '""')}"`; // CSV-safe
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => escape(r[h])).join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.get('/api/admin/audit-log', requireAuth, requireAdmin, async (req, res) => {
  const snapshot = await db.collection('adminAuditLog')
    .orderBy('at', 'desc').limit(100).get();

  const entries = await Promise.all(snapshot.docs.map(async d => {
    const entry = d.data();
    const [adminUser, targetUser] = await Promise.all([
      auth.getUser(entry.adminUid).catch(() => null),
      auth.getUser(entry.targetUid).catch(() => null)
    ]);
    return {
      id: d.id,
      ...entry,
      adminEmail: adminUser?.email || entry.adminUid,
      targetEmail: targetUser?.email || entry.targetUid
    };
  }));

  res.json(entries);
});

// --- Receipt OCR ---
// Same "review before saving" philosophy as PDF import: AI extracts
// proposed line items from a photo, nothing is saved until the user
// reviews and confirms via the existing /api/transactions/import-confirm
// route (shared with the PDF import flow — no new confirm endpoint needed).

app.post('/api/transactions/receipt', requireAuth, upload.single('receipt'), async (req, res) => {
  logFunnelStep({ feature: 'receipt_import', step: 'started', uid: req.uid });
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
    logError({ feature: 'receipt_ocr', message: err.message, uid: req.uid });
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
    logError({ feature: 'unhandled', message: err.message || String(err), uid: req.uid });
    return res.status(500).json({ error: 'Something went wrong processing that request.' });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Finance tracker backend running on http://localhost:${PORT}`);
  if (!groq) {
    console.warn('⚠️  GROQ_API_KEY is not set — AI categorization and chat will fall back to defaults.');
  }
  if (!agentAvailable) {
    console.warn('⚠️  OPENROUTER_API_KEY is not set — deep analysis is disabled (everything else works).');
  }
  if (!db) {
    console.warn('⚠️  Firestore is not configured — see README for setup.');
  }
});
