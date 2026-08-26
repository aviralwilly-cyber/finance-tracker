import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, TrendingUp, PieChart, Wallet, Repeat, DollarSign, Check } from 'lucide-react'
import { authedFetch } from './api'

// Starting points, chosen to need genuine multi-step work rather than a
// single lookup — a question answerable by one query wouldn't show what
// this is for.
const SUGGESTIONS = [
  'Why am I saving less than I used to?',
  'Where is most of my money actually going?',
  'Am I on track with my budgets this month?',
  'What could I realistically cut to save more?'
]

const TOOL_META = {
  get_monthly_trend: { label: 'Monthly income vs. spending trend', icon: TrendingUp },
  get_category_spending: { label: 'Spending totalled by category', icon: PieChart },
  get_budgets: { label: 'Budgets checked against this month', icon: Wallet },
  get_income_history: { label: 'Income history reviewed', icon: DollarSign },
  get_recurring: { label: 'Recurring bills and subscriptions', icon: Repeat }
}

// The model writes markdown, and rendering it raw is why the output looked
// choppy — literal ** everywhere. Rather than pull in a markdown library for
// the small subset it actually emits (bold, headings, numbered/bulleted
// lists), this handles those cases directly.
//
// It also highlights currency figures, which matters here specifically:
// every number in this output came from a deterministic tool result, so
// making them visually distinct reinforces what's a computed fact versus
// what's the model's commentary.
function renderInline(text, keyPrefix) {
  // Split on **bold** and $amounts, keeping the delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|\$[\d,]+(?:\.\d{2})?)/g)
  return parts.filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-navy dark:text-gray-100">
          {renderInline(part.slice(2, -2), `${keyPrefix}-${i}b`)}
        </strong>
      )
    }
    if (/^\$[\d,]+(\.\d{2})?$/.test(part)) {
      return (
        <span key={`${keyPrefix}-${i}`} className="font-mono text-mint">
          {part}
        </span>
      )
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>
  })
}

function Markdown({ text }) {
  const blocks = []
  let listBuffer = []
  let listType = null

  const flushList = (key) => {
    if (listBuffer.length === 0) return
    const items = listBuffer.map((item, i) => (
      <li key={i} className="flex gap-2.5">
        <span className="text-mint shrink-0 font-mono text-xs mt-1">
          {listType === 'ol' ? `${i + 1}.` : '•'}
        </span>
        <span className="flex-1">{renderInline(item, `li-${key}-${i}`)}</span>
      </li>
    ))
    blocks.push(<ul key={`list-${key}`} className="flex flex-col gap-2 my-3">{items}</ul>)
    listBuffer = []
    listType = null
  }

  const lines = (text || '').split('\n')

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim()

    if (!line) {
      flushList(idx)
      return
    }

    const numbered = line.match(/^(\d+)\.\s+(.*)$/)
    const bulleted = line.match(/^[-*•]\s+(.*)$/)

    if (numbered) {
      if (listType && listType !== 'ol') flushList(idx)
      listType = 'ol'
      listBuffer.push(numbered[2])
      return
    }
    if (bulleted) {
      if (listType && listType !== 'ul') flushList(idx)
      listType = 'ul'
      listBuffer.push(bulleted[1])
      return
    }

    flushList(idx)

    // A line that's entirely bold reads as a section heading.
    const headingMatch = line.match(/^\*\*(.+?):?\*\*:?$/)
    if (headingMatch) {
      blocks.push(
        <h4 key={`h-${idx}`} className="text-sm font-semibold text-navy dark:text-gray-100 mt-5 mb-1.5 first:mt-0">
          {headingMatch[1]}
        </h4>
      )
      return
    }

    blocks.push(
      <p key={`p-${idx}`} className="text-sm leading-relaxed text-slate-600 dark:text-slate-300 mb-3">
        {renderInline(line, `p-${idx}`)}
      </p>
    )
  })

  flushList('end')
  return <div>{blocks}</div>
}

// Rotating status text during the wait. The agent genuinely does take
// 15-30s, and a static spinner for that long reads as "hung".
const LOADING_STAGES = [
  'Planning what to look at…',
  'Querying your financial data…',
  'Cross-referencing categories…',
  'Working out what it means…',
  'Writing up the analysis…'
]

function LoadingState() {
  const [stage, setStage] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setStage(s => Math.min(s + 1, LOADING_STAGES.length - 1))
    }, 4000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="bg-white/85 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5">
      <div className="flex items-center gap-3">
        <div className="w-4 h-4 border-2 border-mint border-t-transparent rounded-full animate-spin shrink-0" />
        <AnimatePresence mode="wait">
          <motion.p
            key={stage}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className="text-sm text-slate-500 dark:text-slate-400"
          >
            {LOADING_STAGES[stage]}
          </motion.p>
        </AnimatePresence>
      </div>
      <div className="mt-3 h-1 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-mint"
          initial={{ width: '0%' }}
          animate={{ width: `${((stage + 1) / LOADING_STAGES.length) * 100}%` }}
          transition={{ duration: 0.5 }}
        />
      </div>
    </div>
  )
}

