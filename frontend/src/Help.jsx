import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Search, LifeBuoy } from 'lucide-react'
import { authedFetch } from './api'

// Answers written from questions that actually came up building this app —
// empty health scores, imports missing rows, what Household really shares.
// A FAQ full of invented questions nobody asks is just filler.
const FAQS = [
  {
    q: 'Why is my Financial Health Score empty?',
    a: "It needs both transactions and income before it'll show anything. With no data, the spending-consistency calculation would score a perfect 30/30 — zero variance reads as perfectly consistent — which would hand you a flattering number built from nothing. It refuses to score rather than mislead you."
  },
  {
    q: 'My bank statement import missed some transactions.',
    a: "Statement layouts vary a lot between banks. There's a purpose-built parser for Scotiabank Day-to-Day statements; everything else falls back to AI extraction, which is good but not perfect. Nothing is ever saved without you reviewing it first — if rows are missing from the review screen, you can add them manually, and it's worth telling me which bank so a proper parser can be built."
  },
  {
    q: 'What exactly does Household mode share?',
    a: "Monthly spending totals per person, a category-level activity feed, shared bills, and the chat thread. It does NOT share your individual transaction descriptions, your budgets, your income, or your savings. Housemates see that you spent $84 on Groceries — not which shop."
  },
  {
    q: 'A transaction was categorized wrong. Does that matter?',
    a: "Just change it in the dropdown — it saves immediately. Corrections are also tracked in aggregate to measure how accurate categorization actually is in practice, so fixing one genuinely helps."
  },
  {
    q: "What's the difference between Chat and Analyze?",
    a: "Chat answers a single question quickly from your existing data. Analyze runs a reasoning model that decides what to look up, checks several things in sequence, then explains what it found — it's for questions like \"why am I saving less than last year?\" that need real digging. It's slower and shows you exactly which numbers it used."
  },
  {
    q: 'Deep analysis says it hit a limit.',
    a: "It runs on a free tier capped at requests per day, and each analysis makes several as the agent works through your question. The limit resets daily. Regular Chat is unaffected and keeps working."
  },
  {
    q: 'Are my numbers calculated by AI?',
    a: "No. Every figure — budget percentages, savings rate, net worth, projections — is computed by ordinary code and unit tested. AI reads messy input (statements, receipts, plain-English entry), assigns categories, and writes explanations. It's never asked to do arithmetic, because that's exactly where language models are unreliable."
  },
  {
    q: 'Why did the first page load take so long?',
    a: "The backend runs on a free tier that sleeps after about 15 minutes of inactivity. The first request wakes it, which can take up to a minute. After that it's normal until it idles again."
  },
  {
    q: 'How do I change my email or password?',
    a: 'Settings → Account & security. Both require re-entering your current password, which is a Firebase requirement for sensitive changes rather than an extra hurdle.'
  },
  {
    q: 'Can I get my data out?',
    a: 'Settings → Account & security → Download export. It produces a JSON file with every transaction, income entry, saving, budget, and recurring rule on your account.'
  },
  {
    q: 'How do I delete my account?',
    a: "Settings → Account & security → Delete my account. It permanently removes your sign-in and all your data. There's no undo, so export first if you want a copy."
  }
]

