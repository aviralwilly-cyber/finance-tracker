import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { Users, Activity, Receipt, ShieldAlert } from 'lucide-react'
import { authedFetch, API } from './api'
import { auth } from './firebase'
import ConfirmDialog from './ConfirmDialog'

const COLORS = ['#64ffda', '#60a5fa', '#f59e0b', '#a855f7', '#ef4444']

function Card({ title, description, children, headerRight }) {
  return (
    <div className="bg-white/85 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5">
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

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg bg-mint/10 flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-mint" />
      </div>
      <div>
        <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
        <p className="text-lg font-mono font-semibold text-navy dark:text-gray-100">{value}</p>
      </div>
    </div>
  )
}

const TABS = [
  { id: 'analytics', label: 'Analytics' },
  { id: 'observability', label: 'Observability' },
  { id: 'users', label: 'Users' },
  { id: 'support', label: 'Support' },
  { id: 'settings', label: 'App settings' },
  { id: 'audit', label: 'Audit log' }
]

export default function Admin({ currentUid, showToast }) {
  const [tab, setTab] = useState('analytics')
  const [analytics, setAnalytics] = useState(null)
  const [users, setUsers] = useState([])
  const [auditLog, setAuditLog] = useState([])
  const [support, setSupport] = useState({ tickets: [], openCount: 0 })
  const [observability, setObservability] = useState(null)
  const [settings, setSettings] = useState(null)
  const [broadcastDraft, setBroadcastDraft] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [loading, setLoading] = useState(true)
  const [confirmState, setConfirmState] = useState(null)
  const [viewingUser, setViewingUser] = useState(null) // { uid, email, transactions }

  const load = async () => {
    const [aRes, uRes, lRes, oRes, sRes, tRes] = await Promise.all([
      authedFetch('/admin/analytics'),
      authedFetch('/admin/users'),
      authedFetch('/admin/audit-log'),
      authedFetch('/admin/observability'),
      authedFetch('/admin/settings'),
      authedFetch('/admin/support')
    ])
    if (tRes.ok) setSupport(await tRes.json())
    if (aRes.ok) setAnalytics(await aRes.json())
    if (uRes.ok) setUsers(await uRes.json())
    if (lRes.ok) setAuditLog(await lRes.json())
    if (oRes.ok) setObservability(await oRes.json())
    if (sRes.ok) {
      const s = await sRes.json()
      setSettings(s)
      setBroadcastDraft(s.broadcastMessage || '')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const toggleDisabled = (user) => {
    const turningOff = !user.disabled
    setConfirmState({
      title: turningOff ? 'Disable this account?' : 'Re-enable this account?',
      message: turningOff
        ? `${user.email} won't be able to sign in until re-enabled. Their data is not deleted.`
        : `${user.email} will be able to sign in again.`,
      confirmLabel: turningOff ? 'Disable account' : 'Enable account',
      variant: turningOff ? 'danger' : 'primary',
      onConfirm: async () => {
        setConfirmState(null)
        const res = await authedFetch(`/admin/users/${user.uid}/disable`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: turningOff })
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          showToast(data.error || "Couldn't update that account", 'error')
          return
        }
        showToast(turningOff ? 'Account disabled' : 'Account enabled')
        load()
      }
    })
  }

  const setTicketStatus = async (ticket, status) => {
    const previous = support
    setSupport(prev => ({
      ...prev,
      tickets: prev.tickets.map(t => (t.id === ticket.id ? { ...t, status } : t)),
      openCount: prev.openCount + (status === 'resolved' ? -1 : 1)
    }))
    const res = await authedFetch(`/admin/support/${ticket.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    })
    if (!res.ok) {
      setSupport(previous)
      showToast("Couldn't update that ticket", 'error')
    }
  }

  const purgeOrphaned = (user) => {
    setConfirmState({
      title: 'Purge this leftover record?',
      message: `${user.displayName || user.uid} has no Firebase Auth account — nobody can sign in as them. This permanently deletes their remaining Firestore data. It cannot be undone.`,
      confirmLabel: 'Purge record',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmState(null)
        const res = await authedFetch(`/admin/users/${user.uid}/orphaned`, { method: 'DELETE' })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          showToast(data.error || "Couldn't purge that record", 'error')
          return
        }
        showToast('Record purged')
        load()
      }
    })
  }

  const sendPasswordReset = async (user) => {
    const res = await authedFetch(`/admin/users/${user.uid}/reset-password`, { method: 'POST' })
    if (!res.ok) {
      showToast("Couldn't generate a reset link", 'error')
      return
    }
    const { link } = await res.json()
    await navigator.clipboard.writeText(link).catch(() => {})
    showToast('Reset link copied to clipboard')
    load() // refresh audit log
  }

  const viewTransactions = (user) => {
    setConfirmState({
      title: 'View this user\'s transactions?',
      message: `This opens ${user.email}'s actual financial records. The access will be permanently recorded in the audit log against your account.`,
      confirmLabel: 'View and log access',
      variant: 'danger', // stays red — it's not destructive, but it IS privileged
      onConfirm: async () => {
        setConfirmState(null)
        const res = await authedFetch(`/admin/users/${user.uid}/transactions`)
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          showToast(data.error || "Couldn't load that data", 'error')
          return
        }
        setViewingUser({ uid: user.uid, email: user.email, transactions: await res.json() })
        load() // refresh audit log
      }
    })
  }

  const changeRole = (user, newRole) => {
    const promoting = newRole === 'admin'
    setConfirmState({
      title: promoting ? 'Make this user an admin?' : 'Remove admin access?',
      message: promoting
        ? `${user.email} will get full access to analytics, account management, and audited user data.`
        : `${user.email} will lose admin access.`,
      confirmLabel: promoting ? 'Make admin' : 'Remove admin',
      variant: promoting ? 'primary' : 'danger',
      onConfirm: async () => {
        setConfirmState(null)
        const res = await authedFetch(`/admin/users/${user.uid}/role`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: newRole })
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          showToast(data.error || "Couldn't change that role", 'error')
          return
        }
        showToast(promoting ? 'Now an admin' : 'Admin access removed')
        load()
      }
    })
  }

  const saveSettings = async (patch) => {
    setSavingSettings(true)
    const res = await authedFetch('/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    })
    setSavingSettings(false)
    if (!res.ok) {
      showToast("Couldn't save settings", 'error')
      return
    }
    setSettings(s => ({ ...s, ...patch }))
    showToast('Settings saved')
  }

  const exportUsersCsv = async () => {
    const token = await auth.currentUser.getIdToken()
    const res = await fetch(`${API}/admin/users/export`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) {
      showToast("Couldn't export users", 'error')
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `users-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    showToast('Export downloaded')
  }

  if (loading) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">Loading admin data…</p>
  }

  const signupData = analytics
    ? Object.entries(analytics.signupsByDay).sort().map(([day, count]) => ({ day: day.slice(5), count }))
    : []
  const purposeData = analytics
    ? Object.entries(analytics.purposeBreakdown).map(([name, value]) => ({ name, value }))
    : []
  const adoptionData = analytics
    ? Object.entries(analytics.featureAdoption).map(([name, value]) => ({ name, value }))
    : []

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition shrink-0 whitespace-nowrap ${
              tab === t.id
                ? 'bg-mint/10 text-navy dark:text-mint'
                : 'text-slate-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            {t.label}
            {t.id === 'support' && support.openCount > 0 && (
              <span className="ml-1.5 text-[10px] bg-mint text-navy px-1.5 py-0.5 rounded-full font-mono">
                {support.openCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'analytics' && analytics && (
        <>
          <Card title="Overview" description="Aggregate only — this view never reads anyone's transaction contents.">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Stat icon={Users} label="Total users" value={analytics.totalUsers} />
              <Stat icon={Activity} label="Active this week" value={analytics.activeThisWeek} />
              <Stat icon={Receipt} label="Transactions logged" value={analytics.totalTransactions} />
              <Stat icon={Receipt} label="Avg per user" value={analytics.avgTransactionsPerUser} />
            </div>
          </Card>

          {signupData.length > 0 && (
            <Card title="Signups — last 30 days">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={signupData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" />
                  <XAxis dataKey="day" fontSize={11} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                  <YAxis fontSize={11} allowDecimals={false} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                  <Tooltip />
                  <Bar dataKey="count" name="Signups" fill="#64ffda" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          )}

          <div className="flex flex-wrap gap-6">
            <Card title="Feature adoption" description="Users who have set up each feature.">
              <div className="min-w-[280px]">
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={adoptionData} layout="vertical" margin={{ left: 8 }}>
                    <XAxis type="number" fontSize={11} allowDecimals={false} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                    <YAxis dataKey="name" type="category" width={80} fontSize={11} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                    <Tooltip />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {adoptionData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            {purposeData.length > 0 && (
              <Card title="What people use it for">
                <div className="min-w-[240px] flex flex-col gap-2 pt-2">
                  {purposeData.map((p, i) => (
                    <div key={p.name} className="flex justify-between items-center text-sm">
                      <span className="capitalize text-navy dark:text-gray-200">{p.name}</span>
                      <span className="font-mono text-slate-500 dark:text-slate-400">{p.value}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </>
      )}

      {tab === 'users' && (
        <Card
          title="Accounts"
          description="Account metadata and activity counts. Transaction contents are only visible via an explicitly audited action."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-slate-500 dark:text-slate-400 text-xs">
                  <th className="pb-2 font-medium">User</th>
                  <th className="pb-2 font-medium">Purpose</th>
                  <th className="pb-2 font-medium">Activity</th>
                  <th className="pb-2 font-medium">Last sign-in</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.uid} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-2.5">
                      <span className="block text-navy dark:text-gray-200">{u.displayName || '—'}</span>
                      <span className="block text-xs text-slate-400">{u.email}</span>
                      {u.role === 'admin' && (
                        <span className="inline-block mt-0.5 text-[10px] bg-mint/20 text-mint px-1.5 py-0.5 rounded">admin</span>
                      )}
                      {u.orphaned && (
                        <span className="block text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
                          sign-in account deleted
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 capitalize text-slate-500 dark:text-slate-400">{u.purpose || '—'}</td>
                    <td className="py-2.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                      {u.transactionCount} tx · {u.savingsCount} savings
                    </td>
                    <td className="py-2.5 text-xs text-slate-500 dark:text-slate-400">
                      {u.lastSignIn ? new Date(u.lastSignIn).toLocaleDateString() : '—'}
                    </td>
                    <td className="py-2.5">
                      {u.orphaned
                        ? <span className="text-xs text-amber-600 dark:text-amber-400">No sign-in</span>
                        : u.disabled
                          ? <span className="text-xs text-red-500">Disabled</span>
                          : <span className="text-xs text-emerald-600 dark:text-emerald-400">Active</span>}
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      {u.orphaned ? (
                        // No Firebase Auth record, so reset/disable would
                        // just error. Only viewing leftover data or purging
                        // it makes sense here.
                        <>
                          <button onClick={() => viewTransactions(u)} className="text-xs text-amber-600 dark:text-amber-400 hover:underline mr-3">
                            View data
                          </button>
                          <button
                            onClick={() => purgeOrphaned(u)}
                            className="text-xs text-red-500 hover:underline"
                          >
                            Purge record
                          </button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => sendPasswordReset(u)} className="text-xs text-slate-400 hover:text-navy dark:hover:text-mint transition mr-3">
                            Reset link
                          </button>
                          <button onClick={() => viewTransactions(u)} className="text-xs text-amber-600 dark:text-amber-400 hover:underline mr-3">
                            View data
                          </button>
                          <button
                            onClick={() => changeRole(u, u.role === 'admin' ? 'user' : 'admin')}
                            className="text-xs text-slate-400 hover:text-navy dark:hover:text-mint transition mr-3"
                          >
                            {u.role === 'admin' ? 'Remove admin' : 'Make admin'}
                          </button>
                          {u.uid !== currentUid && (
                            <button
                              onClick={() => toggleDisabled(u)}
                              className={`text-xs transition ${u.disabled ? 'text-emerald-600 hover:underline' : 'text-red-500 hover:underline'}`}
                            >
                              {u.disabled ? 'Enable' : 'Disable'}
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'observability' && observability && (
        <>
          {/* Two providers, two completely different quota units — Groq caps
              tokens/day, OpenRouter caps requests/day. Showing them in one
              gauge made deep-analysis tokens count against the Groq budget,
              which read as nearly exhausted when Groq was barely touched. */}
          <Card
            title="Groq usage"
            description={`Categorization, chat, imports, nudges. Free tier resets daily. Today: ${(observability.aiUsage.groq?.todayTokens ?? 0).toLocaleString()} / ${observability.dailyTokenLimit.toLocaleString()} tokens.`}
          >
            {(() => {
              const used = observability.aiUsage.groq?.todayTokens ?? 0
              const pct = used / observability.dailyTokenLimit
              return (
                <div className="mb-4">
                  <div className="bg-gray-100 dark:bg-gray-800 rounded-full h-2.5 overflow-hidden">
                    <div
                      className={`h-full transition-all ${pct > 0.8 ? 'bg-red-500' : pct > 0.5 ? 'bg-amber-500' : 'bg-mint'}`}
                      style={{ width: `${Math.min(100, pct * 100)}%` }}
                    />
                  </div>
                  {(observability.aiUsage.groq?.failures ?? 0) > 0 && (
                    <p className="text-xs text-red-500 mt-2">
                      {observability.aiUsage.groq.failures} failed Groq call{observability.aiUsage.groq.failures === 1 ? '' : 's'} in the last 7 days
                      {' '}— check the error log below for rate limits.
                    </p>
                  )}
                </div>
              )
            })()}

            {Object.keys(observability.aiUsage.groq?.byFeature || {}).length > 0 && (
              <>
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Tokens by feature (7 days)</p>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart
                    data={Object.entries(observability.aiUsage.groq.byFeature).map(([name, value]) => ({ name: name.replace(/_/g, ' '), value }))}
                    layout="vertical"
                    margin={{ left: 8 }}
                  >
                    <XAxis type="number" fontSize={11} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                    <YAxis dataKey="name" type="category" width={120} fontSize={11} stroke="currentColor" className="text-slate-500 dark:text-slate-400" />
                    <Tooltip formatter={(v) => `${Number(v).toLocaleString()} tokens`} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {Object.keys(observability.aiUsage.groq.byFeature).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </>
            )}
          </Card>

          <Card
            title="Nemotron usage (deep analysis)"
            description={`Nemotron 3 Super via OpenRouter. The free tier limits requests per day, not tokens — and each analysis makes several as the agent loops.`}
          >
            {(() => {
              const or = observability.aiUsage.openrouter || { todayRequests: 0, todayTokens: 0, failures: 0 }
              const REQUEST_LIMIT = observability.dailyRequestLimit || 200
              const pct = or.todayRequests / REQUEST_LIMIT
              return (
                <>
                  <div className="flex flex-wrap gap-6 mb-3">
                    <div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Requests today</p>
                      <p className="text-lg font-mono font-semibold text-navy dark:text-gray-100">
                        {or.todayRequests} <span className="text-sm text-slate-400">/ {REQUEST_LIMIT}</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Tokens today</p>
                      <p className="text-lg font-mono font-semibold text-navy dark:text-gray-100">
                        {or.todayTokens.toLocaleString()}
                      </p>
                      <p className="text-[11px] text-slate-400">not metered — shown for scale</p>
                    </div>
                  </div>
                  <div className="bg-gray-100 dark:bg-gray-800 rounded-full h-2.5 overflow-hidden">
                    <div
                      className={`h-full transition-all ${pct > 0.8 ? 'bg-red-500' : pct > 0.5 ? 'bg-amber-500' : 'bg-mint'}`}
                      style={{ width: `${Math.min(100, pct * 100)}%` }}
                    />
                  </div>
                  {or.failures > 0 && (
                    <p className="text-xs text-red-500 mt-2">
                      {or.failures} failed analysis call{or.failures === 1 ? '' : 's'} in the last 7 days.
                    </p>
                  )}
                  {or.todayRequests === 0 && (
                    <p className="text-xs text-slate-400 mt-3">No deep analyses run today.</p>
                  )}
                </>
              )
            })()}
          </Card>

          <Card
            title="Categorization accuracy in production"
            description="How often users correct an AI-assigned category. Unlike the offline eval, these are real transaction descriptions."
          >
            {observability.accuracy.overrides === 0 ? (
              <p className="text-sm text-slate-400">No category corrections recorded in the last 30 days.</p>
            ) : (
              <>
                <p className="text-sm text-navy dark:text-gray-200 mb-3">
                  <span className="font-mono font-semibold">{observability.accuracy.overrides}</span> corrections in the last 30 days
                </p>
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Most common corrections</p>
                <div className="flex flex-col gap-1.5">
                  {observability.accuracy.byPair.map(p => (
                    <div key={p.pair} className="flex justify-between text-sm">
                      <span className="text-navy dark:text-gray-200">{p.pair}</span>
                      <span className="font-mono text-slate-500 dark:text-slate-400">{p.count}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>

          <Card title="Import funnel" description="Where people drop off between starting an import and confirming it.">
            {Object.keys(observability.funnels).length === 0 ? (
              <p className="text-sm text-slate-400">No import activity in the last 30 days.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {Object.entries(observability.funnels).map(([feature, steps]) => {
                  const started = steps.started || 0
                  const confirmed = steps.confirmed || 0
                  const rate = started > 0 ? Math.round((confirmed / started) * 100) : 0
                  return (
                    <div key={feature}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-navy dark:text-gray-200 capitalize">{feature.replace(/_/g, ' ')}</span>
                        <span className="font-mono text-slate-500 dark:text-slate-400">
                          {confirmed}/{started} completed ({rate}%)
                        </span>
                      </div>
                      <div className="bg-gray-100 dark:bg-gray-800 rounded-full h-2 overflow-hidden">
                        <div className="h-full bg-mint transition-all" style={{ width: `${rate}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>

          <Card title="Recent errors" description="Backend failures, newest first.">
            {observability.errors.length === 0 ? (
              <p className="text-sm text-slate-400">No errors recorded. </p>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                <div className="overflow-x-auto -mx-1 px-1">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-slate-500 dark:text-slate-400 text-xs">
                        <th className="pb-2 font-medium">When</th>
                        <th className="pb-2 font-medium">Feature</th>
                        <th className="pb-2 font-medium">Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {observability.errors.map(e => (
                        <tr key={e.id} className="border-b border-gray-100 dark:border-gray-800">
                          <td className="py-2 text-xs font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap align-top">
                            {new Date(e.at).toLocaleString()}
                          </td>
                          <td className="py-2 align-top">
                            <span className="text-xs bg-gray-100 dark:bg-gray-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded-full whitespace-nowrap">
                              {e.feature}
                            </span>
                          </td>
                          <td className="py-2 text-xs text-slate-500 dark:text-slate-400 break-all">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      {tab === 'settings' && settings && (
        <>
          <Card title="Broadcast message" description="Shown as a banner to every signed-in user. Leave empty to hide it.">
            <div className="flex flex-col gap-2 max-w-md">
              <input
                value={broadcastDraft}
                onChange={e => setBroadcastDraft(e.target.value)}
                placeholder="e.g. Scheduled maintenance Sunday 2-4am"
                maxLength={300}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => saveSettings({ broadcastMessage: broadcastDraft })}
                  disabled={savingSettings}
                  className="btn-primary"
                >
                  {savingSettings ? 'Saving…' : 'Set message'}
                </button>
                {settings.broadcastMessage && (
                  <button
                    onClick={() => { setBroadcastDraft(''); saveSettings({ broadcastMessage: '' }) }}
                    className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </Card>

          <Card title="Signups" description="Turn off to stop new accounts being created. Existing users are unaffected.">
            <label className="flex items-center justify-between max-w-md">
              <span className="text-sm text-navy dark:text-gray-200">
                {settings.signupsEnabled ? 'Signups are open' : 'Signups are closed'}
              </span>
              <input
                type="checkbox"
                checked={settings.signupsEnabled}
                onChange={e => saveSettings({ signupsEnabled: e.target.checked })}
                className="w-4 h-4 accent-mint"
              />
            </label>
          </Card>

          <Card title="Export" description="All accounts as CSV — metadata and counts only, no transaction contents.">
            <button
              onClick={exportUsersCsv}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
            >
              Download users CSV
            </button>
          </Card>
        </>
      )}

      {tab === 'support' && (
        <Card
          title="Support tickets"
          description="Questions sent from the Help page. There's no email layer yet — replying means emailing them yourself."
        >
          {support.tickets.length === 0 ? (
            <p className="text-sm text-slate-400">No tickets yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {support.tickets.map(t => (
                <div
                  key={t.id}
                  className={`rounded-lg border p-4 ${
                    t.status === 'resolved'
                      ? 'border-gray-200 dark:border-gray-800 opacity-60'
                      : 'border-gray-200 dark:border-gray-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <p className="text-sm font-medium text-navy dark:text-gray-100">{t.subject}</p>
                    <button
                      onClick={() => setTicketStatus(t, t.status === 'resolved' ? 'open' : 'resolved')}
                      className={`text-xs px-2.5 py-1 rounded-md border shrink-0 transition ${
                        t.status === 'resolved'
                          ? 'border-gray-300 dark:border-gray-700 text-slate-500 hover:bg-gray-50 dark:hover:bg-gray-800'
                          : 'border-mint text-mint hover:bg-mint/10'
                      }`}
                    >
                      {t.status === 'resolved' ? 'Reopen' : 'Mark resolved'}
                    </button>
                  </div>

                  <p className="text-xs text-slate-400 mb-2">
                    {t.fromName || 'Unknown'} · {t.fromEmail || 'no email'} ·{' '}
                    {new Date(t.createdAt).toLocaleString()}
                  </p>

                  <p className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">
                    {t.message}
                  </p>

                  {t.context && (
                    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                      <p className="text-[11px] text-slate-400 font-mono leading-relaxed">
                        {t.context.lastTab && <>tab: {t.context.lastTab} · </>}
                        {t.context.viewport && <>viewport: {t.context.viewport}</>}
                        {t.context.userAgent && (
                          <><br />{t.context.userAgent}</>
                        )}
                      </p>
                    </div>
                  )}

                  {t.fromEmail && t.status !== 'resolved' && (
                    <a
                      href={`mailto:${t.fromEmail}?subject=Re: ${encodeURIComponent(t.subject)}`}
                      className="inline-block mt-3 text-xs text-mint hover:underline"
                    >
                      Reply by email →
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'audit' && (
        <Card
          title="Admin audit log"
          description="Every privileged action against a user account, newest first."
        >
          {auditLog.length === 0 ? (
            <p className="text-sm text-slate-400">No privileged actions recorded yet.</p>
          ) : (
            <div className="overflow-x-auto -mx-1 px-1">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-slate-500 dark:text-slate-400 text-xs">
                    <th className="pb-2 font-medium">When</th>
                    <th className="pb-2 font-medium">Admin</th>
                    <th className="pb-2 font-medium">Action</th>
                    <th className="pb-2 font-medium">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLog.map(e => (
                    <tr key={e.id} className="border-b border-gray-100 dark:border-gray-800">
                      <td className="py-2 text-xs font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {new Date(e.at).toLocaleString()}
                      </td>
                      <td className="py-2 text-xs text-navy dark:text-gray-200">{e.adminEmail}</td>
                      <td className="py-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          e.action === 'view_transactions'
                            ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                            : 'bg-gray-100 dark:bg-gray-800 text-slate-600 dark:text-slate-300'
                        }`}>
                          {e.action.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="py-2 text-xs text-slate-500 dark:text-slate-400">{e.targetEmail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Privileged data view */}
      {viewingUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-semibold text-navy dark:text-gray-100">{viewingUser.email}</h3>
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5 flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3" /> This access has been recorded in the audit log
                  </p>
                </div>
                <button onClick={() => setViewingUser(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-gray-200">✕</button>
              </div>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              <div className="overflow-x-auto -mx-1 px-1">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-slate-500 dark:text-slate-400 text-xs">
                      <th className="pb-2 font-medium">Date</th>
                      <th className="pb-2 font-medium">Description</th>
                      <th className="pb-2 font-medium">Category</th>
                      <th className="pb-2 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewingUser.transactions.map(t => (
                      <tr key={t.id} className="border-b border-gray-100 dark:border-gray-800">
                        <td className="py-2 font-mono text-xs text-slate-500 dark:text-slate-400">{t.date}</td>
                        <td className="py-2 dark:text-gray-200">{t.description}</td>
                        <td className="py-2 text-xs text-slate-500 dark:text-slate-400">{t.category}</td>
                        <td className="py-2 font-mono dark:text-gray-200">${Number(t.amount).toFixed(2)}</td>
                      </tr>
                    ))}
                    {viewingUser.transactions.length === 0 && (
                      <tr><td colSpan={4} className="py-6 text-slate-400 text-sm">No transactions.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title}
        message={confirmState?.message}
        confirmLabel={confirmState?.confirmLabel}
        variant={confirmState?.variant}
        onConfirm={confirmState?.onConfirm}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  )
}
