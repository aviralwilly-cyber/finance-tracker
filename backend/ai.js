// Groq-calling functions, extracted so the eval harness can call the exact
// same categorize() logic the live app uses — not a reimplementation that
// could drift out of sync with what's actually running.

import Groq from 'groq-sdk';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const MODEL = 'openai/gpt-oss-120b'; // free-tier eligible (llama-3.3-70b-versatile was deprecated Aug 2026)

export const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

export async function callGroq(prompt, maxTokens = 300, extraOptions = {}) {
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

// The categorizer the live app actually uses — returns a plain category
// string, exactly as every existing route in server.js expects. Malformed-
// response handling: if the model's answer doesn't case-insensitively
// match one of the allowed categories exactly, or the call fails outright,
// this falls back to 'Other' rather than throwing or saving something
// invalid to the database.
export async function categorize(description, amount, categories) {
  const result = await categorizeWithDetails(description, amount, categories, callGroq);
  return result.category;
}

// Same logic, but returns whether the fallback path was hit — used by the
// eval harness to distinguish "the model genuinely predicted Other" from
// "the model's response was unusable and we fell back," which matters for
// measuring how often that fallback is actually triggered in practice.
// Takes the categorizer prompt-builder as a parameter so the eval harness
// can swap in a different prompt (see categorizeV2WithDetails below)
// without duplicating this control flow.
//
// temperature: 0 minimizes sampling randomness — categorization should be
// as close to deterministic as the model allows, both because there's
// rarely a good reason for the same transaction to get different answers
// on different days, and because without it, eval runs were noisy enough
// (a 2.7-point swing between two runs of the identical baseline prompt)
// to make prompt-to-prompt comparisons statistically meaningless.
async function categorizeWithDetails(description, amount, categories, groqCaller, buildPrompt = defaultPrompt) {
  if (!groq) return { category: 'Other', usedFallback: true };

  const prompt = buildPrompt(description, amount, categories);

  try {
    const result = (await groqCaller(prompt, 300, { temperature: 0 })).trim();
    const match = categories.find(c => c.toLowerCase() === result.toLowerCase());
    return match ? { category: match, usedFallback: false } : { category: 'Other', usedFallback: true };
  } catch (err) {
    console.error('Categorization failed:', err.message);
    return { category: 'Other', usedFallback: true };
  }
}

function defaultPrompt(description, amount, categories) {
  return `Categorize this bank transaction into exactly ONE of these categories: ${categories.join(', ')}

Transaction description: "${description}"
Amount: ${amount}

Respond with ONLY the category name, nothing else.`;
}

// A second prompt variant for A/B comparison in the eval harness — adds a
// handful of merchant-name examples for categories that are easy to
// confuse (e.g. Costco could plausibly be Groceries or Shopping). This is
// NOT what the live app uses yet; it's a candidate to compare against the
// baseline using real eval numbers before deciding whether to adopt it.
function improvedPrompt(description, amount, categories) {
  return `Categorize this bank transaction into exactly ONE of these categories: ${categories.join(', ')}

Some examples of merchants that are easy to miscategorize:
- Costco, Walmart, Superstore -> Groceries (unless clearly a non-food big-ticket item)
- Amazon -> Shopping, unless the description mentions groceries/food/Whole Foods specifically
- Uber, Lyft -> Transport (not Travel, unless clearly airport/long-distance context)
- Uber Eats, DoorDash, Skip The Dishes -> Dining (these are food delivery, not Transport)
- Costco membership, gym membership, Prime membership -> Subscriptions (recurring membership fees)
- Shoppers Drug Mart, pharmacy, walk-in clinic -> Health

Transaction description: "${description}"
Amount: ${amount}

Respond with ONLY the category name, nothing else.`;
}

// Public entry points the eval harness imports directly.
export function categorizeBaselineWithDetails(description, amount, categories) {
  return categorizeWithDetails(description, amount, categories, callGroq, defaultPrompt);
}

export function categorizeImprovedWithDetails(description, amount, categories) {
  return categorizeWithDetails(description, amount, categories, callGroq, improvedPrompt);
}

// A third, surgical variant. The eval showed the broad "improved" prompt
// fixed every Transport-vs-Travel confusion it targeted, but also caused a
// side-effect regression in Rent/Housing — a category it never mentioned.
// This version keeps ONLY the Transport/Travel disambiguation guidance and
// drops everything else (the Groceries/Shopping/Subscriptions/Health
// examples), testing whether the fix can be isolated from the regression
// rather than assuming a narrower prompt will simply work better.
function surgicalPrompt(description, amount, categories) {
  return `Categorize this bank transaction into exactly ONE of these categories: ${categories.join(', ')}

Transport vs. Travel can be ambiguous: Uber, Lyft, gas, parking, and transit fares are
Transport UNLESS the description clearly relates to a trip away from home (car rental,
VIA Rail, airport parking, flights, hotels, travel insurance) — those are Travel.

Transaction description: "${description}"
Amount: ${amount}

Respond with ONLY the category name, nothing else.`;
}

export function categorizeSurgicalWithDetails(description, amount, categories) {
  return categorizeWithDetails(description, amount, categories, callGroq, surgicalPrompt);
}