function FaqItem({ faq, isOpen, onToggle }) {
  return (
    <div className="border-b border-gray-100 dark:border-gray-800 last:border-0">
      <button
        onClick={onToggle}
        className="w-full flex items-start justify-between gap-3 py-3 text-left group"
      >
        <span className="text-sm font-medium text-navy dark:text-gray-200 group-hover:text-mint transition">
          {faq.q}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 shrink-0 mt-0.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed pb-4 pr-7">
              {faq.a}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function Help({ activeTabName, showToast }) {
  const [query, setQuery] = useState('')
  const [openIndex, setOpenIndex] = useState(null)

  const [form, setForm] = useState({ subject: '', message: '' })
  const [includeContext, setIncludeContext] = useState(true)
  const [sending, setSending] = useState(false)
  const [myTickets, setMyTickets] = useState([])

  useEffect(() => {
    authedFetch('/support')
      .then(r => (r.ok ? r.json() : []))
      .then(setMyTickets)
      .catch(() => {})
  }, [])

  const filtered = query.trim()
    ? FAQS.filter(f =>
        (f.q + ' ' + f.a).toLowerCase().includes(query.trim().toLowerCase())
      )
    : FAQS

  const submit = async (e) => {
    e.preventDefault()
    if (!form.subject.trim() || !form.message.trim()) return
    setSending(true)

    const res = await authedFetch('/support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        // Only attached if the box is ticked — sending someone's browser
        // details without asking would be a poor default.
        context: includeContext
          ? {
              lastTab: activeTabName || null,
              userAgent: navigator.userAgent,
              viewport: `${window.innerWidth}x${window.innerHeight}`,
              at: new Date().toISOString()
            }
          : null
      })
    })
    setSending(false)

    if (!res.ok) {
      showToast("Couldn't send that — try again", 'error')
      return
    }
    const created = await res.json()
    setMyTickets(prev => [created, ...prev])
    setForm({ subject: '', message: '' })
    showToast('Sent — thanks')
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-white/85 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-mint/10 flex items-center justify-center shrink-0">
            <LifeBuoy className="w-4 h-4 text-mint" />
          </div>
          <div>
            <h3 className="font-semibold text-navy dark:text-gray-100">Common questions</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Written from questions that actually come up.
            </p>
          </div>
        </div>

        <div className="relative mb-2">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search questions…"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
          />
        </div>

        {filtered.length === 0 ? (
          <p className="text-sm text-slate-400 py-4">
            Nothing matches that. Try the form below — questions asked here often become
            new entries.
          </p>
        ) : (
          <div>
            {filtered.map((faq, i) => (
              <FaqItem
                key={faq.q}
                faq={faq}
                isOpen={openIndex === i}
                onToggle={() => setOpenIndex(openIndex === i ? null : i)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="bg-white/85 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5">
        <h3 className="font-semibold text-navy dark:text-gray-100">Still stuck?</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 mb-4">
          Send it through and I'll take a look. This isn't staffed support — replies come
          by email when I get to them, not instantly.
        </p>

        <form onSubmit={submit} className="flex flex-col gap-3 max-w-xl">
          <input
            value={form.subject}
            onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
            placeholder="What's it about?"
            maxLength={200}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
          />
          <textarea
            value={form.message}
            onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
            placeholder="What happened, and what did you expect instead?"
            rows={5}
            maxLength={4000}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint resize-y"
          />

          <label className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
            <input
              type="checkbox"
              checked={includeContext}
              onChange={e => setIncludeContext(e.target.checked)}
              className="w-3.5 h-3.5 accent-mint mt-0.5"
            />
            <span>
              Include which tab you were on and your browser details. Makes problems much
              easier to reproduce — no financial data is attached.
            </span>
          </label>

          <button
            type="submit"
            disabled={sending || !form.subject.trim() || !form.message.trim()}
            className="btn-primary self-start disabled:opacity-40"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>

        {myTickets.length > 0 && (
          <div className="mt-6 pt-4 border-t border-gray-100 dark:border-gray-800">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
              What you've sent
            </p>
            <div className="flex flex-col gap-2">
              {myTickets.map(t => (
                <div key={t.id} className="flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <p className="text-navy dark:text-gray-200 truncate">{t.subject}</p>
                    <p className="text-xs text-slate-400">
                      {new Date(t.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                    t.status === 'resolved'
                      ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                      : 'bg-gray-100 dark:bg-gray-800 text-slate-500 dark:text-slate-400'
                  }`}>
                    {t.status === 'resolved' ? 'Resolved' : 'Open'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
