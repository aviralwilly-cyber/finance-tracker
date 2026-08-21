import { useState, useCallback } from 'react'

let nextId = 1

export function useToasts() {
  const [toasts, setToasts] = useState([])

  const showToast = useCallback((message, type = 'success') => {
    const id = nextId++
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => {
      setToasts(t => t.filter(toast => toast.id !== id))
    }, 3000)
  }, [])

  return { toasts, showToast }
}

export function ToastContainer({ toasts }) {
  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`px-4 py-2.5 rounded-lg shadow-lg text-sm text-white animate-[fadeIn_0.2s_ease-out] ${
            t.type === 'error' ? 'bg-red-500' : 'bg-navy'
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
