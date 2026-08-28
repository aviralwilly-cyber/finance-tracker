// Deterministic, dependency-free logic — no Firestore, no Groq, no Express.
// Extracted here specifically so it can be unit tested in isolation. This is
// the "AI never touches numbers" boundary made literal: everything in this
// file is pure input → output math, safe to test exhaustively and safe to
// trust without ever calling an AI model.

export const CATEGORY_SETS = {
  self: ['Groceries', 'Dining', 'Transport', 'Rent/Housing', 'Utilities', 'Entertainment', 'Shopping', 'Health', 'Travel', 'Subscriptions', 'Other'],
  business: ['Office Supplies', 'Client Meals', 'Software & Subscriptions', 'Business Travel', 'Marketing', 'Professional Services', 'Equipment', 'Rent/Utilities', 'Payroll', 'Other'],
  other: ['Groceries', 'Dining', 'Transport', 'Bills', 'Entertainment', 'Shopping', 'Health', 'Travel', 'Subscriptions', 'Other']
};

export function categoriesFor(purpose, customCategories = []) {
  const base = CATEGORY_SETS[purpose] || CATEGORY_SETS.self;
  const baseLower = new Set(base.map(c => c.toLowerCase()));
  const additions = customCategories.filter(c => !baseLower.has(c.toLowerCase()));
  return [...base, ...additions];
}

export const SAVINGS_TYPES = ['Savings', 'Investment', 'Retirement', 'Other'];

// Converts any income entry to a monthly-equivalent amount.
// Biweekly = 26 pay periods/year, so monthly equivalent = amount * 26 / 12.
export function toMonthlyAmount(amount, frequency) {
  if (frequency === 'biweekly') return amount * (26 / 12);
  return amount; // 'monthly'
}

// Given a list of income entries (each with amount, frequency, effectiveDate)
// and a target date, finds the entry that was in effect on that date —
// i.e. the most recent entry whose effectiveDate is on or before it.
// This is what makes income "history" actually work: a raise you log today
// doesn't retroactively change what your income was three months ago.
export function incomeInEffectOn(incomeEntries, targetDate) {
  const applicable = incomeEntries
    .filter(e => e.effectiveDate <= targetDate)
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1));
  return applicable[0] || null;
}

// Builds the last `count` months (oldest first) as { month: 'YYYY-MM',
// lastDay: 'YYYY-MM-DD' } — the last day of each month is what we check
// income/spending/saving against, so a mid-month raise still counts for
// that whole month.
export function lastNMonths(count, referenceDate = new Date()) {
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const lastDayNum = new Date(year, month, 0).getDate();
    const lastDay = `${monthStr}-${String(lastDayNum).padStart(2, '0')}`;
    months.push({ month: monthStr, lastDay });
  }
  return months;
}

// Days remaining in the current month, inclusive of today. Takes a
// YYYY-MM-DD string (matching how dates are stored/passed everywhere else
// in this app) rather than a Date object.
export function daysLeftInMonth(today) {
  const [year, month] = today.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
  const currentDay = Number(today.slice(8, 10));
  return lastDay - currentDay;
}

// Advances a YYYY-MM-DD date by one period of the given recurring frequency.
// For 'monthly', clamps to the last valid day of the target month instead of
// letting JS's setMonth() silently roll over — e.g. Jan 31 + 1 month would
// otherwise become March 3rd, silently skipping February entirely.
export function advanceDate(dateStr, frequency) {
  const d = new Date(dateStr + 'T00:00:00');
  if (frequency === 'weekly') {
    d.setDate(d.getDate() + 7);
  } else if (frequency === 'biweekly') {
    d.setDate(d.getDate() + 14);
  } else {
    const originalDay = d.getDate();
    d.setDate(1); // avoid overflow while changing the month itself
    d.setMonth(d.getMonth() + 1);
    const daysInTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(originalDay, daysInTargetMonth));
  }
  return d.toISOString().slice(0, 10);
}

// --- Scotiabank "Day-to-Day Banking" statement parser ---
// Fully deterministic: no AI involved. The key insight is that every line
// shows a running balance, so debit/credit is determined by comparing each
// line's balance to the previous line's — not by guessing from column
// position, which text extraction can scramble.

export const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

