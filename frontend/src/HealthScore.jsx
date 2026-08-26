import { useEffect, useState } from 'react'
import { motion, useMotionValue, useTransform, animate } from 'framer-motion'

function AnimatedNumber({ value }) {
  const count = useMotionValue(0)
  const rounded = useTransform(count, v => Math.round(v))
  const [display, setDisplay] = useState(0)

  useEffect(() => {
    const controls = animate(count, value, { duration: 1, ease: 'easeOut' })
    const unsubscribe = rounded.on('change', v => setDisplay(v))
    return () => { controls.stop(); unsubscribe() }
  }, [value])

  return <span>{display}</span>
}

const GRADE_COLORS = {
  A: '#4ade80', B: '#64ffda', C: '#facc15', D: '#f97316', F: '#ef4444'
}

function ScoreRing({ score, grade }) {
  const radius = 52
  const circumference = 2 * Math.PI * radius
  const color = GRADE_COLORS[grade] || '#8892b0'

  return (
    <div className="relative w-32 h-32 shrink-0">
      <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="currentColor" strokeWidth="10" className="text-gray-100 dark:text-gray-800" />
        <motion.circle
          cx="60" cy="60" r={radius} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference * (1 - score / 100) }}
          transition={{ duration: 1, ease: 'easeOut' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-navy dark:text-gray-100 font-mono">
          <AnimatedNumber value={score} />
        </span>
        <span className="text-xs font-semibold" style={{ color }}>{grade}</span>
      </div>
    </div>
  )
}

function ComponentBar({ label, score, max, hint }) {
  const [hovered, setHovered] = useState(false)
  const pct = (score / max) * 100
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative"
    >
      <div className="flex justify-between text-xs mb-1">
        <span className="text-navy dark:text-gray-200 font-medium">{label}</span>
        <span className="font-mono text-slate-500 dark:text-slate-400">{score}/{max}</span>
      </div>
      <div className="bg-gray-100 dark:bg-gray-800 rounded-full h-2 overflow-hidden">
        <motion.div
          className="h-full bg-mint"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        />
      </div>
      {hovered && (
        <motion.p
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-[11px] text-slate-400 dark:text-slate-500 mt-1"
        >
          {hint}
        </motion.p>
      )}
    </div>
  )
}

export default function HealthScore({ data }) {
  if (!data) return null

  // The backend refuses to score an account with no transactions or income,
  // rather than returning a flattering number built from nothing.
  if (data.insufficientData) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {data.message}
      </p>
    )
  }

  const { score, grade, components, tip } = data

  return (
    <div className="flex flex-col sm:flex-row gap-6 items-center sm:items-start">
      <ScoreRing score={score} grade={grade} />
      <div className="flex-1 w-full flex flex-col gap-3">
        <ComponentBar
          label="Savings rate"
          score={components.savingsRate.score}
          max={components.savingsRate.max}
          hint={`You saved ${components.savingsRate.value}% of your income this month. 30%+ earns full marks.`}
        />
        <ComponentBar
          label="Budget adherence"
          score={components.budgetAdherence.score}
          max={components.budgetAdherence.max}
          hint="How many of your set budgets you're staying within this month."
        />
        <ComponentBar
          label="Spending consistency"
          score={components.consistency.score}
          max={components.consistency.max}
          hint="How steady your monthly spending has been over the last 3 months — big swings score lower."
        />
        {tip && (
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 italic">💡 {tip}</p>
        )}
      </div>
    </div>
  )
}
