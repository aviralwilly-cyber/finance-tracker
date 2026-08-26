// Agentic financial analysis via NVIDIA Nemotron (OpenRouter).
//
// WHY A SECOND PROVIDER:
// Groq handles the app's high-frequency, single-shot AI work — categorize
// one transaction, write one nudge sentence. It's fast and its free tier is
// measured in tokens/day, which suits many small calls.
//
// This is a different shape of problem: "why am I saving less than last
// year?" needs a model that PLANS — pull the trend, notice income changed,
// go check budgets, then synthesize. Nemotron is a reasoning/orchestration
// model built for exactly that, and its free tier (200 requests/day) fits a
// button someone presses occasionally rather than something that runs on
// every transaction.
//
// THE DETERMINISTIC BOUNDARY STILL HOLDS:
// The model never computes a number. Every tool below returns figures
// calculated by the same code paths the rest of the app uses. The model
// only decides WHICH questions to ask, in what order, and how to explain
// the answers. That's the same AI/code split as everywhere else — applied
// to a harder task.

import { logAiUsage, logError } from './telemetry.js';
import { toMonthlyAmount, incomeInEffectOn, lastNMonths } from './lib.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// Nemotron 3 Super: 120B MoE, free tier, built for multi-agent planning.
// Chosen over Ultra (550B) because Super is substantially faster and this
// runs while a user waits. Swap to 'nvidia/nemotron-3-ultra-550b-a55b:free'
// if analysis quality proves insufficient.
const MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

// An agent that can loop forever is a runaway API bill and a hung request.
// Started at 6, but in practice the model used all six gathering data and
// never got a turn to answer — 10 leaves room to investigate AND conclude.
// If it still runs out, the forced-synthesis call at the end of the loop
// makes sure the gathered data isn't wasted.
const MAX_TOOL_ROUNDS = 10;

export const agentAvailable = !!OPENROUTER_API_KEY;

// --- Tool definitions handed to the model ---
// Deliberately narrow: each returns a small, already-computed summary
// rather than raw rows, so the model reasons over conclusions instead of
// re-deriving them (and so we don't blow the context on transaction dumps).
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_monthly_trend',
      description: 'Income, spending, and savings totals for each of the last N months. Use this to spot changes over time.',
      parameters: {
        type: 'object',
        properties: {
          months: { type: 'integer', description: 'How many months back to fetch (1-12).' }
        },
        required: ['months']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_category_spending',
      description: 'Total spending per category over a date range, so you can see where money actually goes.',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'YYYY-MM-DD inclusive.' },
          endDate: { type: 'string', description: 'YYYY-MM-DD inclusive.' }
        },
        required: ['startDate', 'endDate']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_budgets',
      description: "The user's monthly budget limits and how much of each is spent this month.",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_income_history',
      description: 'Every income entry with its effective date, to see whether income itself changed.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_recurring',
      description: 'Recurring transactions (subscriptions, rent, bills) with amounts and frequencies.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

// --- Tool implementations ---
// Each reads the user's own Firestore data and computes with the shared
// deterministic helpers. `req` is the authenticated request, so every read
// is already scoped to that user — the agent cannot reach another account.
async function runTool(name, args, req) {
  if (name === 'get_monthly_trend') {
    const months = lastNMonths(Math.min(Math.max(args.months || 6, 1), 12));
    const [txSnap, incomeSnap, savingsSnap] = await Promise.all([
      req.transactionsRef.get(), req.incomeRef.get(), req.savingsRef.get()
    ]);
    const transactions = txSnap.docs.map(d => d.data());
    const incomeEntries = incomeSnap.docs.map(d => d.data());
    const savings = savingsSnap.docs.map(d => d.data());

    return months.map(({ month, lastDay }) => {
      const active = incomeInEffectOn(incomeEntries, lastDay);
      return {
        month,
        income: active ? Number(toMonthlyAmount(active.amount, active.frequency).toFixed(2)) : 0,
        spent: Number(transactions.filter(t => t.date.startsWith(month)).reduce((s, t) => s + t.amount, 0).toFixed(2)),
        saved: Number(savings.filter(s => s.date.startsWith(month)).reduce((s, v) => s + v.amount, 0).toFixed(2))
      };
    });
  }

  if (name === 'get_category_spending') {
    const snap = await req.transactionsRef.get();
    const totals = {};
    snap.docs.map(d => d.data())
      .filter(t => t.date >= args.startDate && t.date <= args.endDate)
      .forEach(t => { totals[t.category] = (totals[t.category] || 0) + t.amount; });
    return Object.entries(totals)
      .map(([category, total]) => ({ category, total: Number(total.toFixed(2)) }))
      .sort((a, b) => b.total - a.total);
  }

  if (name === 'get_budgets') {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const [budgetsSnap, txSnap] = await Promise.all([req.budgetsRef.get(), req.transactionsRef.get()]);
    const spentByCategory = {};
    txSnap.docs.map(d => d.data())
      .filter(t => t.date.startsWith(currentMonth))
      .forEach(t => { spentByCategory[t.category] = (spentByCategory[t.category] || 0) + t.amount; });

    return budgetsSnap.docs.map(d => {
      const limit = d.data().limit;
      const spent = Number((spentByCategory[d.id] || 0).toFixed(2));
      return { category: d.id, limit, spent, percentUsed: limit > 0 ? Math.round((spent / limit) * 100) : 0 };
    });
  }

  if (name === 'get_income_history') {
    const snap = await req.incomeRef.get();
    return snap.docs.map(d => {
      const e = d.data();
      return {
        effectiveDate: e.effectiveDate,
        amount: e.amount,
        frequency: e.frequency,
        monthlyEquivalent: Number(toMonthlyAmount(e.amount, e.frequency).toFixed(2))
      };
    }).sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : 1));
  }

  if (name === 'get_recurring') {
    const snap = await req.recurringRef.get();
    return snap.docs.map(d => {
      const r = d.data();
      return { description: r.description, amount: r.amount, frequency: r.frequency, category: r.category };
    });
  }

  return { error: `Unknown tool: ${name}` };
}

