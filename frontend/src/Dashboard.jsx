import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cell, Tooltip, ResponsiveContainer, Legend, BarChart, Bar, LabelList, LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts'
import { signOut } from 'firebase/auth'
import { Mic, Upload, Camera, TrendingUp, Users, Shield, Megaphone, Sparkles, LifeBuoy, ChevronLeft, ChevronRight, LayoutDashboard, Receipt, PiggyBank, Wallet, MessageCircle, Settings as SettingsIcon } from 'lucide-react'
import { auth } from './firebase'
import { authedFetch, API } from './api'
import ConfirmDialog from './ConfirmDialog'
import { useToasts, ToastContainer } from './Toast'
import CategoryIcon from './CategoryIcon'
import { SkeletonCard } from './Skeleton'
import ImportWizard from './ImportWizard'
import ReceiptWizard from './ReceiptWizard'
import Sidebar from './Sidebar'
import Lightfall from './Lightfall'
import Settings from './Settings'
import HealthScore from './HealthScore'
import Admin from './Admin'
import DeepAnalysis from './DeepAnalysis'
import Walkthrough from './Walkthrough'
import Help from './Help'
import TextType from './TextType'
import SavingsGoals from './SavingsGoals'

const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#64748b']
const SAVINGS_COLORS = ['#4ade80', '#60a5fa', '#facc15', '#a78bfa']

// Fixed identity (id + icon) for every tab — only order and display label
// are customizable, via Settings → Navigation.
// Tabs where the income/spending numbers are actually relevant to what
// you're doing — you want "remaining this month" visible while logging a
// transaction or setting a budget. On Chat, Analyze, Settings, Predict and
// Admin it's ~200px of stats you aren't thinking about, so it's hidden.
// The income card lives on Overview only. It's ~200px of stats that are
// only really the point of that one tab — everywhere else it pushed the
// actual content down. The admin broadcast below is separate and DOES show
// everywhere, since an announcement nobody sees is pointless.
const SHOW_INCOME_ON = ['overview']

const BASE_TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'transactions', label: 'Transactions', icon: Receipt },
  { id: 'savings', label: 'Savings', icon: PiggyBank },
  { id: 'budgets', label: 'Budgets', icon: Wallet },
  { id: 'predict', label: 'Predict', icon: TrendingUp },
  { id: 'household', label: 'Household', icon: Users },
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'analyze', label: 'Analyze', icon: Sparkles },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
  { id: 'help', label: 'Help', icon: LifeBuoy },
  // Only rendered for users whose server-side profile role is 'admin'.
  // Hiding the tab is cosmetic — the actual protection is requireAdmin on
  // every /api/admin/* route, so a non-admin who forced this tab open
  // would just get 404s.
  { id: 'admin', label: 'Admin', icon: Shield, adminOnly: true }
]

// Reads any saved custom order/labels from localStorage and applies them on
// top of BASE_TABS. Falls back gracefully to defaults if nothing's saved,
// and stays forward-compatible if a future BASE_TABS entry isn't in an
// older saved order yet (it just gets appended at the end).
function loadTabs(isAdmin = false) {
  const available = BASE_TABS.filter(t => !t.adminOnly || isAdmin)
  const byId = Object.fromEntries(available.map(t => [t.id, t]))
  let order = available.map(t => t.id)
  let labels = {}
  try {
    const savedOrder = JSON.parse(localStorage.getItem('tabOrder') || 'null')
    if (Array.isArray(savedOrder)) order = savedOrder.filter(id => byId[id])
    const savedLabels = JSON.parse(localStorage.getItem('tabLabels') || 'null')
    if (savedLabels && typeof savedLabels === 'object') labels = savedLabels
  } catch {
    // malformed localStorage — just use defaults
  }
  const missing = available.map(t => t.id).filter(id => !order.includes(id))
  return [...order, ...missing].map(id => ({
    id,
    label: labels[id] || byId[id].label,
    icon: byId[id].icon
  }))
}

