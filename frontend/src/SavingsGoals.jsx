import { useState } from 'react'
import { motion } from 'framer-motion'
import { Target, Plus, Minus } from 'lucide-react'
import { authedFetch } from './api'

function GoalCard({ goal, onAllocate, onDelete, busy }) {
  const [amount, setAmount] = useState('')
  const [open, setOpen] = useState(false)
  const p = goal.progress

  const submit = async (sign) => {
    const value = Number(amount)
    if (!value || value <= 0) return
    await onAllocate(goal, sign * value)
    setAmount('')
    setOpen(false)
  }

  const barColor = p.complete
    ? 'bg-emerald-500'
    : p.overdue
      ? 'bg-red-500'
      : p.onTrack === false
        ? 'bg-amber-500'
        : 'bg-mint'

  return (
    <div className={`rounded-xl border p-4 ${
      p.complete
        ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-900/10'
        : p.overdue
          ? 'border-red-300 dark:border-red-900/50 bg-red-50/30 dark:bg-red-900/10'
          : 'border-gray-200 dark:border-gray-700'
    }`}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="min-w-0">
          <p className="text-sm font-medium text-navy dark:text-gray-100">{goal.name}</p>
          {goal.note && <p className="text-xs text-slate-400 mt-0.5">{goal.note}</p>}
        </div>
        <button
          onClick={() => onDelete(goal)}
          className="text-slate-400 hover:text-red-500 transition text-sm shrink-0"
          aria-label={`Remove ${goal.name}`}
        >
          ✕
        </button>
      </div>

      <div className="flex items-baseline justify-between text-xs mb-1.5">
        <span className="font-mono text-navy dark:text-gray-200">
          ${p.saved.toFixed(2)} <span className="text-slate-400">of ${p.target.toFixed(2)}</span>
        </span>
        <span className="font-mono text-slate-400">{p.percent}%</span>
      </div>

      <div className="bg-gray-100 dark:bg-gray-800 rounded-full h-2 overflow-hidden mb-2">
        <motion.div
          className={`h-full ${barColor}`}
          initial={{ width: 0 }}
          animate={{ width: `${p.percent}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      </div>

      {/* The genuinely useful line: what it takes, and whether that's
          realistic given how much they actually save. */}
      <p className="text-xs leading-relaxed">
        {p.complete ? (
          <span className="text-emerald-600 dark:text-emerald-400">Fully funded.</span>
        ) : p.overdue ? (
          <span className="text-red-500">
            Target date passed — ${p.remaining.toFixed(2)} still short.
          </span>
        ) : p.requiredPerMonth !== null ? (
          <>
            <span className="text-slate-500 dark:text-slate-400">
              ${p.requiredPerMonth.toFixed(2)}/month for {p.monthsLeft === 0 ? 'the rest of this month' : `${p.monthsLeft} month${p.monthsLeft === 1 ? '' : 's'}`}
            </span>
            {p.onTrack !== null && (
              <span className={p.onTrack ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                {' '}· {p.onTrack ? 'on track' : 'above your recent pace'}
              </span>
            )}
          </>
        ) : (
          <span className="text-slate-400">
            ${p.remaining.toFixed(2)} to go — no target date set.
          </span>
        )}
      </p>

      {open ? (
        <div className="flex gap-2 mt-3">
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="Amount"
            autoFocus
            className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
          />
          <button
            onClick={() => submit(1)}
            disabled={busy || !amount}
            title="Add to this goal"
            className="px-2.5 py-1.5 rounded-lg bg-mint text-navy text-sm font-medium disabled:opacity-40"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={() => submit(-1)}
            disabled={busy || !amount}
            title="Take back out"
            className="px-2.5 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-slate-500 dark:text-slate-400 text-sm disabled:opacity-40"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            onClick={() => { setOpen(false); setAmount('') }}
            className="px-2 text-xs text-slate-400 hover:text-navy dark:hover:text-gray-200"
          >
            Cancel
          </button>
        </div>
      ) : (
        !p.complete && (
          <button
            onClick={() => setOpen(true)}
            className="mt-3 text-xs text-mint hover:underline"
          >
            Allocate money →
          </button>
        )
      )}
    </div>
  )
}

export default function SavingsGoals({ data, onChanged, showToast, setConfirmState }) {
  const [form, setForm] = useState({ name: '', targetAmount: '', targetDate: '', note: '' })
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)

  const addGoal = async (e) => {
    e.preventDefault()
    if (!form.name.trim() || !form.targetAmount) return
    setSaving(true)
    const res = await authedFetch('/savings/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    })
    setSaving(false)
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      showToast(d.error || "Couldn't add that goal", 'error')
      return
    }
    setForm({ name: '', targetAmount: '', targetDate: '', note: '' })
    showToast('Goal added')
    onChanged()
  }

  const allocate = async (goal, amount) => {
    setBusy(true)
    const res = await authedFetch(`/savings/goals/${goal.id}/allocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    })
    setBusy(false)
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      showToast(d.error || "Couldn't update that goal", 'error')
      return
    }
    onChanged()
  }

  const deleteGoal = (goal) => {
    setConfirmState({
      message: `Remove "${goal.name}"? Any money allocated to it goes back to unallocated savings.`,
      confirmLabel: 'Remove goal',
      onConfirm: async () => {
        setConfirmState(null)
        const res = await authedFetch(`/savings/goals/${goal.id}`, { method: 'DELETE' })
        if (!res.ok) {
          showToast("Couldn't remove that goal", 'error')
          return
        }
        showToast('Goal removed')
        onChanged()
      }
    })
  }

  const goals = data?.goals || []

  return (
    <div>
      <div className="flex flex-wrap gap-6 mb-4 text-sm">
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400">Unallocated savings</p>
          <p className={`font-mono font-semibold ${
            (data?.unallocated ?? 0) < 0 ? 'text-red-500' : 'text-navy dark:text-gray-100'
          }`}>
            ${(data?.unallocated ?? 0).toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400">Saving per month lately</p>
          <p className="font-mono font-semibold text-navy dark:text-gray-100">
            ${(data?.recentMonthlySaving ?? 0).toFixed(2)}
          </p>
        </div>
      </div>

      {(data?.unallocated ?? 0) < 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400 mb-4">
          You've allocated more to goals than you've logged in savings. Either log the
          savings, or take some back out of a goal.
        </p>
      )}

      <form onSubmit={addGoal} className="flex flex-wrap gap-2 mb-5">
        <input
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="What are you saving for?"
          className="flex-1 min-w-[180px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
        />
        <input
          type="number"
          step="0.01"
          min="0"
          value={form.targetAmount}
          onChange={e => setForm(f => ({ ...f, targetAmount: e.target.value }))}
          placeholder="Cost"
          className="w-28 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
        />
        <input
          type="date"
          value={form.targetDate}
          onChange={e => setForm(f => ({ ...f, targetDate: e.target.value }))}
          title="When do you want it by? Optional."
          className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
        />
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? 'Adding…' : 'Add'}
        </button>
      </form>

      {goals.length === 0 ? (
        <div className="text-center py-8">
          <Target className="w-8 h-8 text-slate-300 dark:text-slate-700 mx-auto mb-2" />
          <p className="text-sm text-slate-400">
            Nothing on the list yet. Add something you're saving for and you'll see what
            it takes each month to get there.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {goals.map(goal => (
            <GoalCard
              key={goal.id}
              goal={goal}
              onAllocate={allocate}
              onDelete={deleteGoal}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  )
}
