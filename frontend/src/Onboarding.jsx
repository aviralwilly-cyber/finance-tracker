import { useState } from 'react'
import { authedFetch } from './api'

const PURPOSES = [
  { value: 'self', label: 'Personal use', blurb: 'Track my own everyday spending' },
  { value: 'business', label: 'Business', blurb: 'Track business expenses (office, clients, travel)' },
  { value: 'other', label: 'Something else', blurb: 'A general set of categories' }
]

export default function Onboarding({ onComplete }) {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('self')
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    const res = await authedFetch('/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name.trim(), purpose })
    })
    const profile = await res.json()
    setSaving(false)
    onComplete(profile)
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg border border-gray-200 p-8">
        <h1 className="text-2xl font-bold text-navy mb-1">💰 Welcome</h1>
        <p className="text-slate-500 text-sm mb-6">A couple of quick questions to set things up.</p>

        <form onSubmit={submit} className="flex flex-col gap-6">
          <div>
            <label className="block text-sm font-medium text-navy mb-1.5">What should we call you?</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Your name"
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-navy mb-1.5">What will you use this for?</label>
            <div className="flex flex-col gap-2">
              {PURPOSES.map(p => (
                <label
                  key={p.value}
                  className={`flex items-start gap-3 border rounded-lg px-3 py-2.5 cursor-pointer transition ${
                    purpose === p.value ? 'border-mint bg-mint/10' : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="purpose"
                    value={p.value}
                    checked={purpose === p.value}
                    onChange={() => setPurpose(p.value)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-medium text-navy">{p.label}</span>
                    <span className="block text-xs text-slate-500">{p.blurb}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <button type="submit" disabled={saving} className="btn-primary w-full">
            {saving ? 'Setting up…' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  )
}
