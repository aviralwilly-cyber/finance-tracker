import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check } from 'lucide-react'
import { authedFetch } from './api'
import MoneyBagIcon from './MoneyBagIcon'

const PURPOSES = [
  { value: 'self', label: 'Personal use', blurb: 'Track my own everyday spending' },
  { value: 'business', label: 'Business', blurb: 'Track business expenses (office, clients, travel)' },
  { value: 'other', label: 'Something else', blurb: 'A general set of categories' }
]

const EMPLOYMENT_TYPES = [
  { value: 'employed', label: 'Employed' },
  { value: 'self-employed', label: 'Self-employed' },
  { value: 'student', label: 'Student' },
  { value: 'other', label: 'Other' }
]

const GOALS = [
  { value: 'save', label: 'Save more', emoji: '🐷' },
  { value: 'debt', label: 'Pay off debt', emoji: '💳' },
  { value: 'visibility', label: 'Just track spending', emoji: '👁️' },
  { value: 'business', label: 'Business expenses', emoji: '💼' }
]

// Small reusable "card radio" — same visual language throughout the form so
// purpose / employment type / goal all feel like one consistent system.
function CardRadio({ options, value, onChange, columns = 1 }) {
  return (
    <div className={`grid gap-2 ${columns === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
      {options.map(opt => (
        <button
          type="button"
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`relative text-left border rounded-lg px-3 py-2.5 transition ${
            value === opt.value
              ? 'border-mint bg-mint/10'
              : 'border-gray-700 hover:bg-gray-800'
          }`}
        >
          {opt.emoji && <span className="mr-1.5">{opt.emoji}</span>}
          <span className="text-sm font-medium text-gray-100">{opt.label}</span>
          {opt.blurb && <span className="block text-xs text-slate-400 mt-0.5">{opt.blurb}</span>}
          {value === opt.value && (
            <Check className="w-4 h-4 text-mint absolute top-2.5 right-2.5" />
          )}
        </button>
      ))}
    </div>
  )
}

// Section wrapper: description on the left, fields on the right — the
// classic Tailwind "two-column" form layout, divided by a top border
// between sections instead of hiding content behind wizard steps.
function Section({ title, description, children, first = false }) {
  return (
    <div className={`grid grid-cols-1 sm:grid-cols-3 gap-6 py-8 ${first ? '' : 'border-t border-gray-800'}`}>
      <div>
        <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
        <p className="text-sm text-slate-400 mt-1">{description}</p>
      </div>
      <div className="sm:col-span-2 flex flex-col gap-4">{children}</div>
    </div>
  )
}

function FieldLabel({ children, filled }) {
  return (
    <label className="flex items-center gap-1.5 text-xs font-medium text-slate-400 mb-1.5">
      {children}
      {filled && <Check className="w-3 h-3 text-mint" />}
    </label>
  )
}

const inputClass = 'w-full rounded-lg border border-gray-700 bg-gray-800 text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint transition'

export default function Onboarding({ onComplete }) {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('self')
  const [employmentType, setEmploymentType] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [payType, setPayType] = useState('salary') // 'salary' | 'hourly'
  const [amount, setAmount] = useState('')
  const [frequency, setFrequency] = useState('monthly')
  const [hourlyRate, setHourlyRate] = useState('')
  const [hoursPerWeek, setHoursPerWeek] = useState('')
  const [goal, setGoal] = useState('')
  const [saving, setSaving] = useState(false)

  const monthlyEstimate = payType === 'hourly' && hourlyRate && hoursPerWeek
    ? (Number(hourlyRate) * Number(hoursPerWeek) * 52) / 12
    : null

  // Continuous completion feedback instead of a discrete step counter.
  const fields = [name, purpose, employmentType, jobTitle, amount || (hourlyRate && hoursPerWeek), goal]
  const progress = Math.round((fields.filter(Boolean).length / fields.length) * 100)

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)

    await authedFetch('/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: name.trim(),
        purpose,
        employmentType: employmentType || null,
        jobTitle: jobTitle.trim(),
        financialGoal: goal || null
      })
    })

    // If income was filled in, seed an actual income entry too — no more
    // landing on an empty $0.00 overview after onboarding.
    const today = new Date().toISOString().slice(0, 10)
    if (payType === 'salary' && amount) {
      await authedFetch('/income', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(amount), frequency, effectiveDate: today })
      })
    } else if (payType === 'hourly' && hourlyRate && hoursPerWeek) {
      await authedFetch('/income', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: monthlyEstimate, frequency: 'monthly', effectiveDate: today })
      })
    }

    const res = await authedFetch('/profile')
    const profile = await res.json()
    setSaving(false)
    onComplete(profile)
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-6 py-12">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-2xl bg-gray-900 rounded-2xl shadow-lg border border-gray-800 p-8"
      >
        <div className="h-1 bg-gray-800 rounded-full overflow-hidden mb-6">
          <motion.div
            className="h-full bg-mint"
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>

        <h1 className="text-2xl font-bold text-gray-100 mb-1 flex items-center gap-2">
          <MoneyBagIcon className="w-7 h-7" /> Welcome
        </h1>
        <p className="text-slate-400 text-sm">A few quick questions to set things up — only your name and purpose are required.</p>

        <form onSubmit={submit}>
          <Section title="Identity" description="What should we call you, and what's this for?" first>
            <div>
              <FieldLabel filled={!!name.trim()}>Your name</FieldLabel>
              <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your name"
                required
                className={inputClass}
              />
            </div>
            <div>
              <FieldLabel filled>What will you use this for?</FieldLabel>
              <CardRadio
                options={PURPOSES}
                value={purpose}
                onChange={setPurpose}
              />
            </div>
          </Section>

          <Section title="Work situation" description="Optional — helps tailor things, doesn't affect what you can do.">
            <div>
              <FieldLabel filled={!!employmentType}>Employment</FieldLabel>
              <CardRadio options={EMPLOYMENT_TYPES} value={employmentType} onChange={setEmploymentType} columns={2} />
            </div>
            <div>
              <FieldLabel filled={!!jobTitle.trim()}>Job title (optional)</FieldLabel>
              <input
                value={jobTitle}
                onChange={e => setJobTitle(e.target.value)}
                placeholder="e.g. Software Engineer"
                className={inputClass}
              />
            </div>
          </Section>

          <Section title="Income" description="Optional — set it now and your Overview won't start empty.">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPayType('salary')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${payType === 'salary' ? 'border-mint bg-mint/10 text-mint' : 'border-gray-700 text-slate-400 hover:bg-gray-800'}`}
              >
                Salary
              </button>
              <button
                type="button"
                onClick={() => setPayType('hourly')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${payType === 'hourly' ? 'border-mint bg-mint/10 text-mint' : 'border-gray-700 text-slate-400 hover:bg-gray-800'}`}
              >
                Hourly
              </button>
            </div>

            <AnimatePresence mode="wait">
              {payType === 'salary' ? (
                <motion.div
                  key="salary"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden flex gap-2"
                >
                  <div className="flex-1">
                    <FieldLabel filled={!!amount}>Amount</FieldLabel>
                    <input
                      type="number"
                      step="0.01"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      placeholder="4500"
                      className={inputClass}
                    />
                  </div>
                  <div className="flex-1">
                    <FieldLabel filled>Frequency</FieldLabel>
                    <select value={frequency} onChange={e => setFrequency(e.target.value)} className={inputClass}>
                      <option value="monthly">Monthly</option>
                      <option value="biweekly">Biweekly</option>
                    </select>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="hourly"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <FieldLabel filled={!!hourlyRate}>Hourly rate</FieldLabel>
                      <input
                        type="number"
                        step="0.01"
                        value={hourlyRate}
                        onChange={e => setHourlyRate(e.target.value)}
                        placeholder="25"
                        className={inputClass}
                      />
                    </div>
                    <div className="flex-1">
                      <FieldLabel filled={!!hoursPerWeek}>Hours / week</FieldLabel>
                      <input
                        type="number"
                        value={hoursPerWeek}
                        onChange={e => setHoursPerWeek(e.target.value)}
                        placeholder="40"
                        className={inputClass}
                      />
                    </div>
                  </div>
                  {monthlyEstimate !== null && (
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-xs text-mint mt-2 font-mono"
                    >
                      ≈ ${monthlyEstimate.toFixed(2)}/month
                    </motion.p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </Section>

          <Section title="Your goal" description="Optional — what are you hoping to get out of this?">
            <CardRadio options={GOALS} value={goal} onChange={setGoal} columns={2} />
          </Section>

          <div className="pt-6">
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className={`w-full py-2.5 rounded-lg font-medium transition ${
                name.trim() ? 'bg-mint text-navy hover:brightness-95' : 'bg-gray-800 text-slate-500 cursor-not-allowed'
              }`}
            >
              {saving ? 'Setting up…' : 'Continue'}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  )
}
