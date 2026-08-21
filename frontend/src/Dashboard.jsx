import { useEffect, useState } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import { signOut } from 'firebase/auth'
import { Sun, Moon, Mic, Upload } from 'lucide-react'
import { auth } from './firebase'
import { authedFetch } from './api'
import ConfirmDialog from './ConfirmDialog'
import { useToasts, ToastContainer } from './Toast'
import CategoryIcon from './CategoryIcon'
import { SkeletonCard } from './Skeleton'
import ImportWizard from './ImportWizard'

const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#64748b']
const SAVINGS_COLORS = ['#4ade80', '#60a5fa', '#facc15', '#a78bfa']
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'savings', label: 'Savings' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'chat', label: 'Chat' }
]

export default function Dashboard({ user, profile }) {
  const { toasts, showToast } = useToasts()
  const [categories, setCategories] = useState([])
  const [confirmState, setConfirmState] = useState(null) // { message, onConfirm } | null
  const [activeTab, setActiveTab] = useState('overview')
  const [initialLoading, setInitialLoading] = useState(true)

  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return false
    const saved = localStorage.getItem('theme')
    if (saved) return saved === 'dark'
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])

  const [transactions, setTransactions] = useState([])
  const [summary, setSummary] = useState({})
  const [form, setForm] = useState({ description: '', amount: '', date: '' })
  const [loading, setLoading] = useState(false)
  const [question, setQuestion] = useState('')
  const [chatLog, setChatLog] = useState([])
  const [asking, setAsking] = useState(false)

  const [overview, setOverview] = useState(null)
  const [incomeHistory, setIncomeHistory] = useState([])
  const [showIncomeForm, setShowIncomeForm] = useState(false)
  const [incomeForm, setIncomeForm] = useState({ amount: '', frequency: 'monthly', effectiveDate: '' })
  const [savingIncome, setSavingIncome] = useState(false)

  const [savings, setSavings] = useState([])
  const [savingsSummary, setSavingsSummary] = useState({})
  const [savingsForm, setSavingsForm] = useState({ type: 'Savings', description: '', amount: '', date: '' })
  const [savingSavings, setSavingSavings] = useState(false)

  const [budgetProgress, setBudgetProgress] = useState([])
  const [budgetNudge, setBudgetNudge] = useState(null)
  const [daysLeftInMonth, setDaysLeftInMonth] = useState(null)
  const [budgetForm, setBudgetForm] = useState({ category: '', limit: '' })
  const [savingBudget, setSavingBudget] = useState(false)

  const [trend, setTrend] = useState([])
  const [selectedMonth, setSelectedMonth] = useState('All')
  const [listening, setListening] = useState(false)
  const [nudgeDismissed, setNudgeDismissed] = useState(false)

  const [searchText, setSearchText] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('All')

  const [recurring, setRecurring] = useState([])
  const [showRecurringForm, setShowRecurringForm] = useState(false)
  const [recurringForm, setRecurringForm] = useState({ description: '', amount: '', category: '', frequency: 'monthly', startDate: '' })
  const [savingRecurring, setSavingRecurring] = useState(false)

  const [quickAddText, setQuickAddText] = useState('')
  const [quickAdding, setQuickAdding] = useState(false)

  const [showImportWizard, setShowImportWizard] = useState(false)

  const loadData = async () => {
    // Catch up any due recurring transactions first, so they're already
    // reflected in the transactions list this same load.
    await authedFetch('/recurring/process', { method: 'POST' })

    const [txRes, sumRes, overviewRes, incomeRes, savingsRes, savingsSumRes, budgetsRes, trendRes, historyRes, categoriesRes, recurringRes] = await Promise.all([
      authedFetch('/transactions'),
      authedFetch('/transactions/summary'),
      authedFetch('/overview'),
      authedFetch('/income'),
      authedFetch('/savings'),
      authedFetch('/savings/summary'),
      authedFetch('/budgets/progress'),
      authedFetch('/trend'),
      authedFetch('/chat/history'),
      authedFetch('/categories'),
      authedFetch('/recurring')
    ])
    setTransactions(await txRes.json())
    setSummary(await sumRes.json())
    setOverview(await overviewRes.json())
    setIncomeHistory(await incomeRes.json())
    setSavings(await savingsRes.json())
    setSavingsSummary(await savingsSumRes.json())
    const budgetsData = await budgetsRes.json()
    setBudgetProgress(budgetsData.budgets || [])
    const newNudge = budgetsData.nudge || null
    setBudgetNudge(prev => {
      if (newNudge !== prev) setNudgeDismissed(false)
      return newNudge
    })
    setDaysLeftInMonth(budgetsData.daysLeftInMonth ?? null)
    setTrend(await trendRes.json())

    const fetchedCategories = await categoriesRes.json()
    setCategories(fetchedCategories)
    setBudgetForm(f => f.category ? f : { ...f, category: fetchedCategories[0] })
    setRecurringForm(f => f.category ? f : { ...f, category: fetchedCategories[0] })

    setRecurring(await recurringRes.json())

    const history = await historyRes.json()
    const flattened = history.flatMap(h => [
      { role: 'user', text: h.question },
      { role: 'ai', text: h.answer }
    ])
    setChatLog(flattened)
  }

  useEffect(() => {
    loadData().finally(() => setInitialLoading(false))
  }, [])

  const addTransaction = async (e) => {
    e.preventDefault()
    if (!form.description || !form.amount || !form.date) return
    setLoading(true)
    await authedFetch('/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    })
    setForm({ description: '', amount: '', date: '' })
    await loadData()
    setLoading(false)
    showToast('Transaction added')
  }

  const deleteTransaction = (id, description) => {
    setConfirmState({
      message: `Delete "${description}"? This can't be undone.`,
      onConfirm: async () => {
        await authedFetch(`/transactions/${id}`, { method: 'DELETE' })
        setConfirmState(null)
        await loadData()
        showToast('Transaction deleted')
      }
    })
  }

  const quickAdd = async (e) => {
    e.preventDefault()
    if (!quickAddText.trim()) return
    setQuickAdding(true)
    const res = await authedFetch('/transactions/quick-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: quickAddText })
    })
    setQuickAdding(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || "Couldn't parse that — try rephrasing.", 'error')
      return
    }
    const transaction = await res.json()
    setQuickAddText('')
    await loadData()
    showToast(`Added "${transaction.description}" — $${transaction.amount.toFixed(2)}`)
  }

  const addRecurring = async (e) => {
    e.preventDefault()
    if (!recurringForm.description || !recurringForm.amount || !recurringForm.startDate) return
    setSavingRecurring(true)
    await authedFetch('/recurring', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recurringForm)
    })
    setRecurringForm(f => ({ ...f, description: '', amount: '', startDate: '' }))
    setShowRecurringForm(false)
    await loadData()
    setSavingRecurring(false)
    showToast('Recurring transaction set up')
  }

  const deleteRecurring = (id, description) => {
    setConfirmState({
      message: `Stop the recurring "${description}" transaction? Past transactions it already created won't be removed.`,
      onConfirm: async () => {
        await authedFetch(`/recurring/${id}`, { method: 'DELETE' })
        setConfirmState(null)
        await loadData()
        showToast('Recurring transaction removed')
      }
    })
  }

  const addIncome = async (e) => {
    e.preventDefault()
    if (!incomeForm.amount || !incomeForm.effectiveDate) return
    setSavingIncome(true)
    await authedFetch('/income', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incomeForm)
    })
    setIncomeForm({ amount: '', frequency: 'monthly', effectiveDate: '' })
    setShowIncomeForm(false)
    await loadData()
    setSavingIncome(false)
    showToast('Income updated')
  }

  const addSavings = async (e) => {
    e.preventDefault()
    if (!savingsForm.amount || !savingsForm.date) return
    setSavingSavings(true)
    await authedFetch('/savings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savingsForm)
    })
    setSavingsForm({ type: 'Savings', description: '', amount: '', date: '' })
    await loadData()
    setSavingSavings(false)
    showToast('Savings entry added')
  }

  const deleteSavings = (id, type) => {
    setConfirmState({
      message: `Delete this ${type} entry? This can't be undone.`,
      onConfirm: async () => {
        await authedFetch(`/savings/${id}`, { method: 'DELETE' })
        setConfirmState(null)
        await loadData()
        showToast('Savings entry deleted')
      }
    })
  }

  const saveBudget = async (e) => {
    e.preventDefault()
    if (!budgetForm.limit) return
    setSavingBudget(true)
    await authedFetch('/budgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(budgetForm)
    })
    setBudgetForm(f => ({ ...f, limit: '' }))
    await loadData()
    setSavingBudget(false)
    showToast('Budget saved')
  }

  const deleteBudget = (category) => {
    setConfirmState({
      message: `Remove the ${category} budget?`,
      onConfirm: async () => {
        await authedFetch(`/budgets/${category}`, { method: 'DELETE' })
        setConfirmState(null)
        await loadData()
        showToast('Budget removed')
      }
    })
  }

  const clearChatHistory = async () => {
    await authedFetch('/chat/history', { method: 'DELETE' })
    setChatLog([])
    showToast('Chat cleared')
  }

  const startListening = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert('Speech recognition isn\'t supported in this browser — try Chrome or Edge.')
      return
    }
    const recognition = new SpeechRecognition()
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript
      setQuestion(prev => (prev ? prev + ' ' : '') + transcript)
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognition.start()
    setListening(true)
  }

  const askAi = async (e) => {
    e.preventDefault()
    if (!question.trim()) return
    setAsking(true)
    const q = question
    setChatLog(log => [...log, { role: 'user', text: q }])
    setQuestion('')
    const res = await authedFetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q })
    })
    const data = await res.json()
    setChatLog(log => [...log, { role: 'ai', text: data.answer }])
    setAsking(false)
  }

  const availableMonths = [...new Set(transactions.map(t => t.date.slice(0, 7)))].sort().reverse()
  const monthLabel = (m) => {
    if (m === 'All') return 'All time'
    const [year, month] = m.split('-')
    return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }
  const filteredTransactions = transactions
    .filter(t => selectedMonth === 'All' || t.date.startsWith(selectedMonth))
    .filter(t => categoryFilter === 'All' || t.category === categoryFilter)
    .filter(t => !searchText.trim() || t.description.toLowerCase().includes(searchText.trim().toLowerCase()))

  const chartData = Object.entries(
    filteredTransactions.reduce((acc, t) => {
      acc[t.category] = (acc[t.category] || 0) + t.amount
      return acc
    }, {})
  ).map(([name, value]) => ({ name, value }))
  const savingsChartData = Object.entries(savingsSummary).map(([name, value]) => ({ name, value }))

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
      {/* Sticky header + overview */}
      <div className="sticky top-0 z-20 bg-gray-50/95 dark:bg-gray-950/95 backdrop-blur border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-5xl mx-auto px-6 pt-6 pb-4">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="text-2xl font-bold text-navy dark:text-gray-100 flex items-center gap-2">💰 AI Finance Tracker</h1>
              <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
                {profile?.displayName ? `Welcome back, ${profile.displayName}.` : 'Add a transaction and AI will categorize it automatically.'}
              </p>
            </div>
            <div className="flex items-start gap-3">
              <button
                onClick={() => setDark(d => !d)}
                title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                className="p-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-navy dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
              >
                {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
              <div className="text-right">
                <p className="text-slate-500 dark:text-slate-400 text-xs mb-1">{user.email}</p>
                <button
                  onClick={() => signOut(auth)}
                  className="text-xs px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-navy dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                >
                  Log out
                </button>
              </div>
            </div>
          </div>

          {!initialLoading && (
            <>
              {/* Overview card */}
              <div className="bg-navy dark:bg-gray-900 dark:border dark:border-gray-800 text-white rounded-2xl shadow-lg p-5">
                {overview && overview.hasIncomeConfigured ? (
                  <div className="flex flex-wrap items-center justify-between gap-6">
                    <div className="flex flex-wrap gap-8">
                      <Stat label="Monthly income" value={`$${overview.monthlyIncome.toFixed(2)}`} />
                      <Stat label="Spent this month" value={`$${overview.spentThisMonth.toFixed(2)}`} />
                      <Stat label="Saved this month" value={`$${overview.savedThisMonth.toFixed(2)}`} accent="text-mint" />
                      <Stat
                        label="Remaining"
                        value={`$${overview.remaining.toFixed(2)}`}
                        accent={overview.remaining >= 0 ? 'text-mint' : 'text-red-400'}
                      />
                      <Stat label="Savings rate" value={overview.savingsRate !== null ? `${overview.savingsRate.toFixed(0)}%` : '—'} />
                      <Stat label="Net worth" value={`$${overview.totalSaved.toFixed(2)}`} accent="text-sky-400" />
                    </div>
                    <button
                      onClick={() => setShowIncomeForm(s => !s)}
                      className="text-xs px-3 py-1.5 rounded-md bg-white text-navy font-medium hover:bg-gray-100 transition shrink-0"
                    >
                      Update income
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-slate-300 text-sm">Add your income to see how much you have left to spend this month.</p>
                      {overview && overview.totalSaved > 0 && (
                        <p className="text-sky-400 text-sm mt-1.5 font-mono">Net worth (total saved): ${overview.totalSaved.toFixed(2)}</p>
                      )}
                    </div>
                    <button
                      onClick={() => setShowIncomeForm(s => !s)}
                      className="text-xs px-3 py-1.5 rounded-md bg-white text-navy font-medium hover:bg-gray-100 transition shrink-0"
                    >
                      Set up income
                    </button>
                  </div>
                )}

                {showIncomeForm && (
                  <form onSubmit={addIncome} className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-white/10">
                    <input
                      placeholder="Amount"
                      type="number"
                      step="0.01"
                      value={incomeForm.amount}
                      onChange={e => setIncomeForm({ ...incomeForm, amount: e.target.value })}
                      className="flex-1 min-w-[100px] rounded-lg px-3 py-2 text-navy focus:outline-none focus:ring-2 focus:ring-mint"
                    />
                    <select
                      value={incomeForm.frequency}
                      onChange={e => setIncomeForm({ ...incomeForm, frequency: e.target.value })}
                      className="min-w-[120px] rounded-lg px-3 py-2 text-navy focus:outline-none focus:ring-2 focus:ring-mint"
                    >
                      <option value="monthly">Monthly</option>
                      <option value="biweekly">Biweekly</option>
                    </select>
                    <input
                      type="date"
                      value={incomeForm.effectiveDate}
                      onChange={e => setIncomeForm({ ...incomeForm, effectiveDate: e.target.value })}
                      className="flex-1 min-w-[140px] rounded-lg px-3 py-2 text-navy focus:outline-none focus:ring-2 focus:ring-mint"
                    />
                    <button
                      type="submit"
                      disabled={savingIncome}
                      className="px-4 py-2 rounded-lg bg-mint text-navy font-medium hover:brightness-95 transition disabled:opacity-60"
                    >
                      {savingIncome ? 'Saving…' : 'Save'}
                    </button>
                  </form>
                )}
              </div>

              {/* Tabs */}
              <div className="flex gap-1 mt-4 -mb-px overflow-x-auto">
                {TABS.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition whitespace-nowrap ${
                      activeTab === tab.id
                        ? 'border-mint text-navy dark:text-mint'
                        : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-navy dark:hover:text-gray-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6">
        {initialLoading ? (
          <div className="flex flex-col gap-6">
            <SkeletonCard lines={4} />
            <SkeletonCard lines={5} />
          </div>
        ) : (
          <>
            {/* Overview tab */}
            {activeTab === 'overview' && (
              <Card title="Monthly Trend — Income vs. Spent vs. Saved">
                {trend.some(m => m.income > 0 || m.spent > 0 || m.saved > 0) ? (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={trend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" />
                      <XAxis dataKey="month" fontSize={12} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                      <YAxis fontSize={12} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                      <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} />
                      <Legend />
                      <Bar dataKey="income" name="Income" fill="#60a5fa" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="spent" name="Spent" fill="#f87171" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="saved" name="Saved" fill="#4ade80" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-slate-400 dark:text-slate-500 text-sm">Once you've logged income, transactions, and savings across a couple of months, they'll compare here.</p>
                )}

                {incomeHistory.length > 0 && (
                  <details className="mt-4 group">
                    <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400 hover:text-navy dark:hover:text-mint transition select-none">
                      Full income history ({incomeHistory.length})
                    </summary>
                    <table className="w-full mt-2 text-xs border-collapse">
                      <thead>
                        <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-slate-500 dark:text-slate-400">
                          <th className="pb-1.5 font-medium">Effective from</th>
                          <th className="pb-1.5 font-medium">Amount</th>
                          <th className="pb-1.5 font-medium">Frequency</th>
                          <th className="pb-1.5 font-medium">Monthly equivalent</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {incomeHistory.map(entry => (
                          <tr key={entry.id} className="border-b border-gray-100 dark:border-gray-800">
                            <td className="py-1.5 font-sans">{entry.effectiveDate}</td>
                            <td className="py-1.5">${Number(entry.amount).toFixed(2)}</td>
                            <td className="py-1.5 capitalize font-sans">{entry.frequency}</td>
                            <td className="py-1.5">${(entry.frequency === 'biweekly' ? entry.amount * (26 / 12) : entry.amount).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </Card>
            )}

            {/* Transactions tab */}
            {activeTab === 'transactions' && (
              <div className="flex flex-col gap-6">
                <form onSubmit={addTransaction} className="flex flex-wrap gap-2">
                  <input
                    placeholder="Description (e.g. Starbucks)"
                    value={form.description}
                    onChange={e => setForm({ ...form, description: e.target.value })}
                    className="flex-[2] min-w-[160px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
                  />
                  <input
                    placeholder="Amount"
                    type="number"
                    step="0.01"
                    value={form.amount}
                    onChange={e => setForm({ ...form, amount: e.target.value })}
                    className="flex-1 min-w-[100px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
                  />
                  <input
                    type="date"
                    value={form.date}
                    onChange={e => setForm({ ...form, date: e.target.value })}
                    className="flex-1 min-w-[140px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
                  />
                  <button type="submit" disabled={loading} className="btn-primary">
                    {loading ? 'Categorizing…' : 'Add'}
                  </button>
                </form>

                <form onSubmit={quickAdd} className="flex flex-wrap gap-2">
                  <input
                    placeholder='Or describe it in plain English — e.g. "Starbucks 5.50 today"'
                    value={quickAddText}
                    onChange={e => setQuickAddText(e.target.value)}
                    className="flex-1 min-w-[240px] rounded-lg border border-dashed border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
                  />
                  <button type="submit" disabled={quickAdding} className="btn-primary">
                    {quickAdding ? 'Parsing…' : 'Quick add'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowImportWizard(true)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                  >
                    <Upload className="w-4 h-4" /> Import statement
                  </button>
                </form>

                <div className="flex flex-wrap gap-6">
                  <Card className="flex-1 min-w-[320px]" bodyClassName="p-0 overflow-hidden">
                    <div className="flex flex-wrap justify-between items-center gap-2 p-5 pb-3">
                      <h3 className="font-semibold text-navy dark:text-gray-100">Transactions</h3>
                      <div className="flex flex-wrap gap-2">
                        <input
                          placeholder="Search…"
                          value={searchText}
                          onChange={e => setSearchText(e.target.value)}
                          className="text-xs rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-2 py-1 w-28 focus:outline-none focus:ring-2 focus:ring-mint"
                        />
                        <select
                          value={categoryFilter}
                          onChange={e => setCategoryFilter(e.target.value)}
                          className="text-xs rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-mint"
                        >
                          <option value="All">All categories</option>
                          {categories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select
                          value={selectedMonth}
                          onChange={e => setSelectedMonth(e.target.value)}
                          className="text-xs rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-mint"
                        >
                          <option value="All">All time</option>
                          {availableMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
                        </select>
                      </div>
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left border-y border-gray-200 dark:border-gray-700 text-slate-500 dark:text-slate-400 text-xs">
                          <th className="px-5 py-2 font-medium">Date</th>
                          <th className="px-2 py-2 font-medium">Description</th>
                          <th className="px-2 py-2 font-medium">Category</th>
                          <th className="px-2 py-2 font-medium">Amount</th>
                          <th className="px-2 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredTransactions.map(t => (
                          <tr key={t.id} className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition">
                            <td className="px-5 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">{t.date}</td>
                            <td className="px-2 py-2 dark:text-gray-200">{t.description}</td>
                            <td className="px-2 py-2">
                              <span className="inline-flex items-center gap-1.5 bg-gray-100 dark:bg-gray-700 text-navy dark:text-gray-200 text-xs px-2 py-0.5 rounded-full">
                                <CategoryIcon category={t.category} />
                                {t.category}
                              </span>
                            </td>
                            <td className="px-2 py-2 font-mono dark:text-gray-200">${Number(t.amount).toFixed(2)}</td>
                            <td className="px-2 py-2">
                              <button onClick={() => deleteTransaction(t.id, t.description)} className="text-red-500 hover:text-red-700 transition">✕</button>
                            </td>
                          </tr>
                        ))}
                        {filteredTransactions.length === 0 && (
                          <tr>
                            <td colSpan={5} className="px-5 py-6 text-slate-400 dark:text-slate-500 text-sm">
                              {transactions.length === 0 ? 'No transactions yet — add one above.' : 'No transactions match your filters.'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </Card>

                  <Card title={`Spending by Category${selectedMonth !== 'All' ? ` — ${monthLabel(selectedMonth)}` : ''}`} className="flex-1 min-w-[320px]">
                    {chartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={280}>
                        <PieChart>
                          <Pie data={chartData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
                            {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                          </Pie>
                          <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : (
                      <p className="text-slate-400 dark:text-slate-500 text-sm">{selectedMonth === 'All' ? 'Add transactions to see your breakdown.' : `No spending in ${monthLabel(selectedMonth)}.`}</p>
                    )}
                  </Card>
                </div>

                <Card
                  title="Recurring Transactions"
                  headerRight={
                    <button onClick={() => setShowRecurringForm(s => !s)} className="text-xs px-2.5 py-1 rounded-md border border-gray-300 dark:border-gray-700 text-slate-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition">
                      {showRecurringForm ? 'Cancel' : '+ New'}
                    </button>
                  }
                >
                  {showRecurringForm && (
                    <form onSubmit={addRecurring} className="flex flex-wrap gap-2 mb-4">
                      <input
                        placeholder="Description (e.g. Rent)"
                        value={recurringForm.description}
                        onChange={e => setRecurringForm({ ...recurringForm, description: e.target.value })}
                        className="flex-[2] min-w-[160px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
                      />
                      <input
                        placeholder="Amount"
                        type="number"
                        step="0.01"
                        value={recurringForm.amount}
                        onChange={e => setRecurringForm({ ...recurringForm, amount: e.target.value })}
                        className="flex-1 min-w-[100px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
                      />
                      <select
                        value={recurringForm.category}
                        onChange={e => setRecurringForm({ ...recurringForm, category: e.target.value })}
                        className="min-w-[140px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
                      >
                        {categories.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <select
                        value={recurringForm.frequency}
                        onChange={e => setRecurringForm({ ...recurringForm, frequency: e.target.value })}
                        className="min-w-[120px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
                      >
                        <option value="weekly">Weekly</option>
                        <option value="biweekly">Biweekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                      <input
                        type="date"
                        value={recurringForm.startDate}
                        onChange={e => setRecurringForm({ ...recurringForm, startDate: e.target.value })}
                        className="flex-1 min-w-[140px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
                      />
                      <button type="submit" disabled={savingRecurring} className="btn-primary">
                        {savingRecurring ? 'Saving…' : 'Save'}
                      </button>
                    </form>
                  )}

                  {recurring.length === 0 ? (
                    <p className="text-slate-400 dark:text-slate-500 text-sm">No recurring transactions set up — good for rent, subscriptions, or anything you pay on a schedule.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-slate-500 dark:text-slate-400 text-xs">
                          <th className="pb-2 font-medium">Description</th>
                          <th className="pb-2 font-medium">Amount</th>
                          <th className="pb-2 font-medium">Category</th>
                          <th className="pb-2 font-medium">Frequency</th>
                          <th className="pb-2 font-medium">Next due</th>
                          <th className="pb-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {recurring.map(r => (
                          <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800">
                            <td className="py-2 dark:text-gray-200">{r.description}</td>
                            <td className="py-2 font-mono dark:text-gray-200">${Number(r.amount).toFixed(2)}</td>
                            <td className="py-2">
                              <span className="inline-flex items-center gap-1.5 bg-gray-100 dark:bg-gray-700 text-navy dark:text-gray-200 text-xs px-2 py-0.5 rounded-full">
                                <CategoryIcon category={r.category} />
                                {r.category}
                              </span>
                            </td>
                            <td className="py-2 capitalize dark:text-gray-300">{r.frequency}</td>
                            <td className="py-2 font-mono text-xs text-slate-500 dark:text-slate-400">{r.nextDueDate}</td>
                            <td className="py-2">
                              <button onClick={() => deleteRecurring(r.id, r.description)} className="text-red-500 hover:text-red-700 transition">✕</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </div>
            )}

            {/* Savings tab */}
            {activeTab === 'savings' && (
              <Card title="Savings & Investments">
                <form onSubmit={addSavings} className="flex flex-wrap gap-2 mb-4">
                  <select
                    value={savingsForm.type}
                    onChange={e => setSavingsForm({ ...savingsForm, type: e.target.value })}
                    className="min-w-[120px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
                  >
                    <option value="Savings">Savings</option>
                    <option value="Investment">Investment</option>
                    <option value="Retirement">Retirement</option>
                    <option value="Other">Other</option>
                  </select>
                  <input
                    placeholder="Description (optional, e.g. 401k contribution)"
                    value={savingsForm.description}
                    onChange={e => setSavingsForm({ ...savingsForm, description: e.target.value })}
                    className="flex-[2] min-w-[180px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
                  />
                  <input
                    placeholder="Amount"
                    type="number"
                    step="0.01"
                    value={savingsForm.amount}
                    onChange={e => setSavingsForm({ ...savingsForm, amount: e.target.value })}
                    className="flex-1 min-w-[100px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
                  />
                  <input
                    type="date"
                    value={savingsForm.date}
                    onChange={e => setSavingsForm({ ...savingsForm, date: e.target.value })}
                    className="flex-1 min-w-[140px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
                  />
                  <button type="submit" disabled={savingSavings} className="btn-primary">
                    {savingSavings ? 'Saving…' : 'Add'}
                  </button>
                </form>

                <div className="flex flex-wrap gap-8">
                  <div className="flex-1 min-w-[300px]">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-slate-500 dark:text-slate-400 text-xs">
                          <th className="pb-2 font-medium">Date</th>
                          <th className="pb-2 font-medium">Type</th>
                          <th className="pb-2 font-medium">Description</th>
                          <th className="pb-2 font-medium">Amount</th>
                          <th className="pb-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {savings.map(s => (
                          <tr key={s.id} className="border-b border-gray-100 dark:border-gray-800">
                            <td className="py-2 font-mono text-xs text-slate-500 dark:text-slate-400">{s.date}</td>
                            <td className="py-2"><span className="bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 text-xs px-2 py-0.5 rounded-full">{s.type}</span></td>
                            <td className="py-2 dark:text-gray-200">{s.description || '—'}</td>
                            <td className="py-2 font-mono dark:text-gray-200">${Number(s.amount).toFixed(2)}</td>
                            <td className="py-2"><button onClick={() => deleteSavings(s.id, s.type)} className="text-red-500 hover:text-red-700 transition">✕</button></td>
                          </tr>
                        ))}
                        {savings.length === 0 && (
                          <tr><td colSpan={5} className="py-6 text-slate-400 dark:text-slate-500 text-sm">No savings or investments logged yet — add one above.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex-1 min-w-[300px]">
                    {savingsChartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={240}>
                        <PieChart>
                          <Pie data={savingsChartData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                            {savingsChartData.map((_, i) => <Cell key={i} fill={SAVINGS_COLORS[i % SAVINGS_COLORS.length]} />)}
                          </Pie>
                          <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : <p className="text-slate-400 dark:text-slate-500 text-sm">Log savings/investments to see the breakdown by type.</p>}
                  </div>
                </div>
              </Card>
            )}

            {/* Budgets tab */}
            {activeTab === 'budgets' && (
              <Card title="Budgets">
                {budgetNudge && !nudgeDismissed && (
                  <div className="flex justify-between items-start gap-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-800 rounded-lg px-4 py-3 text-sm mb-4 dark:text-amber-100">
                    <span>🔔 {budgetNudge}</span>
                    <button onClick={() => setNudgeDismissed(true)} className="text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 transition shrink-0 leading-none">✕</button>
                  </div>
                )}

                <form onSubmit={saveBudget} className="flex flex-wrap gap-2 mb-4">
                  <select
                    value={budgetForm.category}
                    onChange={e => setBudgetForm({ ...budgetForm, category: e.target.value })}
                    className="min-w-[160px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
                  >
                    {categories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input
                    placeholder="Monthly limit"
                    type="number"
                    step="0.01"
                    value={budgetForm.limit}
                    onChange={e => setBudgetForm({ ...budgetForm, limit: e.target.value })}
                    className="flex-1 min-w-[120px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
                  />
                  <button type="submit" disabled={savingBudget} className="btn-primary">
                    {savingBudget ? 'Saving…' : 'Set budget'}
                  </button>
                </form>

                {budgetProgress.length === 0 ? (
                  <p className="text-slate-400 dark:text-slate-500 text-sm">No budgets set yet — pick a category above and set a monthly limit.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {budgetProgress.map(b => {
                      const pct = Math.min(b.percent, 100)
                      const over = b.percent >= 100
                      const near = b.percent >= 80 && !over
                      const barColor = over ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-emerald-500'
                      return (
                        <div key={b.category}>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-navy dark:text-gray-200 font-medium flex items-center gap-1.5">
                              <CategoryIcon category={b.category} />
                              {b.category}
                            </span>
                            <span className={over ? 'text-red-500 font-mono' : 'text-slate-500 dark:text-slate-400 font-mono'}>
                              ${b.spent.toFixed(2)} / ${b.limit.toFixed(2)}
                              <button onClick={() => deleteBudget(b.category)} className="ml-2 text-slate-400 hover:text-red-500 transition font-sans">✕</button>
                            </span>
                          </div>
                          <div className="bg-gray-100 dark:bg-gray-800 rounded-full h-2.5 overflow-hidden">
                            <div className={`h-full ${barColor} transition-all duration-300`} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      )
                    })}
                    {daysLeftInMonth !== null && (
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{daysLeftInMonth} days left in the month</p>
                    )}
                  </div>
                )}
              </Card>
            )}

            {/* Chat tab */}
            {activeTab === 'chat' && (
              <Card
                title="Ask about your spending"
                headerRight={chatLog.length > 0 && (
                  <button onClick={clearChatHistory} className="text-xs px-2.5 py-1 rounded-md border border-gray-300 dark:border-gray-700 text-slate-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition">
                    Clear chat
                  </button>
                )}
              >
                <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 min-h-[100px] max-h-96 overflow-y-auto mb-3 flex flex-col gap-2">
                  {chatLog.length === 0 && <p className="text-slate-400 dark:text-slate-500 text-sm">Try: "How much did I spend on dining this month?"</p>}
                  {chatLog.map((m, i) => (
                    <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <p className={`text-sm px-3 py-2 rounded-2xl max-w-[85%] ${
                        m.role === 'user'
                          ? 'bg-navy dark:bg-mint text-white dark:text-navy rounded-br-sm'
                          : 'bg-gray-100 dark:bg-gray-800 text-navy dark:text-gray-200 rounded-bl-sm'
                      }`}>
                        {m.text}
                      </p>
                    </div>
                  ))}
                </div>
                <form onSubmit={askAi} className="flex gap-2">
                  <input
                    value={question}
                    onChange={e => setQuestion(e.target.value)}
                    placeholder="Ask a question about your finances…"
                    className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
                  />
                  <button
                    type="button"
                    onClick={startListening}
                    title="Speak your question"
                    className={`px-3 py-2 rounded-lg text-sm transition flex items-center ${
                      listening ? 'bg-red-500 text-white' : 'bg-gray-100 dark:bg-gray-800 text-navy dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700'
                    }`}
                  >
                    {listening ? '● Listening…' : <Mic className="w-4 h-4" />}
                  </button>
                  <button type="submit" disabled={asking} className="btn-primary">
                    {asking ? 'Thinking…' : 'Ask'}
                  </button>
                </form>
              </Card>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmState}
        message={confirmState?.message}
        onConfirm={confirmState?.onConfirm}
        onCancel={() => setConfirmState(null)}
      />
      {showImportWizard && (
        <ImportWizard
          categories={categories}
          onClose={() => setShowImportWizard(false)}
          onImported={async (count) => {
            setShowImportWizard(false)
            await loadData()
            showToast(`Imported ${count} transaction${count === 1 ? '' : 's'}`)
          }}
        />
      )}
      <ToastContainer toasts={toasts} />
    </div>
  )
}

function Stat({ label, value, accent = 'text-white' }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-xl font-semibold font-mono mt-0.5 ${accent}`}>{value}</p>
    </div>
  )
}

function Card({ title, headerRight, children, className = '', bodyClassName = 'p-5' }) {
  return (
    <div className={`bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm ${bodyClassName} ${className}`}>
      {title && (
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-semibold text-navy dark:text-gray-100">{title}</h3>
          {headerRight}
        </div>
      )}
      {children}
    </div>
  )
}