function TraceStep({ step, index }) {
  const meta = TOOL_META[step.tool] || { label: step.tool, icon: Check }
  const Icon = meta.icon

  let detail = null
  if (step.args?.months) detail = `last ${step.args.months} months`
  else if (step.args?.startDate) detail = `${step.args.startDate} → ${step.args.endDate}`

  return (
    <motion.li
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.06 }}
      className="flex items-center gap-3 py-2 border-b border-gray-100 dark:border-gray-800 last:border-0"
    >
      <div className="w-7 h-7 rounded-lg bg-mint/10 flex items-center justify-center shrink-0">
        <Icon className="w-3.5 h-3.5 text-mint" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-navy dark:text-gray-200 truncate">{meta.label}</p>
        {detail && <p className="text-xs text-slate-400 dark:text-slate-500 font-mono">{detail}</p>}
      </div>
      <Check className="w-3.5 h-3.5 text-mint shrink-0" />
    </motion.li>
  )
}

export default function DeepAnalysis({ showToast }) {
  const [question, setQuestion] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [askedQuestion, setAskedQuestion] = useState('')
  const [error, setError] = useState('')

  const analyze = async (q) => {
    const text = (q ?? question).trim()
    if (!text) return
    setRunning(true)
    setError('')
    setResult(null)
    setAskedQuestion(text)

    const res = await authedFetch('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: text })
    })
    setRunning(false)

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || "The analysis didn't complete.")
      return
    }
    setResult(await res.json())
  }

  const reset = () => {
    setResult(null)
    setQuestion('')
    setAskedQuestion('')
    setError('')
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-white/85 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-mint/10 flex items-center justify-center shrink-0">
            <Sparkles className="w-4.5 h-4.5 text-mint" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-navy dark:text-gray-100">Deep analysis</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
              A reasoning model investigates your finances step by step — it decides what to
              look up, checks several things, then explains what it found. Every number comes
              from your actual data, not the model's estimate.
            </p>
          </div>
        </div>

        <form onSubmit={e => { e.preventDefault(); analyze() }} className="flex gap-2 mt-4">
          <input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="Ask something that needs digging into…"
            disabled={running}
            className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint disabled:opacity-60"
          />
          <button type="submit" disabled={running || !question.trim()} className="btn-primary disabled:opacity-40">
            {running ? 'Analyzing…' : 'Analyze'}
          </button>
        </form>

        {!result && !running && (
          <div className="flex flex-wrap gap-2 mt-3">
            {SUGGESTIONS.map(s => (
              <button
                key={s}
                onClick={() => { setQuestion(s); analyze(s) }}
                className="text-xs px-3 py-1.5 rounded-full border border-gray-300 dark:border-gray-700 text-slate-600 dark:text-slate-300 hover:border-mint hover:text-navy dark:hover:text-mint transition"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {error && <p className="text-sm text-red-500 mt-3">{error}</p>}
      </div>

      {running && <LoadingState />}

      {result && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="flex flex-col gap-6"
        >
          {/* Trace first, deliberately: "the AI said so" isn't good enough
              about someone's own money. Showing what it queried makes the
              conclusion checkable rather than something to take on faith. */}
          {result.trace?.length > 0 && (
            <div className="bg-white/85 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5">
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="font-semibold text-navy dark:text-gray-100">What it checked</h3>
                <span className="text-xs font-mono text-slate-400 dark:text-slate-500">
                  {result.toolCallCount} {result.toolCallCount === 1 ? 'query' : 'queries'}
                </span>
              </div>
              <ol className="flex flex-col">
                {result.trace.map((step, i) => <TraceStep key={i} step={step} index={i} />)}
              </ol>
            </div>
          )}

          <div className="bg-white/85 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
            <div className="px-5 pt-5 pb-3 border-b border-gray-100 dark:border-gray-800">
              <h3 className="font-semibold text-navy dark:text-gray-100">Analysis</h3>
              {askedQuestion && (
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 italic">"{askedQuestion}"</p>
              )}
            </div>
            <div className="p-5">
              <Markdown text={result.analysis} />
            </div>
            <div className="px-5 py-3 bg-gray-50/50 dark:bg-gray-800/30 border-t border-gray-100 dark:border-gray-800">
              <button
                onClick={reset}
                className="text-xs text-slate-500 dark:text-slate-400 hover:text-navy dark:hover:text-mint transition"
              >
                ← Ask something else
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  )
}
