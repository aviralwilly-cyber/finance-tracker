// Defaults to a destructive "Delete" confirm, since that's the most common
// use — but the label and colour are overridable. A red "Delete" button on
// a non-destructive action (e.g. "view this data") is genuinely misleading,
// so anything that isn't a deletion should pass its own confirmLabel.
export default function ConfirmDialog({
  open,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Delete',
  variant = 'danger', // 'danger' | 'primary'
  onConfirm,
  onCancel
}) {
  if (!open) return null

  const confirmClass = variant === 'danger'
    ? 'bg-red-500 hover:bg-red-600 text-white'
    : 'bg-mint hover:brightness-95 text-navy'

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-sm w-full p-6">
        <h3 className="font-semibold text-navy dark:text-gray-100 text-lg mb-2">{title}</h3>
        {message && <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">{message}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
