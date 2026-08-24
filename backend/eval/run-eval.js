// Categorization accuracy eval. Runs the EXACT categorize() logic the live
// app uses (imported from ../ai.js, not reimplemented) against a hand-
// labeled dataset, then compares it to two other prompt variants to measure
// whether concrete prompt changes actually help.
//
// Note: categorizeWithDetails() in ai.js pins temperature to 0, added after
// an early run of this eval showed the baseline prompt itself swinging by
// 2.7 accuracy points between two identical runs — noise on that scale
// would make any prompt-to-prompt comparison here meaningless.
//
// Requires a real GROQ_API_KEY in backend/.env — this makes real API calls
// and will take a few minutes for the full ~147-item set x3 prompts.
//
// Usage:
//   cd backend
//   node eval/run-eval.js

import 'dotenv/config';
import { dataset, CATEGORIES } from './dataset.js';
import { categorizeBaselineWithDetails, categorizeImprovedWithDetails, categorizeSurgicalWithDetails, groq } from '../ai.js';

if (!groq) {
  console.error('GROQ_API_KEY is not set in backend/.env — cannot run a real eval without it.');
  process.exit(1);
}

async function runEval(categorizeFn, label) {
  let correct = 0;
  let fallbackCount = 0;
  const perCategory = {};
  const misses = [];

  console.log(`\nRunning "${label}" against ${dataset.length} labeled transactions...`);

  for (const item of dataset) {
    const { category: predicted, usedFallback } = await categorizeFn(item.description, item.amount, CATEGORIES);

    if (usedFallback) fallbackCount++;

    perCategory[item.category] = perCategory[item.category] || { correct: 0, total: 0 };
    perCategory[item.category].total++;

    if (predicted === item.category) {
      correct++;
      perCategory[item.category].correct++;
    } else {
      misses.push({ description: item.description, expected: item.category, predicted });
    }
  }

  const accuracy = (correct / dataset.length) * 100;

  console.log(`\n=== ${label} ===`);
  console.log(`Overall accuracy: ${accuracy.toFixed(1)}% (${correct}/${dataset.length})`);
  console.log(`Fallback-to-Other triggered (malformed/unmatched response): ${fallbackCount}/${dataset.length}`);
  console.log('\nPer-category accuracy:');
  for (const cat of CATEGORIES) {
    const stats = perCategory[cat];
    if (!stats) continue;
    const pct = ((stats.correct / stats.total) * 100).toFixed(0);
    console.log(`  ${cat.padEnd(14)} ${pct}% (${stats.correct}/${stats.total})`);
  }

  if (misses.length > 0) {
    console.log(`\nMisclassifications (${misses.length}):`);
    misses.forEach(m => console.log(`  "${m.description}" -> expected ${m.expected}, got ${m.predicted}`));
  }

  return { accuracy, fallbackCount, misses };
}

const baseline = await runEval(categorizeBaselineWithDetails, 'Baseline prompt');
const improved = await runEval(categorizeImprovedWithDetails, 'Improved prompt (merchant examples for confusable categories)');
const surgical = await runEval(categorizeSurgicalWithDetails, 'Surgical prompt (Transport/Travel disambiguation only)');

console.log('\n=== Comparison ===');
console.log(`Baseline:  ${baseline.accuracy.toFixed(1)}%`);
console.log(`Improved:  ${improved.accuracy.toFixed(1)}% (${(improved.accuracy - baseline.accuracy >= 0 ? '+' : '')}${(improved.accuracy - baseline.accuracy).toFixed(1)} pts vs. baseline)`);
console.log(`Surgical:  ${surgical.accuracy.toFixed(1)}% (${(surgical.accuracy - baseline.accuracy >= 0 ? '+' : '')}${(surgical.accuracy - baseline.accuracy).toFixed(1)} pts vs. baseline)`);
