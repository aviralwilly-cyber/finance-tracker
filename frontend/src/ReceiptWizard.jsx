import { useState } from 'react'
import { Camera, X } from 'lucide-react'
import { authedFetch, API } from './api'
import { auth } from './firebase'
import CategoryIcon from './CategoryIcon'

export default function ReceiptWizard({ categories, onClose, onImported }) {
  const [step, setStep] = useState('upload') // 'upload' | 'processing' | 'review'
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const [merchant, setMerchant] = useState(null)
  const [rows, setRows] = useState([]) // { key, date, description, amount, category, isDuplicate, selected }
  const [importing, setImporting] = useState(false)

  const handleFileChange = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setPreview(URL.createObjectURL(f))
  }

  const extract = async () => {
    if (!file) return
    setError('')
    setStep('processing')

    const token = await auth.currentUser.getIdToken()
    const formData = new FormData()
    formData.append('receipt', file)

    const res = await fetch(`${API}/transactions/receipt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // no Content-Type — browser sets multipart boundary
      body: formData
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Something went wrong reading that receipt.')
      setStep('upload')
      return
    }

    const data = await res.json()
    setMerchant(data.merchant)
    setRows(
      data.transactions.map((t, i) => ({
        key: i,
        ...t,
        selected: !t.isDuplicate
      }))
    )
    setStep('review')
  }

  const toggleRow = (key) => {
    setRows(rows.map(r => (r.key === key ? { ...r, selected: !r.selected } : r)))
  }

  const updateCategory = (key, category) => {
    setRows(rows.map(r => (r.key === key ? { ...r, category } : r)))
  }

  const selectAll = (value) => {
    setRows(rows.map(r => ({ ...r, selected: value })))
  }

  const confirmImport = async () => {
    const selected = rows.filter(r => r.selected)
    if (selected.length === 0) return
    setImporting(true)
    // Reuses the exact same confirm endpoint the PDF import wizard uses —
    // it's just "bulk-insert these reviewed transactions," regardless of
    // where they came from.
    const res = await authedFetch('/transactions/import-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: selected })
    })
    const data = await res.json()
    setImporting(false)
    onImported(data.created)
  }

  const total = rows.filter(r => r.selected).reduce((sum, r) => sum + r.amount, 0)
  const selectedCount = rows.filter(r => r.selected).length

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-navy dark:text-gray-100">Scan a receipt</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-gray-200 transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          {step === 'upload' && (
            <div className="flex flex-col items-center gap-4 py-8">
              {preview ? (
                <img src={preview} alt="Receipt preview" className="max-h-52 rounded-lg border border-gray-200 dark:border-gray-700 object-contain" />
              ) : (
                <Camera className="w-10 h-10 text-slate-400" />
              )}
              <p className="text-sm text-slate-500 dark:text-slate-400 text-center max-w-sm">
                Upload a photo of a receipt. AI will read the items and categorize them —
                nothing gets saved until you review and confirm.
              </p>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFileChange}
                className="text-sm text-slate-600 dark:text-slate-300"
              />
              {error && <p className="text-sm text-red-500 text-center">{error}</p>}
              <button onClick={extract} disabled={!file} className="btn-primary disabled:opacity-40">
                Read receipt
              </button>
            </div>
          )}

          {step === 'processing' && (
            <div className="flex flex-col items-center gap-3 py-16">
              <div className="w-8 h-8 border-2 border-mint border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-slate-500 dark:text-slate-400">Reading items and categorizing…</p>
            </div>
          )}

          {step === 'review' && (
            <div className="flex flex-col gap-3">
              {merchant && (
                <p className="text-sm text-navy dark:text-gray-200 font-medium">{merchant}</p>
              )}
              <div className="flex justify-between items-center text-xs text-slate-500 dark:text-slate-400">
                <span>{rows.length} item{rows.length === 1 ? '' : 's'} found · {selectedCount} selected · ${total.toFixed(2)}</span>
                <span className="flex gap-3">
                  <button onClick={() => selectAll(true)} className="hover:text-navy dark:hover:text-mint transition">Select all</button>
                  <button onClick={() => selectAll(false)} className="hover:text-navy dark:hover:text-mint transition">Deselect all</button>
                </span>
              </div>

              <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left bg-gray-50 dark:bg-gray-800 text-slate-500 dark:text-slate-400 text-xs">
                      <th className="px-3 py-2 w-8"></th>
                      <th className="px-2 py-2 font-medium">Item</th>
                      <th className="px-2 py-2 font-medium">Amount</th>
                      <th className="px-2 py-2 font-medium">Category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.key} className={`border-t border-gray-100 dark:border-gray-800 ${r.isDuplicate ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}`}>
                        <td className="px-3 py-1.5">
                          <input type="checkbox" checked={r.selected} onChange={() => toggleRow(r.key)} />
                        </td>
                        <td className="px-2 py-1.5 dark:text-gray-200">
                          {r.description}
                          {r.isDuplicate && <span className="ml-2 text-[10px] text-amber-600 dark:text-amber-400">possible duplicate</span>}
                        </td>
                        <td className="px-2 py-1.5 font-mono dark:text-gray-200 whitespace-nowrap">${r.amount.toFixed(2)}</td>
                        <td className="px-2 py-1.5">
                          <select
                            value={r.category}
                            onChange={e => updateCategory(r.key, e.target.value)}
                            className="text-xs rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-1.5 py-1"
                          >
                            {categories.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-slate-400">
                Tip: uncheck items you'd rather log separately by category, or leave them as one
                combined purchase — whatever's checked gets imported as-is.
              </p>
            </div>
          )}
        </div>

        {step === 'review' && (
          <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200 dark:border-gray-800">
            <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition">
              Cancel
            </button>
            <button onClick={confirmImport} disabled={selectedCount === 0 || importing} className="btn-primary disabled:opacity-40">
              {importing ? 'Importing…' : `Import ${selectedCount} item${selectedCount === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
