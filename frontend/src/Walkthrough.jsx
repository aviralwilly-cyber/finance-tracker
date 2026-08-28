import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard, Receipt, PiggyBank, Wallet,
  TrendingUp, Users, MessageCircle, Sparkles, X
} from 'lucide-react'
import { authedFetch } from './api'

// Deliberately explains what each section is FOR, not how to click it.
// A tour that narrates the obvious ("this is the Transactions tab, where
// you see transactions") wastes the one moment someone is willing to read.
const STEPS = [
  {
    icon: LayoutDashboard,
    title: 'Overview',
    body: "Your month at a glance — income, spending, savings rate, and a health score built from all three. It stays empty until you've logged some income and a few transactions, because a score built from no data would just be flattering noise."
  },
  {
    icon: Receipt,
    title: 'Transactions',
    body: 'Four ways in, all fast: type it normally ("Starbucks 5.50 today"), say it out loud, photograph a receipt, or upload a bank statement PDF. AI reads whatever you give it and fills in the details — you review before anything saves.'
  },
  {
    icon: PiggyBank,
    title: 'Savings',
    body: 'Log savings, investments, and retirement contributions separately from spending. These roll up into your net worth and feed the projections in Predict.'
  },
  {
    icon: Wallet,
    title: 'Budgets',
    body: "Set a monthly limit per category. When you cross your threshold, you get a short written nudge — the maths is done in code, the AI only writes the sentence."
  },
  {
    icon: TrendingUp,
    title: 'Predict',
    body: 'Drag sliders to change spending or income and watch your projected net worth move. Useful for answering "what if I cut $200 of dining?" before actually committing to it.'
  },
  {
    icon: Users,
    title: 'Household',
    body: "Share a spending view, upcoming bills, and a chat thread with up to 10 people. Totals and categories are shared — your individual transaction details, budgets, and income stay private."
  },
  {
    icon: MessageCircle,
    title: 'Chat',
    body: 'Ask questions about your own data in plain language — "how much did I spend on groceries in July?" Quick, single answers.'
  },
  {
    icon: Sparkles,
    title: 'Analyze',
    body: "For questions that need real digging — \"why am I saving less than last year?\" A reasoning model decides what to look up, checks several things, then explains what it found and shows you exactly which numbers it used."
  }
]

export default function Walkthrough({ onDone }) {
  const [step, setStep] = useState(0)
  const [closing, setClosing] = useState(false)

  const finish = async () => {
    setClosing(true)
    // Persist to the profile, not localStorage — otherwise the tour
    // replays on every new device.
    await authedFetch('/profile/tour-seen', { method: 'POST' }).catch(() => {})
    onDone()
  }

  const current = STEPS[step]
  const Icon = current.icon
  const isLast = step === STEPS.length - 1

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-md border border-gray-200 dark:border-gray-800 overflow-hidden"
      >
        <div className="flex justify-between items-start p-5 pb-0">
          <div className="w-11 h-11 rounded-xl bg-mint/10 flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5 text-mint" />
          </div>
          <button
            onClick={finish}
            disabled={closing}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-gray-200 transition text-sm"
            aria-label="Skip the tour"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pt-3 pb-5 min-h-[190px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.18 }}
            >
              <p className="text-xs font-medium text-mint mb-1">
                {step + 1} of {STEPS.length}
              </p>
              <h3 className="text-lg font-semibold text-navy dark:text-gray-100 mb-2">
                {current.title}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                {current.body}
              </p>
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100 dark:border-gray-800">
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                aria-label={`Go to step ${i + 1}`}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? 'w-5 bg-mint' : 'w-1.5 bg-gray-300 dark:bg-gray-700 hover:bg-gray-400'
                }`}
              />
            ))}
          </div>

          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="px-3 py-1.5 rounded-lg text-sm text-slate-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                Back
              </button>
            )}
            <button
              onClick={() => (isLast ? finish() : setStep(s => s + 1))}
              disabled={closing}
              className="btn-primary disabled:opacity-60"
            >
              {isLast ? (closing ? 'Finishing…' : 'Get started') : 'Next'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