export function isScotiabankDayToDayStatement(text) {
  // "Scotiabank" and "Day-to-Day Banking" in the header are part of a logo
  // graphic, not real text — pdf-parse never sees them. These signals ARE
  // genuinely present in the extracted text: the internal reference code
  // format, the support phone number, and the transaction table headers.
  const hasScotiabankMarker = /SBSAV\d/i.test(text) || /4-SCOTIA/i.test(text) || /472-6842/.test(text);
  const hasTransactionTable = /withdrawn\s*\(\$\)/i.test(text) && /deposited\s*\(\$\)/i.test(text);
  return hasScotiabankMarker && hasTransactionTable;
}

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

export function parseScotiabankDayToDayStatement(text) {
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

// Splits extracted PDF text into manageable chunks for the AI to parse —
// prefers splitting on page breaks (what pdf-parse inserts between pages),
// falling back to a character-count split for PDFs with no page markers.
// Every chunk is then hard-capped in size regardless of source, since
// Groq's free tier caps openai/gpt-oss-120b at 8000 tokens TOTAL per
// request (input + output combined) — an oversized single page could
// otherwise slip through the page-break path uncapped.
export const MAX_STATEMENT_CHUNKS = 8;
export const MAX_CHUNK_CHARS = 3500;

export function splitToMaxSize(str) {
  const parts = [];
  for (let i = 0; i < str.length; i += MAX_CHUNK_CHARS) {
    parts.push(str.slice(i, i + MAX_CHUNK_CHARS));
  }
  return parts;
}

export function chunkStatementText(text) {
  let pages = text.split('\f').map(p => p.trim()).filter(Boolean);
  if (pages.length <= 1) {
    pages = splitToMaxSize(text); // no page markers — fall back to fixed-size chunks
  } else {
    pages = pages.flatMap(splitToMaxSize); // guard against any oversized individual page
  }
  const truncated = pages.length > MAX_STATEMENT_CHUNKS;
  return { chunks: pages.slice(0, MAX_STATEMENT_CHUNKS), truncated };
}

// --- Recurring bill detection ---
//
// Finds subscriptions and bills already hiding in transaction history, so
// someone doesn't have to remember and manually declare every one.
//
// Deliberately deterministic — no AI. The signal here is structural
// (same merchant, similar amount, evenly spaced dates), which is exactly
// the kind of pattern code is better at than a language model, and it means
// the result is explainable: every suggestion can say WHY it was flagged.

// Merchant descriptions are noisy — "NETFLIX.COM 8668396" and
// "NETFLIX.COM 8661234" are the same subscription with a different
// reference number. Strip the parts that vary between charges.
export function normalizeMerchant(description) {
  return (description || '')
    .toLowerCase()
    .replace(/\d{4,}/g, ' ')                    // long digit runs: refs, card fragments
    .replace(/#\s*\w+/g, ' ')                   // store numbers: "#2917"
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ') // embedded dates
    .replace(/[^a-z\s]/g, ' ')                  // punctuation
    .replace(/\b(inc|llc|ltd|com|ca|corp|co)\b/g, ' ') // corporate suffixes
    .replace(/\s+/g, ' ')
    .trim();
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

function median(numbers) {
  const sorted = [...numbers].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Maps an average gap in days onto one of the frequencies the recurring
// system already supports. Tolerances are wide enough to absorb weekend
// shifts and "3rd of the month" drift across months of differing lengths.
function inferFrequency(avgGapDays) {
  if (avgGapDays >= 6 && avgGapDays <= 8) return 'weekly';
  if (avgGapDays >= 12 && avgGapDays <= 16) return 'biweekly';
  if (avgGapDays >= 26 && avgGapDays <= 35) return 'monthly';
  return null; // not a cadence we can represent — don't guess
}

export const MIN_OCCURRENCES = 3;          // two charges could be coincidence
export const AMOUNT_TOLERANCE = 0.15;      // 15% — covers usage-based bills like hydro
export const GAP_IRREGULARITY_LIMIT = 0.25; // spacing must be reasonably even

// Returns suggested recurring rules, each with the evidence behind it.
// `existingRecurring` suppresses anything the user already tracks.
export function detectRecurringBills(transactions, existingRecurring = [], today = new Date().toISOString().slice(0, 10)) {
  const alreadyTracked = new Set(
    existingRecurring.map(r => normalizeMerchant(r.description)).filter(Boolean)
  );

  // Group by normalized merchant.
  const groups = {};
  for (const t of transactions) {
    if (t.type === 'credit') continue; // income/refunds aren't bills
    const key = normalizeMerchant(t.description);
    if (!key || key.length < 3) continue;
    (groups[key] = groups[key] || []).push(t);
  }

  const suggestions = [];

  for (const [key, group] of Object.entries(groups)) {
    if (group.length < MIN_OCCURRENCES) continue;
    if (alreadyTracked.has(key)) continue;

    const sorted = [...group].sort((a, b) => (a.date < b.date ? -1 : 1));

    // Amounts must be consistent. Median rather than mean so one anomalous
    // charge doesn't drag the baseline and mask a real pattern.
    const amounts = sorted.map(t => t.amount);
    const typicalAmount = median(amounts);
    if (typicalAmount <= 0) continue;
    const amountsConsistent = amounts.every(
      a => Math.abs(a - typicalAmount) / typicalAmount <= AMOUNT_TOLERANCE
    );
    if (!amountsConsistent) continue;

    // Dates must be evenly spaced. Three coffees in a random week share a
    // merchant and a price but aren't a subscription — the spacing is what
    // separates a bill from a habit.
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(daysBetween(sorted[i - 1].date, sorted[i].date));
    }
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (avgGap <= 0) continue;

    const maxDeviation = Math.max(...gaps.map(g => Math.abs(g - avgGap)));
    if (maxDeviation / avgGap > GAP_IRREGULARITY_LIMIT) continue;

    const frequency = inferFrequency(avgGap);
    if (!frequency) continue;

    const lastDate = sorted[sorted.length - 1].date;
    let nextDueDate = advanceDate(lastDate, frequency);
    // If the projected date already passed, roll forward so the suggestion
    // is actionable rather than retroactive.
    while (nextDueDate < today) {
      nextDueDate = advanceDate(nextDueDate, frequency);
    }

    suggestions.push({
      // Longest description in the group reads best — the shortest is often
      // truncated by the statement parser.
      description: sorted.map(t => t.description).sort((a, b) => b.length - a.length)[0],
      amount: Number(typicalAmount.toFixed(2)),
      category: sorted[sorted.length - 1].category,
      frequency,
      nextDueDate,
      // Evidence, so the UI can explain the suggestion rather than assert it.
      occurrences: sorted.length,
      averageGapDays: Math.round(avgGap),
      firstSeen: sorted[0].date,
      lastSeen: lastDate,
      sampleDates: sorted.map(t => t.date),
      totalSpent: Number(amounts.reduce((s, a) => s + a, 0).toFixed(2))
    });
  }

  // Most money first — a $2,100 rent payment matters more than a $3 app.
  return suggestions.sort((a, b) => b.amount - a.amount);
}

// --- Savings goals ---
//
// Envelope model: each goal holds its own allocated balance, so progress
// is unambiguous. The alternative — measuring every goal against one shared
// savings total — shows three goals worth $5,000 as partly funded when you
// have $2,000, which reads as more progress than actually exists.
//
// All deterministic. The interesting number here is "what do I need to put
// aside each month to make it", and that's arithmetic, not a judgement call.

export function monthsBetween(fromDate, toDate) {
  const from = new Date(fromDate + 'T00:00:00');
  const to = new Date(toDate + 'T00:00:00');
  const months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  // Partial month still counts as one — you can't save "0.4 months" of money.
  return to.getDate() >= from.getDate() ? months : months - 1;
}

// Given a goal and how much is allocated to it, works out whether it's
// reachable and what it takes. `recentMonthlySaving` is the user's actual
// recent rate, used to say whether they're on track rather than just
// stating a required number in isolation.
export function goalProgress(goal, today = new Date().toISOString().slice(0, 10), recentMonthlySaving = null) {
  const target = Number(goal.targetAmount) || 0;
  const saved = Number(goal.allocated) || 0;
  const remaining = Math.max(0, target - saved);
  const percent = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
  const complete = target > 0 && saved >= target;

  const result = {
    target,
    saved,
    remaining: Number(remaining.toFixed(2)),
    percent: Math.round(percent),
    complete,
    monthsLeft: null,
    requiredPerMonth: null,
    onTrack: null,
    overdue: false
  };

  if (!goal.targetDate || complete) return result;

  const monthsLeft = monthsBetween(today, goal.targetDate);
  result.monthsLeft = monthsLeft;

  if (monthsLeft < 0 || (monthsLeft === 0 && goal.targetDate < today)) {
    result.overdue = true;
    return result;
  }

  // Zero months left but the date hasn't passed means "this month" — the
  // whole remainder is needed now, not divided by zero.
  const effectiveMonths = Math.max(1, monthsLeft);
  result.requiredPerMonth = Number((remaining / effectiveMonths).toFixed(2));

  if (recentMonthlySaving !== null && recentMonthlySaving !== undefined) {
    result.onTrack = recentMonthlySaving >= result.requiredPerMonth;
  }

  return result;
}