async function callOpenRouter(messages, tools) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL, messages, tools, max_tokens: 2000 })
  });

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`OpenRouter ${response.status}: ${body.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

const SYSTEM_PROMPT = `You are a financial analyst reviewing one person's own financial data.

Work in steps: call the tools you need, look at what comes back, and call more
if the answer raises a new question.

Be efficient about it. Aim for 3-5 tool calls total, then WRITE YOUR ANSWER.
Do not keep gathering data indefinitely — an analysis the person never sees is
worthless. Specifically:
- Request a wide date range in ONE call rather than one call per month.
- Don't call the same tool twice with near-identical arguments.
- Once you can explain the pattern, stop and explain it.

CRITICAL: never calculate, estimate, or infer a number yourself. Every figure
you state must come verbatim from a tool result. If you need a number you don't
have, call a tool for it. If no tool provides it, say so plainly rather than
guessing.

Finish with a short written analysis: what you found, why it's happening, and
one or two specific things the person could actually do. Be direct and concrete.
Skip pleasantries and disclaimers.`;

// Runs the agent loop. Returns the final analysis plus the trace of what it
// looked at — the trace matters because "the AI said so" is not something a
// user should have to take on faith about their own money.
export async function runFinancialAgent(question, req) {
  if (!agentAvailable) {
    throw new Error('OPENROUTER_API_KEY is not set — deep analysis is unavailable.');
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question }
  ];
  const trace = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await callOpenRouter(messages, TOOLS);
      totalPromptTokens += data.usage?.prompt_tokens || 0;
      totalCompletionTokens += data.usage?.completion_tokens || 0;

      const choice = data.choices?.[0];
      const message = choice?.message;
      if (!message) throw new Error('Empty response from the model');

      messages.push(message);

      const toolCalls = message.tool_calls || [];
      if (toolCalls.length === 0) {
        // No more tools wanted — this is the final analysis.
        logAiUsage({
          feature: 'deep_analysis', model: MODEL, provider: 'openrouter',
          promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, ok: true
        });
        return { analysis: message.content || '', trace, toolCallCount: trace.length };
      }

      for (const call of toolCalls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          // Free-tier Nemotron doesn't enforce structured output, so
          // malformed arguments are a real possibility rather than a
          // theoretical one. Feed the error back and let it retry.
          messages.push({
            role: 'tool', tool_call_id: call.id,
            content: JSON.stringify({ error: 'Could not parse your arguments as JSON. Please retry this call.' })
          });
          continue;
        }

        const result = await runTool(call.function.name, args, req);
        trace.push({ tool: call.function.name, args, resultSummary: Array.isArray(result) ? `${result.length} rows` : 'object' });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    // Ran out of tool rounds. The data it gathered is still perfectly good —
    // it just never got a turn to write the answer. Make one final call with
    // NO tools available, which leaves the model no option but to produce
    // prose from what it already has. Discarding six real queries because of
    // a loop-counter technicality would be throwing away the whole analysis.
    messages.push({
      role: 'user',
      content: 'Stop gathering data now and give me your analysis based on what you have already retrieved. Use only numbers that appeared in those tool results.'
    });

    const finalData = await callOpenRouter(messages, undefined);
    totalPromptTokens += finalData.usage?.prompt_tokens || 0;
    totalCompletionTokens += finalData.usage?.completion_tokens || 0;
    const finalMessage = finalData.choices?.[0]?.message?.content || '';

    logAiUsage({
      feature: 'deep_analysis', model: MODEL, provider: 'openrouter',
      promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
      ok: !!finalMessage,
      errorCode: finalMessage ? 'forced_synthesis' : 'max_rounds_exceeded'
    });

    return {
      analysis: finalMessage || "I gathered the data but couldn't summarise it. Try asking something more specific.",
      trace,
      toolCallCount: trace.length
    };
  } catch (err) {
    logAiUsage({
      feature: 'deep_analysis', model: MODEL, provider: 'openrouter',
      promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
      ok: false, errorCode: err.status === 429 ? 'rate_limit_exceeded' : 'error'
    });
    logError({ feature: 'deep_analysis', message: err.message, uid: req.uid });
    throw err;
  }
}
