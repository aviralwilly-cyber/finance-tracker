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
