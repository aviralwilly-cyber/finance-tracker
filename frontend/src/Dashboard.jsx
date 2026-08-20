import { useEffect, useState } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { signOut } from 'firebase/auth'
import { auth } from './firebase'

const API = 'http://localhost:8080/api'
const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#64748b']

// Attaches the current user's Firebase ID token to every request, so the
// backend can verify who's asking and scope data to that user only.
async function authedFetch(path, options = {}) {
  const token = await auth.currentUser.getIdToken()
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`
    }
  })
}

export default function Dashboard({ user }) {
  const [transactions, setTransactions] = useState([])
  const [summary, setSummary] = useState({})
  const [form, setForm] = useState({ description: '', amount: '', date: '' })
  const [loading, setLoading] = useState(false)
  const [question, setQuestion] = useState('')
  const [chatLog, setChatLog] = useState([])
  const [asking, setAsking] = useState(false)

  const loadData = async () => {
    const [txRes, sumRes] = await Promise.all([
      authedFetch('/transactions'),
      authedFetch('/transactions/summary')
    ])
    setTransactions(await txRes.json())
    setSummary(await sumRes.json())
  }

  useEffect(() => { loadData() }, [])

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
  }

  const deleteTransaction = async (id) => {
    await authedFetch(`/transactions/${id}`, { method: 'DELETE' })
    await loadData()
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

  const chartData = Object.entries(summary).map(([name, value]) => ({ name, value }))

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>💰 AI Finance Tracker</h1>
          <p style={{ color: '#666', marginTop: 0 }}>Add a transaction and AI will categorize it automatically.</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p style={{ color: '#666', fontSize: 13, margin: '4px 0' }}>{user.email}</p>
          <button onClick={() => signOut(auth)} style={{ padding: '4px 10px', fontSize: 13, background: 'transparent', color: '#111', border: '1px solid #ccc' }}>
            Log out
          </button>
        </div>
      </div>

      <form onSubmit={addTransaction} style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        <input
          placeholder="Description (e.g. Starbucks)"
          value={form.description}
          onChange={e => setForm({ ...form, description: e.target.value })}
          style={{ flex: 2, padding: 8, minWidth: 160 }}
        />
        <input
          placeholder="Amount"
          type="number"
          step="0.01"
          value={form.amount}
          onChange={e => setForm({ ...form, amount: e.target.value })}
          style={{ flex: 1, padding: 8, minWidth: 100 }}
        />
        <input
          type="date"
          value={form.date}
          onChange={e => setForm({ ...form, date: e.target.value })}
          style={{ flex: 1, padding: 8, minWidth: 140 }}
        />
        <button type="submit" disabled={loading} style={{ padding: '8px 16px' }}>
          {loading ? 'Categorizing…' : 'Add'}
        </button>
      </form>

      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 300 }}>
          <h3>Transactions</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                <th>Date</th><th>Description</th><th>Category</th><th>Amount</th><th></th>
              </tr>
            </thead>
            <tbody>
              {transactions.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td>{t.date}</td>
                  <td>{t.description}</td>
                  <td><span style={{ background: '#eee', padding: '2px 8px', borderRadius: 12, fontSize: 12 }}>{t.category}</span></td>
                  <td>${Number(t.amount).toFixed(2)}</td>
                  <td><button onClick={() => deleteTransaction(t.id)} style={{ color: 'red', border: 'none', background: 'none', cursor: 'pointer' }}>✕</button></td>
                </tr>
              ))}
              {transactions.length === 0 && <tr><td colSpan={5} style={{ color: '#999', padding: 12 }}>No transactions yet — add one above.</td></tr>}
            </tbody>
          </table>
        </div>

        <div style={{ flex: 1, minWidth: 300 }}>
          <h3>Spending by Category</h3>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={chartData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
                  {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : <p style={{ color: '#999' }}>Add transactions to see your breakdown.</p>}
        </div>
      </div>

      <div style={{ marginTop: 32 }}>
        <h3>Ask about your spending</h3>
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, minHeight: 80, marginBottom: 8 }}>
          {chatLog.length === 0 && <p style={{ color: '#999', margin: 0 }}>Try: "How much did I spend on dining this month?"</p>}
          {chatLog.map((m, i) => (
            <p key={i} style={{ margin: '6px 0' }}>
              <strong>{m.role === 'user' ? 'You: ' : 'AI: '}</strong>{m.text}
            </p>
          ))}
        </div>
        <form onSubmit={askAi} style={{ display: 'flex', gap: 8 }}>
          <input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="Ask a question about your finances…"
            style={{ flex: 1, padding: 8 }}
          />
          <button type="submit" disabled={asking} style={{ padding: '8px 16px' }}>
            {asking ? 'Thinking…' : 'Ask'}
          </button>
        </form>
      </div>
    </div>
  )
}