export default function Dashboard({ user, profile, setProfile }) {
  const { toasts, showToast } = useToasts()
  const isAdmin = profile?.role === 'admin'

  // Admin-set banner, if any. Public endpoint (no auth) so it can also be
  // read before login if ever needed.
  const [broadcast, setBroadcast] = useState('')
  useEffect(() => {
    fetch(`${API}/public-settings`)
      .then(r => r.json())
      .then(d => setBroadcast(d.broadcastMessage || ''))
      .catch(() => {}) // a missing banner should never break the dashboard
  }, [])
  const [tabs, setTabs] = useState(() => loadTabs(isAdmin))

  // The profile (and therefore role) arrives asynchronously, so rebuild the
  // tab list once it's known.
  useEffect(() => {
    setTabs(loadTabs(isAdmin))
  }, [isAdmin])
  const [categories, setCategories] = useState([])
  const [confirmState, setConfirmState] = useState(null) // { message, onConfirm } | null
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('defaultTab') || 'overview')
  const [initialLoading, setInitialLoading] = useState(true)
  const backgroundEnabled = localStorage.getItem('backgroundEnabled') !== 'false'

  // "Hide on scroll" for the overview header, using the same core technique
  // HeroUI's Navbar uses: animating only transform/opacity, both compositor-
  // only properties, so the browser never has to recalculate layout during
  // the animation — that's what makes this smooth where the earlier height-
  // based version wasn't. (Kept `position: sticky` rather than `fixed` to
  // avoid coordinating with the sidebar's own collapsible width.)
  const [headerHidden, setHeaderHidden] = useState(false)
  const lastScrollY = useRef(0)
  const scrollTicking = useRef(false)

  useEffect(() => {
    const handleScroll = () => {
      if (scrollTicking.current) return
      scrollTicking.current = true

      requestAnimationFrame(() => {
        const currentY = window.scrollY
        const delta = currentY - lastScrollY.current

        if (delta > 8 && currentY > 80) {
          setHeaderHidden(true)
        } else if (delta < -8) {
          setHeaderHidden(false)
        }

        lastScrollY.current = currentY
        scrollTicking.current = false
      })
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

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
  const [editingIncomeId, setEditingIncomeId] = useState(null)

  const [savings, setSavings] = useState([])
  const [savingsSummary, setSavingsSummary] = useState({})
  const [savingsGoals, setSavingsGoals] = useState(null)
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
  const [listeningQuickAdd, setListeningQuickAdd] = useState(false)
  const [nudgeDismissed, setNudgeDismissed] = useState(false)

  const [searchText, setSearchText] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('All')
  const [currentPage, setCurrentPage] = useState(1)
  const TRANSACTIONS_PER_PAGE = Number(localStorage.getItem('transactionsPerPage')) || 10

  const [recurring, setRecurring] = useState([])
  const [showRecurringForm, setShowRecurringForm] = useState(false)
  const [recurringForm, setRecurringForm] = useState({ description: '', amount: '', category: '', frequency: 'monthly', startDate: '' })
  const [savingRecurring, setSavingRecurring] = useState(false)

  const [quickAddText, setQuickAddText] = useState('')
  const [quickAdding, setQuickAdding] = useState(false)

  const [showImportWizard, setShowImportWizard] = useState(false)
  const [showReceiptWizard, setShowReceiptWizard] = useState(false)

  // --- Spend prediction / what-if simulator ---
  const [predictBaseline, setPredictBaseline] = useState(null) // { categoryAverages, currentNetWorth, monthlyIncome }
  const [predictAdjustments, setPredictAdjustments] = useState({}) // { category: deltaAmount }
  const [predictIncomeDelta, setPredictIncomeDelta] = useState(0) // percent
  const [predictMonths, setPredictMonths] = useState(6)
  const [predictNarrative, setPredictNarrative] = useState(null)
  const [narrating, setNarrating] = useState(false)

  // --- Financial health score ---
  const [healthScore, setHealthScore] = useState(null)

  // --- Household mode ---
  const [household, setHousehold] = useState(null) // { id, members: [{uid, displayName, email}] } | null
  const [householdInvites, setHouseholdInvites] = useState([]) // pending invites addressed to me
  const [sentInvites, setSentInvites] = useState([]) // pending invites I've sent
  const [householdSpending, setHouseholdSpending] = useState(null)
  const [householdBills, setHouseholdBills] = useState([])
  const [householdMessages, setHouseholdMessages] = useState([])

  const loadHousehold = async () => {
    const [houseRes, invitesRes] = await Promise.all([
      authedFetch('/household'),
      authedFetch('/household/invites')
    ])
    const houseData = await houseRes.json()
    setHousehold(houseData.household)
    const invites = await invitesRes.json()
    setHouseholdInvites(invites.received || [])
    setSentInvites(invites.sent || [])

    if (houseData.household) {
      const [spendRes, billsRes, msgRes] = await Promise.all([
        authedFetch('/household/spending'),
        authedFetch('/household/bills'),
        authedFetch('/household/messages')
      ])
      setHouseholdSpending(await spendRes.json())
      setHouseholdBills(billsRes.ok ? await billsRes.json() : [])
      setHouseholdMessages(msgRes.ok ? await msgRes.json() : [])
    } else {
      setHouseholdSpending(null)
      setHouseholdBills([])
      setHouseholdMessages([])
    }
  }

  // --- Unseen household activity ---
  //
  // No push infrastructure here, so this is deliberately simple: remember
  // when you last opened the Household tab, and compare that against the
  // newest message/bill timestamp. Stored per-user in localStorage, so it
  // doesn't leak between accounts on a shared browser.
  //
  // Honest limitation: it only updates when household data is fetched
  // (page load, or acting on the tab) — it won't light up in real time
  // while you sit on another tab.
  const lastSeenKey = `householdLastSeen:${user.uid}`
  const [householdLastSeen, setHouseholdLastSeen] = useState(
    () => localStorage.getItem(lastSeenKey) || ''
  )

  const newestHouseholdActivity = (() => {
    const stamps = [
      ...householdMessages.map(m => m.at),
      ...householdBills.map(b => b.createdAt)
    ].filter(Boolean)
    return stamps.length > 0 ? stamps.sort().pop() : null
  })()

  const hasUnseenHousehold = !!household
    && !!newestHouseholdActivity
    && newestHouseholdActivity > householdLastSeen

  // Opening the tab marks everything currently loaded as seen.
  useEffect(() => {
    if (activeTab === 'household' && newestHouseholdActivity) {
      localStorage.setItem(lastSeenKey, newestHouseholdActivity)
      setHouseholdLastSeen(newestHouseholdActivity)
    }
  }, [activeTab, newestHouseholdActivity, lastSeenKey])

  // Remembers where the user was before opening Help, so a support ticket
  // can say "they were on Transactions" rather than the useless "they were
  // on Help".
  const previousTabRef = useRef(null)
  const [previousTab, setPreviousTab] = useState(null)
  useEffect(() => {
    if (activeTab !== 'help') {
      previousTabRef.current = activeTab
    } else {
      setPreviousTab(previousTabRef.current)
    }
  }, [activeTab])

  // First-run walkthrough. Driven by the profile flag so it shows once per
  // ACCOUNT rather than once per browser.
  const [showTour, setShowTour] = useState(false)
  useEffect(() => {
    if (profile && profile.hasSeenTour === false) setShowTour(true)
  }, [profile])

  const [inviteEmail, setInviteEmail] = useState('')
  const [sendingInvite, setSendingInvite] = useState(false)

  // --- Shared bills ---
  const [billForm, setBillForm] = useState({ name: '', amount: '', dueDate: '' })
  const [savingBill, setSavingBill] = useState(false)

  const addHouseholdBill = async (e) => {
    e.preventDefault()
    if (!billForm.name.trim() || !billForm.amount || !billForm.dueDate) return
    setSavingBill(true)
    const res = await authedFetch('/household/bills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(billForm)
    })
    setSavingBill(false)
    if (!res.ok) {
      showToast("Couldn't add that bill", 'error')
      return
    }
    const created = await res.json()
    setHouseholdBills(prev => [...prev, created].sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1)))
    setBillForm({ name: '', amount: '', dueDate: '' })
    showToast('Bill added')
  }

  const toggleBillPaid = async (bill) => {
    const previous = householdBills
    setHouseholdBills(prev => prev.map(b => (b.id === bill.id ? { ...b, paid: !b.paid } : b)))

    const res = await authedFetch(`/household/bills/${bill.id}/paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: !bill.paid })
    })
    if (!res.ok) {
      setHouseholdBills(previous)
      showToast("Couldn't update that bill", 'error')
    }
  }

  const deleteHouseholdBill = (bill) => {
    setConfirmState({
      message: `Remove "${bill.name}" from the shared bills?`,
      confirmLabel: 'Remove bill',
      onConfirm: async () => {
        setConfirmState(null)
        const previous = householdBills
        setHouseholdBills(prev => prev.filter(b => b.id !== bill.id))
        const res = await authedFetch(`/household/bills/${bill.id}`, { method: 'DELETE' })
        if (!res.ok) {
          setHouseholdBills(previous)
          showToast("Couldn't remove that bill", 'error')
        }
      }
    })
  }

  // --- Household chat ---
  const [messageText, setMessageText] = useState('')
  const [sendingMessage, setSendingMessage] = useState(false)

  const sendHouseholdMessage = async (e) => {
    e.preventDefault()
    if (!messageText.trim()) return
    setSendingMessage(true)
    const res = await authedFetch('/household/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: messageText.trim() })
    })
    setSendingMessage(false)
    if (!res.ok) {
      showToast("Couldn't send that message", 'error')
      return
    }
    // Resolve the response BEFORE the state updater — the `prev => ...`
    // callback isn't async, so `await` isn't valid inside it.
    const created = await res.json()
    setHouseholdMessages(prev => [...prev, created])
    setMessageText('')
  }

  const sendHouseholdInvite = async (e) => {
    e.preventDefault()
    if (!inviteEmail.trim()) return
    setSendingInvite(true)
    const res = await authedFetch('/household/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail.trim() })
    })
    setSendingInvite(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || "Couldn't send that invite", 'error')
      return
    }
    setInviteEmail('')
    const data = await res.json().catch(() => ({}))
    showToast(
      data.alreadyPending
        ? 'They already have a pending invite from you'
        : "Invite sent — they'll see it in their Household tab"
    )
    loadHousehold()
  }

  const cancelSentInvite = async (id) => {
    await authedFetch(`/household/invites/${id}`, { method: 'DELETE' })
    await loadHousehold()
    showToast('Invite cancelled')
  }

  const acceptHouseholdInvite = async (id) => {
    await authedFetch(`/household/invites/${id}/accept`, { method: 'POST' })
    await loadHousehold()
    showToast('Joined household')
  }

  const declineHouseholdInvite = async (id) => {
    await authedFetch(`/household/invites/${id}/decline`, { method: 'POST' })
    await loadHousehold()
  }

  const leaveHousehold = () => {
    setConfirmState({
      message: "Leave this household? You'll stop seeing each other's shared spending view.",
      confirmLabel: 'Leave household',
      onConfirm: async () => {
        await authedFetch('/household/leave', { method: 'DELETE' })
        setConfirmState(null)
        await loadHousehold()
        showToast('Left household')
      }
    })
  }

  const loadData = async () => {
    // Catch up any due recurring transactions first, so they're already
    // reflected in the transactions list this same load.
    await authedFetch('/recurring/process', { method: 'POST' })

    const [txRes, sumRes, overviewRes, incomeRes, savingsRes, savingsSumRes, goalsRes, budgetsRes, trendRes, historyRes, categoriesRes, recurringRes, predictRes, healthRes] = await Promise.all([
      authedFetch('/transactions'),
      authedFetch('/transactions/summary'),
      authedFetch('/overview'),
      authedFetch('/income'),
      authedFetch('/savings'),
      authedFetch('/savings/summary'),
      authedFetch('/savings/goals'),
      authedFetch('/budgets/progress'),
      authedFetch('/trend'),
      authedFetch('/chat/history'),
      authedFetch('/categories'),
      authedFetch('/recurring'),
      authedFetch('/predict/baseline'),
      authedFetch('/health-score')
    ])
    setTransactions(await txRes.json())
    setSummary(await sumRes.json())
    setOverview(await overviewRes.json())
    setIncomeHistory(await incomeRes.json())
    setSavings(await savingsRes.json())
    setSavingsSummary(await savingsSumRes.json())
    setSavingsGoals(goalsRes.ok ? await goalsRes.json() : null)
    const budgetsData = await budgetsRes.json()
    setBudgetProgress(budgetsData.budgets || [])
    const newNudge = budgetsData.nudge || null
    setBudgetNudge(prev => {
      if (newNudge !== prev) setNudgeDismissed(false)
      return newNudge
    })
    setDaysLeftInMonth(budgetsData.daysLeftInMonth ?? null)
    setTrend(await trendRes.json())

    try {
      setPredictBaseline(await predictRes.json())
    } catch (err) {
      console.error('Failed to load /predict/baseline:', err)
      setPredictBaseline(null)
    }

    try {
      setHealthScore(await healthRes.json())
    } catch (err) {
      console.error('Failed to load /health-score:', err)
      setHealthScore(null)
    }

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

    try {
      await loadHousehold()
    } catch (err) {
      console.error('Failed to load household data:', err)
    }
  }

  useEffect(() => {
    loadData().finally(() => setInitialLoading(false))
  }, [])

  // --- Optimistic updates ---
  //
  // Every mutation used to await the server AND a full 13-endpoint refetch
  // before the UI moved at all, which made even deleting one row feel slow.
  //
  // Deletes are fully optimistic: we know exactly what disappears, so the
  // row goes immediately and we roll back if the request fails.
  //
  // Adds can't be — the server assigns the id and the AI assigns the
  // category, so the real row isn't knowable client-side. Instead they
  // splice the server's response straight into state rather than refetching
  // everything, which is still far faster than the old path.
  //
  // Derived figures (overview, budgets, health score, trend) genuinely do
  // need recomputing server-side, so those refresh in the background
  // WITHOUT blocking the interaction that triggered them.

  const refreshDerived = () => {
    // Fire-and-forget: updates totals/charts after the fact. Deliberately
    // not awaited, so the UI never waits on it.
    loadData().catch(err => console.error('Background refresh failed:', err))
  }

  const addTransaction = async (e) => {
    e.preventDefault()
    if (!form.description || !form.amount || !form.date) return
    setLoading(true)
    const res = await authedFetch('/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    })
    setLoading(false)

    if (!res.ok) {
      showToast("Couldn't add that transaction", 'error')
      return
    }

    const created = await res.json()
    // Splice the real row in immediately, keeping the list date-sorted.
    setTransactions(prev => [created, ...prev].sort((a, b) => (a.date < b.date ? 1 : -1)))
    setForm({ description: '', amount: '', date: '' })
    showToast('Transaction added')
    refreshDerived()
  }

  const deleteTransaction = (id, description) => {
    setConfirmState({
      message: `Delete "${description}"? This can't be undone.`,
      onConfirm: async () => {
        setConfirmState(null)
        const previous = transactions
        setTransactions(prev => prev.filter(t => t.id !== id)) // gone instantly
        showToast('Transaction deleted')

        const res = await authedFetch(`/transactions/${id}`, { method: 'DELETE' })
        if (!res.ok) {
          setTransactions(previous) // roll back — the row never actually went away
          showToast("Couldn't delete that — put it back", 'error')
          return
        }
        refreshDerived()
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
    setTransactions(prev => [transaction, ...prev].sort((a, b) => (a.date < b.date ? 1 : -1)))
    showToast(`Added "${transaction.description}" — $${transaction.amount.toFixed(2)}`)
    refreshDerived()
  }

  const addRecurring = async (e) => {
    e.preventDefault()
    if (!recurringForm.description || !recurringForm.amount || !recurringForm.startDate) return
    setSavingRecurring(true)
    const res = await authedFetch('/recurring', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recurringForm)
    })
    setSavingRecurring(false)

    if (!res.ok) {
      showToast("Couldn't set up that recurring transaction", 'error')
      return
    }

    const created = await res.json()
    setRecurring(prev => [...prev, created].sort((a, b) => (a.nextDueDate > b.nextDueDate ? 1 : -1)))
    setRecurringForm(f => ({ ...f, description: '', amount: '', startDate: '' }))
    setShowRecurringForm(false)
    showToast('Recurring transaction set up')
    refreshDerived()
  }

  const deleteRecurring = (id, description) => {
    setConfirmState({
      message: `Stop the recurring "${description}" transaction? Past transactions it already created won't be removed.`,
      confirmLabel: 'Stop recurring',
      onConfirm: async () => {
        setConfirmState(null)
        const previous = recurring
        setRecurring(prev => prev.filter(r => r.id !== id))
        showToast('Recurring transaction removed')

        const res = await authedFetch(`/recurring/${id}`, { method: 'DELETE' })
        if (!res.ok) {
          setRecurring(previous)
          showToast("Couldn't remove that — put it back", 'error')
          return
        }
      }
    })
  }

  const addIncome = async (e) => {
    e.preventDefault()
    if (!incomeForm.amount || !incomeForm.effectiveDate) return
    setSavingIncome(true)
    // Editing replaces the old entry rather than leaving a stale duplicate —
    // income has no update endpoint, so a clean replace (delete + create)
    // keeps the history accurate.
    if (editingIncomeId) {
      await authedFetch(`/income/${editingIncomeId}`, { method: 'DELETE' })
    }
    await authedFetch('/income', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incomeForm)
    })
    setIncomeForm({ amount: '', frequency: 'monthly', effectiveDate: '' })
    setEditingIncomeId(null)
    setShowIncomeForm(false)
    await loadData()
    setSavingIncome(false)
    showToast(editingIncomeId ? 'Income entry updated' : 'Income updated')
  }

  const startEditIncome = (entry) => {
    setIncomeForm({ amount: entry.amount, frequency: entry.frequency, effectiveDate: entry.effectiveDate })
    setEditingIncomeId(entry.id)
    setShowIncomeForm(true)
  }

  const cancelIncomeForm = () => {
    setIncomeForm({ amount: '', frequency: 'monthly', effectiveDate: '' })
    setEditingIncomeId(null)
    setShowIncomeForm(false)
  }

  const deleteIncome = (id, effectiveDate) => {
    setConfirmState({
      message: `Delete the income entry effective from ${effectiveDate}? This can't be undone.`,
      onConfirm: async () => {
        setConfirmState(null)
        const previous = incomeHistory
        setIncomeHistory(prev => prev.filter(e => e.id !== id))
        showToast('Income entry deleted')

        const res = await authedFetch(`/income/${id}`, { method: 'DELETE' })
        if (!res.ok) {
          setIncomeHistory(previous)
          showToast("Couldn't delete that — put it back", 'error')
          return
        }
        refreshDerived()
      }
    })
  }

  const addSavings = async (e) => {
    e.preventDefault()
    if (!savingsForm.amount || !savingsForm.date) return
    setSavingSavings(true)
    const res = await authedFetch('/savings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savingsForm)
    })
    setSavingSavings(false)

    if (!res.ok) {
      showToast("Couldn't add that savings entry", 'error')
      return
    }

    const created = await res.json()
    setSavings(prev => [created, ...prev].sort((a, b) => (a.date < b.date ? 1 : -1)))
    setSavingsForm({ type: 'Savings', description: '', amount: '', date: '' })
    showToast('Savings entry added')
    refreshDerived()
  }

  const deleteSavings = (id, type) => {
    setConfirmState({
      message: `Delete this ${type} entry? This can't be undone.`,
      onConfirm: async () => {
        setConfirmState(null)
        const previous = savings
        setSavings(prev => prev.filter(s => s.id !== id))
        showToast('Savings entry deleted')

        const res = await authedFetch(`/savings/${id}`, { method: 'DELETE' })
        if (!res.ok) {
          setSavings(previous)
          showToast("Couldn't delete that — put it back", 'error')
          return
        }
        refreshDerived()
      }
    })
  }

  const saveBudget = async (e) => {
    e.preventDefault()
    if (!budgetForm.limit) return
    setSavingBudget(true)
    const res = await authedFetch('/budgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(budgetForm)
    })

    if (!res.ok) {
      setSavingBudget(false)
      showToast("Couldn't save that budget", 'error')
      return
    }

    setBudgetForm(f => ({ ...f, limit: '' }))
    // Budget progress (percent spent, colour, AI nudge) is computed
    // server-side against this month's transactions, so unlike a plain list
    // insert there's nothing meaningful to splice in optimistically here.
    await loadData()
    setSavingBudget(false)
    showToast('Budget saved')
  }

  const deleteBudget = (category) => {
    setConfirmState({
      message: `Remove the ${category} budget?`,
      confirmLabel: 'Remove budget',
      onConfirm: async () => {
        setConfirmState(null)
        const previous = budgetProgress
        setBudgetProgress(prev => prev.filter(b => b.category !== category))
        showToast('Budget removed')

        const res = await authedFetch(`/budgets/${category}`, { method: 'DELETE' })
        if (!res.ok) {
          setBudgetProgress(previous)
          showToast("Couldn't remove that — put it back", 'error')
          return
        }
        refreshDerived()
      }
    })
  }

  const clearChatHistory = async () => {
    await authedFetch('/chat/history', { method: 'DELETE' })
    setChatLog([])
    showToast('Chat cleared')
  }

  const startVoiceInput = (setText, setListeningFlag) => {
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
      setText(prev => (prev ? prev + ' ' : '') + transcript)
    }
    recognition.onend = () => setListeningFlag(false)
    recognition.onerror = () => setListeningFlag(false)
    recognition.start()
    setListeningFlag(true)
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

  useEffect(() => { setCurrentPage(1) }, [selectedMonth, categoryFilter, searchText])

  const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / TRANSACTIONS_PER_PAGE))
  const pageSafe = Math.min(currentPage, totalPages)
  const paginatedTransactions = filteredTransactions.slice(
    (pageSafe - 1) * TRANSACTIONS_PER_PAGE,
    pageSafe * TRANSACTIONS_PER_PAGE
  )

  const chartData = Object.entries(
    filteredTransactions.reduce((acc, t) => {
      acc[t.category] = (acc[t.category] || 0) + t.amount
      return acc
    }, {})
  ).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  const savingsChartData = Object.entries(savingsSummary).map(([name, value]) => ({ name, value }))

  // Top categories by average spend — what the sliders let you adjust.
  const topPredictCategories = predictBaseline
    ? Object.entries(predictBaseline.categoryAverages).sort((a, b) => b[1] - a[1]).slice(0, 6)
    : []

  // Deterministic month-by-month net worth projection — this is the only
  // place the "prediction" math happens. Baseline uses today's real
  // averages/income unchanged; scenario applies whatever the sliders are
  // currently set to. AI is never involved in computing these numbers —
  // see the /predict/narrate call below, which only narrates the two
  // final totals this produces.
  const projection = useMemo(() => {
    if (!predictBaseline) return { baseline: [], scenario: [], baselineFinal: 0, scenarioFinal: 0 }

    const { categoryAverages, currentNetWorth, monthlyIncome } = predictBaseline
    const baselineMonthlySpend = Object.values(categoryAverages).reduce((sum, v) => sum + v, 0)

    const adjustmentTotal = Object.values(predictAdjustments).reduce((sum, v) => sum + (Number(v) || 0), 0)
    const scenarioMonthlySpend = Math.max(0, baselineMonthlySpend + adjustmentTotal)
    const scenarioMonthlyIncome = monthlyIncome * (1 + predictIncomeDelta / 100)

    const baseline = []
    const scenario = []
    for (let m = 0; m <= predictMonths; m++) {
      baseline.push({ month: `M${m}`, netWorth: currentNetWorth + m * (monthlyIncome - baselineMonthlySpend) })
      scenario.push({ month: `M${m}`, netWorth: currentNetWorth + m * (scenarioMonthlyIncome - scenarioMonthlySpend) })
    }

    return {
      baseline,
      scenario,
      baselineFinal: baseline[baseline.length - 1].netWorth,
      scenarioFinal: scenario[scenario.length - 1].netWorth
    }
  }, [predictBaseline, predictAdjustments, predictIncomeDelta, predictMonths])

  const predictChartData = projection.baseline.map((b, i) => ({
    month: b.month,
    baseline: b.netWorth,
    scenario: projection.scenario[i]?.netWorth
  }))

  const getNarrative = async () => {
    setNarrating(true)
    const res = await authedFetch('/predict/narrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adjustments: Object.entries(predictAdjustments).map(([category, deltaAmount]) => ({ category, deltaAmount })),
        incomeDeltaPercent: predictIncomeDelta,
        months: predictMonths,
        baselineFinal: projection.baselineFinal,
        scenarioFinal: projection.scenarioFinal
      })
    })
    const data = await res.json()
    setPredictNarrative(data.narrative)
    setNarrating(false)
  }

  return (
    <div className="min-h-screen transition-colors flex relative">
      {/* Ambient background — sits behind everything; toned down vs. the login
          screen (fewer streaks, lower opacity, no mouse interaction) so it
          stays a subtle backdrop and doesn't compete with the data. Can be
          turned off in Settings for older devices / performance. */}
      {backgroundEnabled && (
        <div className="fixed inset-0 z-0 pointer-events-none opacity-40 dark:opacity-60">
          <Lightfall
            colors={['#64ffda', '#8892b0', '#112240']}
            backgroundColor="#0a192f"
            speed={0.3}
            streakCount={1}
            streakWidth={1}
            streakLength={1}
            glow={0.7}
            density={0.5}
            twinkle={0.6}
            zoom={3}
            backgroundGlow={0.3}
            opacity={1}
            mouseInteraction={false}
          />
        </div>
      )}

      <Sidebar
        tabs={tabs}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        userEmail={user.email}
        userName={profile?.displayName}
        photoURL={profile?.photoURL}
        avatarEmoji={profile?.avatarEmoji}
        badges={{ household: hasUnseenHousehold }}
        onLogout={() => signOut(auth)}
      />

      <div className="flex-1 min-w-0 relative z-10 pt-14 md:pt-0">
        {/* Sticky page header + overview — hides on scroll down, reappears on scroll up */}
        <motion.div
          className="sticky top-14 md:top-0 z-20 bg-gray-50/80 dark:bg-gray-950/80 backdrop-blur-md border-b border-gray-200 dark:border-gray-800"
          animate={{
            y: headerHidden ? '-100%' : '0%',
            opacity: headerHidden ? 0 : 1
          }}
          style={{ pointerEvents: headerHidden ? 'none' : 'auto' }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
        >
          <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-4">
            {broadcast && (
              <div className="flex items-start gap-2 bg-sky-50 dark:bg-sky-900/30 border border-sky-300 dark:border-sky-800 rounded-lg px-4 py-2.5 text-sm mb-4 text-sky-900 dark:text-sky-100">
                <Megaphone className="w-4 h-4 shrink-0 mt-0.5" />
                <TextType
                  as="span"
                  text={broadcast}
                  typingSpeed={35}
                  initialDelay={300}
                  loop={false}
                  cursorCharacter="_"
                  hideCursorWhileTyping={false}
                />
              </div>
            )}
            <p className={`text-slate-500 dark:text-slate-400 text-sm ${SHOW_INCOME_ON.includes(activeTab) ? 'mb-4' : ''}`}>
              {profile?.displayName ? `Welcome back, ${profile.displayName}.` : 'Add a transaction and AI will categorize it automatically.'}
            </p>

            {!initialLoading && SHOW_INCOME_ON.includes(activeTab) && (
              <>
                {/* Overview card */}
                <div className="bg-navy/95 dark:bg-gray-900/90 backdrop-blur-md dark:border dark:border-gray-800 text-white rounded-2xl shadow-lg p-5">
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

                <AnimatePresence>
                  {showIncomeForm && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <form onSubmit={addIncome} className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-white/10">
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
                        {editingIncomeId && (
                          <span className="text-xs text-amber-300 whitespace-nowrap">Editing entry</span>
                        )}
                        <button
                          type="button"
                          onClick={cancelIncomeForm}
                          className="px-4 py-2 rounded-lg border border-white/20 text-white text-sm font-medium hover:bg-white/10 transition"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={savingIncome}
                          className="px-4 py-2 rounded-lg bg-mint text-navy font-medium hover:brightness-95 transition disabled:opacity-60"
                        >
                          {savingIncome ? 'Saving…' : editingIncomeId ? 'Update' : 'Save'}
                        </button>
                      </form>

                      {trend.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-white/10 max-h-56 overflow-y-auto">
                          <p className="text-xs text-slate-400 mb-2">Monthly summary</p>
                          <div className="overflow-x-auto -mx-1 px-1">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-slate-400 border-b border-white/10">
                                  <th className="pb-1.5 font-medium">Month</th>
                                  <th className="pb-1.5 font-medium">Income</th>
                                  <th className="pb-1.5 font-medium">Spent</th>
                                  <th className="pb-1.5 font-medium">Saved</th>
                                </tr>
                              </thead>
                              <tbody className="font-mono">
                                {[...trend].reverse().map(m => (
                                  <tr key={m.month} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                                    <td className="py-1.5 font-sans text-slate-300">{m.month}</td>
                                    <td className="py-1.5 text-sky-400">${m.income.toFixed(2)}</td>
                                    <td className="py-1.5 text-red-400">${m.spent.toFixed(2)}</td>
                                    <td className="py-1.5 text-mint">${m.saved.toFixed(2)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </>
          )}
          </div>
        </motion.div>

        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
          {initialLoading ? (
            <div className="flex flex-col gap-6">
              <SkeletonCard lines={4} />
              <SkeletonCard lines={5} />
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
              >
              {/* Overview tab */}
            {activeTab === 'overview' && (
              <div className="flex flex-col gap-6">
                {healthScore && (
                  <Card title="Financial Health Score" description="A snapshot of savings rate, budget adherence, and spending consistency — recalculated every time you load the app.">
                    <HealthScore data={healthScore} />
                  </Card>
                )}
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
                    <div className="overflow-x-auto -mx-1 px-1">
                      <table className="w-full mt-2 text-xs border-collapse">
                        <thead>
                          <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-slate-500 dark:text-slate-400">
                            <th className="pb-1.5 font-medium">Effective from</th>
                            <th className="pb-1.5 font-medium">Amount</th>
                            <th className="pb-1.5 font-medium">Frequency</th>
                            <th className="pb-1.5 font-medium">Monthly equivalent</th>
                            <th className="pb-1.5 font-medium"></th>
                          </tr>
                        </thead>
                        <tbody className="font-mono">
                          {incomeHistory.map(entry => (
                            <tr key={entry.id} className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                              <td className="py-1.5 font-sans">{entry.effectiveDate}</td>
                              <td className="py-1.5">${Number(entry.amount).toFixed(2)}</td>
                              <td className="py-1.5 capitalize font-sans">{entry.frequency}</td>
                              <td className="py-1.5">${(entry.frequency === 'biweekly' ? entry.amount * (26 / 12) : entry.amount).toFixed(2)}</td>
                              <td className="py-1.5 font-sans text-right">
                                <button
                                  onClick={() => { setActiveTab('overview'); startEditIncome(entry) }}
                                  className="text-slate-400 hover:text-navy dark:hover:text-mint transition mr-2"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => deleteIncome(entry.id, entry.effectiveDate)}
                                  className="text-red-500 hover:text-red-700 transition"
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </Card>
              </div>
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
                  <button
                    type="button"
                    onClick={() => startVoiceInput(setQuickAddText, setListeningQuickAdd)}
                    title="Speak your transaction"
                    className={`px-3 py-2 rounded-lg text-sm transition flex items-center ${
                      listeningQuickAdd ? 'bg-red-500 text-white' : 'bg-gray-100 dark:bg-gray-800 text-navy dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700'
                    }`}
                  >
                    {listeningQuickAdd ? '● Listening…' : <Mic className="w-4 h-4" />}
                  </button>
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
                  <button
                    type="button"
                    onClick={() => setShowReceiptWizard(true)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                  >
                    <Camera className="w-4 h-4" /> Scan receipt
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
                    <div className="overflow-x-auto -mx-1 px-1">
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
                          {paginatedTransactions.map(t => (
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
                    </div>
                    {filteredTransactions.length > TRANSACTIONS_PER_PAGE && (
                      <div className="flex justify-between items-center px-5 py-3 border-t border-gray-100 dark:border-gray-800 text-xs text-slate-500 dark:text-slate-400">
                        <span>
                          Showing {(pageSafe - 1) * TRANSACTIONS_PER_PAGE + 1}–{Math.min(pageSafe * TRANSACTIONS_PER_PAGE, filteredTransactions.length)} of {filteredTransactions.length}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={pageSafe === 1}
                            className="p-1.5 rounded-md border border-gray-300 dark:border-gray-700 disabled:opacity-30 disabled:cursor-default hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                          >
                            <ChevronLeft className="w-3.5 h-3.5" />
                          </button>
                          <span className="px-2">Page {pageSafe} of {totalPages}</span>
                          <button
                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                            disabled={pageSafe === totalPages}
                            className="p-1.5 rounded-md border border-gray-300 dark:border-gray-700 disabled:opacity-30 disabled:cursor-default hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </Card>

                  <Card title={`Spending by Category${selectedMonth !== 'All' ? ` — ${monthLabel(selectedMonth)}` : ''}`} className="flex-1 min-w-[320px]">
                    {chartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 36)}>
                        <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 24 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" horizontal={false} />
                          <XAxis type="number" fontSize={12} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                          <YAxis dataKey="name" type="category" width={110} fontSize={12} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                          <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} />
                          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                            {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                          </Bar>
                        </BarChart>
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
                    <div className="overflow-x-auto -mx-1 px-1">
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
                    </div>
                  )}
                </Card>
              </div>
            )}

            {/* Savings tab */}
            {activeTab === 'savings' && (
              <div className="flex flex-col gap-6">
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
                    <div className="overflow-x-auto -mx-1 px-1">
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
                  </div>

                  <div className="flex-1 min-w-[300px]">
                    {savingsChartData.length > 0 ? (
                      // Horizontal bars rather than a pie: with only four
                      // savings types, a small category becomes an unreadable
                      // sliver, and the labels collide. Bars stay legible
                      // however lopsided the split is.
                      <ResponsiveContainer width="100%" height={Math.max(160, savingsChartData.length * 52)}>
                        <BarChart
                          data={[...savingsChartData].sort((a, b) => b.value - a.value)}
                          layout="vertical"
                          margin={{ left: 8, right: 56 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="currentColor" className="text-gray-200 dark:text-gray-800" />
                          <XAxis
                            type="number"
                            fontSize={11}
                            stroke="currentColor"
                            className="text-slate-500 dark:text-slate-400"
                            tickFormatter={v => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
                          />
                          <YAxis
                            dataKey="name"
                            type="category"
                            width={90}
                            fontSize={12}
                            stroke="currentColor"
                            className="text-slate-500 dark:text-slate-400"
                          />
                          <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} />
                          <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={26}>
                            {savingsChartData.map((_, i) => <Cell key={i} fill={SAVINGS_COLORS[i % SAVINGS_COLORS.length]} />)}
                            <LabelList
                              dataKey="value"
                              position="right"
                              formatter={v => `$${Number(v).toFixed(0)}`}
                              className="fill-slate-500 dark:fill-slate-400"
                              fontSize={11}
                            />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <p className="text-slate-400 dark:text-slate-500 text-sm">Log savings/investments to see the breakdown by type.</p>}
                  </div>
                </div>
              </Card>

              <Card
                title="Wishlist"
                description="Things you're saving for. Money is allocated to a specific goal, so progress per item is real rather than the same pot counted several times."
              >
                <SavingsGoals
                  data={savingsGoals}
                  onChanged={loadData}
                  showToast={showToast}
                  setConfirmState={setConfirmState}
                />
              </Card>
              </div>
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
                      const near = b.percent >= (profile?.budgetNudgeThreshold ?? 80) && !over
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

            {/* Predict tab — what-if simulator */}
            {activeTab === 'predict' && (
              <div className="flex flex-col gap-6">
                <Card title="What-If Simulator" description="Adjust spending or income and see the projected impact on your net worth. All numbers are calculated deterministically — AI only explains the result, never computes it.">
                  {!predictBaseline || topPredictCategories.length === 0 ? (
                    <p className="text-slate-400 dark:text-slate-500 text-sm">
                      Log a few months of transactions to unlock projections based on your real spending averages.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-2 mb-5">
                        {[3, 6, 12].map(m => (
                          <button
                            key={m}
                            onClick={() => setPredictMonths(m)}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                              predictMonths === m ? 'border-mint bg-mint/10 text-navy dark:text-mint' : 'border-gray-300 dark:border-gray-700 text-slate-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                            }`}
                          >
                            {m} months
                          </button>
                        ))}
                      </div>

                      <ResponsiveContainer width="100%" height={260}>
                        <LineChart data={predictChartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" />
                          <XAxis dataKey="month" fontSize={12} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                          <YAxis fontSize={12} stroke="currentColor" className="text-slate-500 dark:text-slate-400" tickFormatter={v => `$${(v / 1000).toFixed(1)}k`} />
                          <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} />
                          <Legend />
                          <Line type="monotone" dataKey="baseline" name="Baseline" stroke="#8892b0" strokeWidth={2} dot={false} />
                          <Line type="monotone" dataKey="scenario" name="Your scenario" stroke="#64ffda" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>

                      <div className="grid grid-cols-2 gap-4 mt-4 mb-6">
                        <div className="bg-gray-50 dark:bg-gray-800/60 rounded-lg p-3">
                          <p className="text-xs text-slate-500 dark:text-slate-400">Baseline in {predictMonths} months</p>
                          <p className="text-lg font-mono font-semibold text-navy dark:text-gray-100">${projection.baselineFinal.toFixed(2)}</p>
                        </div>
                        <div className="bg-mint/10 rounded-lg p-3">
                          <p className="text-xs text-slate-500 dark:text-slate-400">Your scenario in {predictMonths} months</p>
                          <p className={`text-lg font-mono font-semibold ${projection.scenarioFinal >= projection.baselineFinal ? 'text-emerald-600 dark:text-mint' : 'text-red-500'}`}>
                            ${projection.scenarioFinal.toFixed(2)}
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-col gap-4">
                        <div>
                          <label className="flex justify-between text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                            <span>Income change</span>
                            <span className="font-mono text-navy dark:text-gray-200">{predictIncomeDelta > 0 ? '+' : ''}{predictIncomeDelta}%</span>
                          </label>
                          <input
                            type="range"
                            min="-20"
                            max="50"
                            value={predictIncomeDelta}
                            onChange={e => setPredictIncomeDelta(Number(e.target.value))}
                            className="w-full accent-mint"
                          />
                        </div>

                        {topPredictCategories.map(([category, avg]) => {
                          const delta = predictAdjustments[category] || 0
                          return (
                            <div key={category}>
                              <label className="flex justify-between text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                                <span className="flex items-center gap-1.5">
                                  <CategoryIcon category={category} /> {category}
                                  <span className="text-slate-400 dark:text-slate-500">(avg ${avg.toFixed(0)}/mo)</span>
                                </span>
                                <span className={`font-mono ${delta < 0 ? 'text-emerald-600 dark:text-mint' : delta > 0 ? 'text-red-500' : 'text-navy dark:text-gray-200'}`}>
                                  {delta > 0 ? '+' : ''}{delta ? `$${delta}` : '$0'}/mo
                                </span>
                              </label>
                              <input
                                type="range"
                                min={-Math.round(avg)}
                                max={Math.round(avg)}
                                value={delta}
                                onChange={e => setPredictAdjustments(a => ({ ...a, [category]: Number(e.target.value) }))}
                                className="w-full accent-mint"
                              />
                            </div>
                          )
                        })}
                      </div>

                      <div className="flex items-center gap-3 mt-6">
                        <button onClick={getNarrative} disabled={narrating} className="btn-primary">
                          {narrating ? 'Thinking…' : 'Get AI insight'}
                        </button>
                        <button
                          onClick={() => { setPredictAdjustments({}); setPredictIncomeDelta(0); setPredictNarrative(null) }}
                          className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                        >
                          Reset
                        </button>
                      </div>

                      {predictNarrative && (
                        <div className="mt-4 bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 text-sm text-navy dark:text-gray-200">
                          💡 {predictNarrative}
                        </div>
                      )}
                    </>
                  )}
                </Card>
              </div>
            )}

            {/* Household tab */}
            {activeTab === 'household' && (
              <div className="flex flex-col gap-6">
                {!household ? (
                  <Card title="Household" description="Share a spending view, bills, and a chat thread with up to 10 people — budgets, income, and transaction details stay private to each of you.">
                    <form onSubmit={sendHouseholdInvite} className="flex gap-2 max-w-md mb-2">
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={e => setInviteEmail(e.target.value)}
                        placeholder="Their account email"
                        className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
                      />
                      <button type="submit" disabled={sendingInvite} className="btn-primary">
                        {sendingInvite ? 'Sending…' : 'Send invite'}
                      </button>
                    </form>
                    <p className="text-xs text-slate-400 dark:text-slate-500 mb-6">
                      They need an existing account. No email is sent — the invite appears in
                      their own Household tab next time they open the app.
                    </p>

                    {sentInvites.length > 0 && (
                      <div className="mb-6">
                        <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Waiting on a response</p>
                        <div className="flex flex-col gap-2">
                          {sentInvites.map(inv => (
                            <div key={inv.id} className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2.5">
                              <span className="text-sm text-navy dark:text-gray-200">
                                Invite sent to {inv.toEmail}
                              </span>
                              <button
                                onClick={() => cancelSentInvite(inv.id)}
                                className="text-xs px-3 py-1 rounded-md border border-gray-300 dark:border-gray-700 text-slate-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition shrink-0 ml-3"
                              >
                                Cancel
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {householdInvites.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Pending invites for you</p>
                        <div className="flex flex-col gap-2">
                          {householdInvites.map(inv => (
                            <div key={inv.id} className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2.5">
                              <span className="text-sm text-navy dark:text-gray-200">
                                {inv.fromName || inv.fromEmail} wants to share a household with you
                              </span>
                              <span className="flex gap-2 shrink-0 ml-3">
                                <button onClick={() => acceptHouseholdInvite(inv.id)} className="text-xs px-3 py-1 rounded-md bg-mint text-navy font-medium hover:brightness-95 transition">
                                  Accept
                                </button>
                                <button onClick={() => declineHouseholdInvite(inv.id)} className="text-xs px-3 py-1 rounded-md border border-gray-300 dark:border-gray-700 text-slate-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition">
                                  Decline
                                </button>
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </Card>
                ) : (
                  <>
                    <Card
                      title="Household"
                      headerRight={
                        <button onClick={leaveHousehold} className="text-xs px-2.5 py-1 rounded-md border border-gray-300 dark:border-gray-700 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition">
                          Leave household
                        </button>
                      }
                    >
                      <div className="flex gap-2 flex-wrap">
                        {household.members.map(m => (
                          <span key={m.uid} className="text-sm bg-gray-100 dark:bg-gray-800 text-navy dark:text-gray-200 px-3 py-1.5 rounded-full">
                            {m.displayName}
                          </span>
                        ))}
                      </div>

                      <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
                        <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
                          Add someone else ({household.members.length}/10)
                        </p>
                        {household.members.length >= 10 ? (
                          <p className="text-sm text-slate-400">This household is full.</p>
                        ) : (
                          <>
                            <form onSubmit={sendHouseholdInvite} className="flex gap-2 max-w-md">
                              <input
                                type="email"
                                value={inviteEmail}
                                onChange={e => setInviteEmail(e.target.value)}
                                placeholder="Their account email"
                                className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
                              />
                              <button type="submit" disabled={sendingInvite} className="btn-primary">
                                {sendingInvite ? 'Sending…' : 'Invite'}
                              </button>
                            </form>

                            {sentInvites.length > 0 && (
                              <div className="flex flex-col gap-1.5 mt-3">
                                {sentInvites.map(inv => (
                                  <div key={inv.id} className="flex items-center justify-between text-sm">
                                    <span className="text-slate-500 dark:text-slate-400">
                                      Invite pending — {inv.toEmail}
                                    </span>
                                    <button
                                      onClick={() => cancelSentInvite(inv.id)}
                                      className="text-xs text-slate-400 hover:text-red-500 transition"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </Card>

                    {householdSpending && (
                      <Card title="This month — combined spending" description="Read-only view of each member's current-month spending, sourced live from their own account.">
                        <ResponsiveContainer width="100%" height={220}>
                          <BarChart data={householdSpending.memberSpending.map(m => ({ name: m.displayName, spent: m.total }))}>
                            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" />
                            <XAxis dataKey="name" fontSize={12} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                            <YAxis fontSize={12} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                            <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} />
                            <Bar dataKey="spent" name="Spent" radius={[4, 4, 0, 0]}>
                              {householdSpending.memberSpending.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>

                        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
                          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Recent activity</p>
                          {(householdSpending.recentTransactions || []).length === 0 ? (
                            <p className="text-sm text-slate-400">No spending logged yet this month.</p>
                          ) : (
                            <div className="flex flex-col gap-1.5">
                              {householdSpending.recentTransactions.slice(0, 8).map((t, i) => (
                                <div key={i} className="flex items-center justify-between text-sm gap-3">
                                  <span className="text-slate-500 dark:text-slate-400 font-mono text-xs shrink-0">{t.date}</span>
                                  <span className="text-navy dark:text-gray-200 truncate flex-1">{t.category}</span>
                                  <span className="text-xs text-slate-400 shrink-0 hidden sm:inline">{t.memberName}</span>
                                  <span className="font-mono text-navy dark:text-gray-200 shrink-0">${Number(t.amount).toFixed(2)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </Card>
                    )}

                    <Card title="Shared bills" description="Upcoming household costs — rent, hydro, internet. Visible to everyone in the household.">
                      <form onSubmit={addHouseholdBill} className="flex flex-wrap gap-2 mb-4">
                        <input
                          value={billForm.name}
                          onChange={e => setBillForm(f => ({ ...f, name: e.target.value }))}
                          placeholder="e.g. Hydro"
                          className="flex-1 min-w-[140px] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
                        />
                        <input
                          type="number"
                          step="0.01"
                          value={billForm.amount}
                          onChange={e => setBillForm(f => ({ ...f, amount: e.target.value }))}
                          placeholder="Amount"
                          className="w-28 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
                        />
                        <input
                          type="date"
                          value={billForm.dueDate}
                          onChange={e => setBillForm(f => ({ ...f, dueDate: e.target.value }))}
                          className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
                        />
                        <button type="submit" disabled={savingBill} className="btn-primary">
                          {savingBill ? 'Adding…' : 'Add bill'}
                        </button>
                      </form>

                      {householdBills.length === 0 ? (
                        <p className="text-sm text-slate-400">No shared bills yet.</p>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {householdBills.map(bill => {
                            const overdue = !bill.paid && bill.dueDate < new Date().toISOString().slice(0, 10)
                            const perPerson = (bill.splitBetween?.length || 1) > 1
                              ? bill.amount / bill.splitBetween.length
                              : null
                            return (
                              <div
                                key={bill.id}
                                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
                                  bill.paid
                                    ? 'border-gray-200 dark:border-gray-800 opacity-60'
                                    : overdue
                                      ? 'border-red-300 dark:border-red-900/50 bg-red-50/50 dark:bg-red-900/10'
                                      : 'border-gray-200 dark:border-gray-700'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={!!bill.paid}
                                  onChange={() => toggleBillPaid(bill)}
                                  className="w-4 h-4 accent-mint shrink-0"
                                />
                                <div className="min-w-0 flex-1">
                                  <p className={`text-sm text-navy dark:text-gray-200 ${bill.paid ? 'line-through' : ''}`}>
                                    {bill.name}
                                  </p>
                                  <p className="text-xs text-slate-400">
                                    Due {bill.dueDate}
                                    {overdue && <span className="text-red-500 ml-1.5">overdue</span>}
                                    {perPerson && <span className="ml-1.5">· ${perPerson.toFixed(2)} each</span>}
                                  </p>
                                </div>
                                <span className="font-mono text-sm text-navy dark:text-gray-200 shrink-0">
                                  ${Number(bill.amount).toFixed(2)}
                                </span>
                                <button
                                  onClick={() => deleteHouseholdBill(bill)}
                                  className="text-slate-400 hover:text-red-500 transition shrink-0 text-sm"
                                >
                                  ✕
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </Card>

                    <Card title="Household chat" description="A shared thread for whoever's in the household.">
                      <div className="max-h-72 overflow-y-auto flex flex-col gap-2 mb-3">
                        {householdMessages.length === 0 ? (
                          <p className="text-sm text-slate-400">No messages yet — say something.</p>
                        ) : (
                          householdMessages.map(m => {
                            const mine = m.fromUid === user.uid
                            return (
                              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[80%] rounded-2xl px-3 py-2 ${
                                  mine
                                    ? 'bg-mint text-navy'
                                    : 'bg-gray-100 dark:bg-gray-800 text-navy dark:text-gray-200'
                                }`}>
                                  {!mine && <p className="text-[11px] font-medium opacity-70 mb-0.5">{m.fromName}</p>}
                                  <p className="text-sm whitespace-pre-wrap break-words">{m.text}</p>
                                  <p className="text-[10px] opacity-60 mt-0.5">
                                    {new Date(m.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                  </p>
                                </div>
                              </div>
                            )
                          })
                        )}
                      </div>
                      <form onSubmit={sendHouseholdMessage} className="flex gap-2">
                        <input
                          value={messageText}
                          onChange={e => setMessageText(e.target.value)}
                          placeholder="Message the household…"
                          className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
                        />
                        <button type="submit" disabled={sendingMessage || !messageText.trim()} className="btn-primary disabled:opacity-40">
                          Send
                        </button>
                      </form>
                      <p className="text-xs text-slate-400 mt-2">
                        Messages refresh when you reload — this isn't live chat.
                      </p>
                    </Card>
                  </>
                )}
              </div>
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
                    onClick={() => startVoiceInput(setQuestion, setListening)}
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

            {/* Settings tab */}
            {activeTab === 'settings' && (
              <Settings
                user={user}
                profile={profile}
                setProfile={setProfile}
                showToast={showToast}
                categories={categories}
                onCategoriesChanged={loadData}
                baseTabs={BASE_TABS.filter(t => !t.adminOnly || isAdmin)}
                onTabsChanged={() => setTabs(loadTabs(isAdmin))}
              />
            )}

            {/* Admin tab. Guarded by isAdmin here as well as by tab
                filtering — but neither is the real protection; every
                /api/admin/* route enforces requireAdmin server-side. */}
            {activeTab === 'admin' && isAdmin && (
              <Admin currentUid={user.uid} showToast={showToast} />
            )}

            {activeTab === 'analyze' && (
              <DeepAnalysis showToast={showToast} />
            )}

            {activeTab === 'help' && (
              <Help activeTabName={previousTab} showToast={showToast} />
            )}
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title}
        message={confirmState?.message}
        confirmLabel={confirmState?.confirmLabel}
        variant={confirmState?.variant}
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
      {showReceiptWizard && (
        <ReceiptWizard
          categories={categories}
          onClose={() => setShowReceiptWizard(false)}
          onImported={async (count) => {
            setShowReceiptWizard(false)
            await loadData()
            showToast(`Imported ${count} item${count === 1 ? '' : 's'} from receipt`)
          }}
        />
      )}
      {showTour && (
        <Walkthrough onDone={() => {
          setShowTour(false)
          setProfile(p => ({ ...p, hasSeenTour: true }))
        }} />
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

function Card({ title, description, headerRight, children, className = '', bodyClassName = 'p-5' }) {
  return (
    <div className={`bg-white/85 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm ${bodyClassName} ${className}`}>
      {title && (
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="font-semibold text-navy dark:text-gray-100">{title}</h3>
            {description && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>}
          </div>
          {headerRight}
        </div>
      )}
      {children}
    </div>
  )
}
