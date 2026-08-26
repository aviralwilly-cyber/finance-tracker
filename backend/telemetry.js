// Operational telemetry: AI token usage, backend errors, and how often
// users override an AI-assigned category.
//
// Every write here is deliberately fire-and-forget and wrapped so a
// telemetry failure can never break the request that triggered it —
// observability that takes down the thing it observes is worse than none.
//
// The one exception is the admin audit log (in server.js), which
// intentionally DOES fail closed: privileged data access that can't be
// recorded shouldn't happen at all.

import { db } from './firestore.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// --- AI usage ---
// Groq's free tier caps tokens per day, and hitting that ceiling silently
// turns every AI feature into a fallback. Logging per-call usage makes the
// budget visible before it runs out rather than after.
// `provider` matters because the app now uses two, with completely separate
// quotas: Groq is capped on tokens/day, OpenRouter (Nemotron) on requests/day.
// Summing them into one number made the Groq budget gauge read as nearly
// exhausted when deep-analysis tokens — which don't touch Groq at all — were
// counted against it.
export function logAiUsage({ feature, model, provider, promptTokens, completionTokens, ok, errorCode }) {
  if (!db) return;
  const now = new Date();
  db.collection('aiUsageLog').add({
    feature,                       // 'categorize' | 'chat' | 'statement_extract' | ...
    model: model || null,
    provider: provider || 'groq',  // 'groq' | 'openrouter'
    promptTokens: promptTokens || 0,
    completionTokens: completionTokens || 0,
    totalTokens: (promptTokens || 0) + (completionTokens || 0),
    ok: ok !== false,
    errorCode: errorCode || null,  // e.g. 'rate_limit_exceeded'
    at: now.toISOString(),
    day: now.toISOString().slice(0, 10) // denormalised for cheap per-day grouping
  }).catch(() => {});
}

// --- Errors ---
// Backend failures currently vanish into the server terminal. This keeps
// them queryable, attributed to the feature that threw.
export function logError({ feature, message, uid }) {
  if (!db) return;
  db.collection('errorLog').add({
    feature,
    message: String(message).slice(0, 500), // bound the size; stack traces get long
    uid: uid || null,
    at: new Date().toISOString()
  }).catch(() => {});
}

// --- Feature funnel ---
// Records that a user reached a given step, so drop-off between steps
// (e.g. opened the import wizard vs. actually confirmed an import) is
// measurable rather than guessed at.
export function logFunnelStep({ feature, step, uid }) {
  if (!db) return;
  db.collection('funnelLog').add({
    feature,  // 'statement_import' | 'receipt_import'
    step,     // 'started' | 'extracted' | 'confirmed'
    uid: uid || null,
    at: new Date().toISOString()
  }).catch(() => {});
}

// --- Production categorization accuracy ---
// The offline eval measures accuracy against a synthetic labeled set. This
// measures it against reality: when a user changes a category the AI
// assigned, that's a real-world miss. Complements the eval rather than
// replacing it — real transaction descriptions are messier than any
// dataset written by hand.
export function logCategoryOverride({ uid, description, aiCategory, userCategory }) {
  if (!db) return;
  db.collection('categoryOverrideLog').add({
    uid: uid || null,
    // Stored to spot patterns (e.g. one merchant consistently miscategorized).
    // This is transaction content, so it's admin-visible — noted in the
    // README's privacy section rather than buried here.
    description: String(description).slice(0, 120),
    aiCategory,
    userCategory,
    at: new Date().toISOString()
  }).catch(() => {});
}

// --- Aggregation helpers, used by the admin endpoints ---

export async function getAiUsageStats(days = 7) {
  const empty = {
    byDay: {}, byFeature: {}, todayTokens: 0, failures: 0, totalCalls: 0,
    groq: { todayTokens: 0, byFeature: {}, failures: 0 },
    openrouter: { todayRequests: 0, todayTokens: 0, byFeature: {}, failures: 0 }
  };
  if (!db) return empty;

  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
  const snapshot = await db.collection('aiUsageLog').where('at', '>=', cutoff).get();

  const today = new Date().toISOString().slice(0, 10);
  const byDay = {};
  const byFeature = {};
  let todayTokens = 0;
  let failures = 0;

  const groq = { todayTokens: 0, byFeature: {}, failures: 0 };
  const openrouter = { todayRequests: 0, todayTokens: 0, byFeature: {}, failures: 0 };

  snapshot.docs.forEach(doc => {
    const e = doc.data();
    // Entries written before provider tagging existed are all Groq —
    // deep analysis is the only thing that has ever used OpenRouter.
    const provider = e.provider || 'groq';
    const isToday = e.day === today;

    byDay[e.day] = (byDay[e.day] || 0) + e.totalTokens;
    byFeature[e.feature] = (byFeature[e.feature] || 0) + e.totalTokens;
    if (isToday) todayTokens += e.totalTokens;
    if (e.ok === false) failures++;

    if (provider === 'openrouter') {
      openrouter.byFeature[e.feature] = (openrouter.byFeature[e.feature] || 0) + e.totalTokens;
      if (isToday) {
        // OpenRouter's free tier limits REQUESTS per day, not tokens, so
        // that's the number worth watching here.
        openrouter.todayRequests++;
        openrouter.todayTokens += e.totalTokens;
      }
      if (e.ok === false) openrouter.failures++;
    } else {
      groq.byFeature[e.feature] = (groq.byFeature[e.feature] || 0) + e.totalTokens;
      if (isToday) groq.todayTokens += e.totalTokens;
      if (e.ok === false) groq.failures++;
    }
  });

  return { byDay, byFeature, todayTokens, failures, totalCalls: snapshot.size, groq, openrouter };
}

export async function getRecentErrors(limit = 50) {
  if (!db) return [];
  const snapshot = await db.collection('errorLog').orderBy('at', 'desc').limit(limit).get();
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getFunnelStats(days = 30) {
  if (!db) return {};
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
  const snapshot = await db.collection('funnelLog').where('at', '>=', cutoff).get();

  const funnels = {};
  snapshot.docs.forEach(doc => {
    const { feature, step } = doc.data();
    funnels[feature] = funnels[feature] || {};
    funnels[feature][step] = (funnels[feature][step] || 0) + 1;
  });
  return funnels;
}

export async function getCategoryAccuracy(days = 30) {
  if (!db) return { overrides: 0, byPair: [], recentExamples: [] };

  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
  const snapshot = await db.collection('categoryOverrideLog').where('at', '>=', cutoff).get();

  const pairCounts = {};
  snapshot.docs.forEach(doc => {
    const { aiCategory, userCategory } = doc.data();
    const key = `${aiCategory} → ${userCategory}`;
    pairCounts[key] = (pairCounts[key] || 0) + 1;
  });

  const byPair = Object.entries(pairCounts)
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const recentExamples = snapshot.docs
    .map(d => d.data())
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 10);

  return { overrides: snapshot.size, byPair, recentExamples };
}
