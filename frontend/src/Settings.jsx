import { useState } from 'react'
import { Reorder } from 'framer-motion'
import { GripVertical, RotateCcw } from 'lucide-react'
import {
  updatePassword,
  updateEmail,
  reauthenticateWithCredential,
  EmailAuthProvider,
  deleteUser
} from 'firebase/auth'
import { auth } from './firebase'
import { authedFetch } from './api'
import ConfirmDialog from './ConfirmDialog'

const PRESET_AVATARS = [
  '/avatars/1.jpg',
  '/avatars/2.jpg',
  '/avatars/3.jpg',
  '/avatars/4.jpg',
  '/avatars/5.jpg',
  '/avatars/6.jpg',
  '/avatars/7.jpg',
  '/avatars/8.jpg',
  '/avatars/9.jpg',
  '/avatars/10.jpg',
]

function SettingsCard({ title, description, children }) {
  return (
    <div className="bg-white/85 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5">
      <h3 className="font-semibold text-navy dark:text-gray-100 mb-1">{title}</h3>
      {description && <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{description}</p>}
      <div className={description ? '' : 'mt-4'}>{children}</div>
    </div>
  )
}

const inputClass = 'w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint focus:border-mint'
const btnPrimary = 'btn-primary disabled:opacity-60'
const btnDanger = 'px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition disabled:opacity-60'

export default function Settings({ user, profile, setProfile, showToast, categories, onCategoriesChanged, baseTabs, onTabsChanged }) {
  // --- Profile & identity ---
  const [displayName, setDisplayName] = useState(profile?.displayName || '')
  const [purpose, setPurpose] = useState(profile?.purpose || 'self')
  const [phoneNumber, setPhoneNumber] = useState(profile?.phoneNumber || '')
  const [savingProfile, setSavingProfile] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)

  // Resizes/compresses an image entirely in the browser, then stores it as
  // a small embedded data URL directly on the Firestore profile doc — no
  // Firebase Storage needed (which now requires the paid Blaze plan). A
  // 160x160 JPEG at moderate quality comes out to a few tens of KB, well
  // under Firestore's 1MB-per-document limit.
  const resizeImage = (file) => new Promise((resolve, reject) => {
    const img = new Image()
    const reader = new FileReader()
    reader.onload = () => { img.src = reader.result }
    reader.onerror = reject
    img.onload = () => {
      const size = 160
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      // Cover-crop to a square so the avatar isn't squished.
      const scale = Math.max(size / img.width, size / img.height)
      const w = img.width * scale
      const h = img.height * scale
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.7))
    }
    img.onerror = reject
    reader.readAsDataURL(file)
  })

  const photoGallery = profile?.photoGallery || []

  const addToGallery = async (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return

    const remainingSlots = 10 - photoGallery.length
    if (remainingSlots <= 0) {
      showToast('Your gallery is full (10 max) — remove one first', 'error')
      e.target.value = ''
      return
    }
    const toProcess = files.slice(0, remainingSlots)
    if (files.length > remainingSlots) {
      showToast(`Only ${remainingSlots} slot(s) left — added the first ${remainingSlots}`, 'error')
    }

    setUploadingPhoto(true)
    try {
      for (const file of toProcess) {
        if (!file.type.startsWith('image/')) continue
        if (file.size > 8 * 1024 * 1024) continue

        const dataUrl = await resizeImage(file)
        const res = await authedFetch('/profile/gallery', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photoURL: dataUrl })
        })
        const updatedGallery = await res.json()
        setProfile(p => ({ ...p, photoGallery: updatedGallery }))
      }
      showToast('Added to your gallery')
    } catch (err) {
      showToast('Upload failed — ' + err.message, 'error')
    } finally {
      setUploadingPhoto(false)
      e.target.value = ''
    }
  }

  const selectFromGallery = async (dataUrl) => {
    const res = await authedFetch('/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, purpose, phoneNumber, budgetNudgeThreshold, photoURL: dataUrl, avatarEmoji: null })
    })
    const updated = await res.json()
    setProfile(p => ({ ...p, ...updated }))
    showToast('Avatar updated')
  }

  const removeFromGallery = async (index) => {
    const res = await authedFetch(`/profile/gallery/${index}`, { method: 'DELETE' })
    const updated = await res.json()
    setProfile(p => ({ ...p, ...updated }))
    showToast('Removed from gallery')
  }

  // --- Emoji avatar (free alternative to uploading a photo) ---
  const EMOJI_AVATARS = ['🐻', '🐱', '🐶', '🐼', '🦊', '🦁', '🐯', '🐨', '🐰', '🐸', '🦄', '🐷', '🐵', '🐔', '🦉', '🐧', '🦆', '🐢', '🦋', '🐝', '🦖', '🐳', '🌟', '⚡']
  const [savingEmoji, setSavingEmoji] = useState(false)

  const selectEmoji = async (emoji) => {
    setSavingEmoji(true)
    const res = await authedFetch('/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, purpose, phoneNumber, budgetNudgeThreshold, avatarEmoji: emoji, photoURL: null })
    })
    const updated = await res.json()
    setProfile(p => ({ ...p, ...updated }))
    setSavingEmoji(false)
    showToast('Avatar updated')
  }

  // --- Financial preferences ---
  const [budgetNudgeThreshold, setBudgetNudgeThreshold] = useState(profile?.budgetNudgeThreshold ?? 80)
  const [newCategory, setNewCategory] = useState('')
  const [savingCategory, setSavingCategory] = useState(false)
  const customCategories = profile?.customCategories || []

  const addCategory = async (e) => {
    e.preventDefault()
    if (!newCategory.trim()) return
    setSavingCategory(true)
    const res = await authedFetch('/categories/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: newCategory.trim() })
    })
    setSavingCategory(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || "Couldn't add that category", 'error')
      return
    }
    const updated = await res.json()
    setProfile(p => ({ ...p, customCategories: updated }))
    setNewCategory('')
    showToast('Category added')
    onCategoriesChanged?.()
  }

  const removeCategory = async (category) => {
    const res = await authedFetch(`/categories/custom/${encodeURIComponent(category)}`, { method: 'DELETE' })
    const updated = await res.json()
    setProfile(p => ({ ...p, customCategories: updated }))
    showToast('Category removed')
    onCategoriesChanged?.()
  }

  const saveProfile = async (e) => {
    e.preventDefault()
    if (!displayName.trim()) return
    setSavingProfile(true)
    const res = await authedFetch('/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, purpose, phoneNumber, budgetNudgeThreshold })
    })
    const updated = await res.json()
    setProfile(p => ({ ...p, ...updated }))
    setSavingProfile(false)
    showToast('Profile updated')
    // Purpose changes which category set applies (Personal/Business/Other) —
    // refresh so dropdowns elsewhere in the app pick up the new list.
    onCategoriesChanged?.()
  }

  // --- Account & security ---
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordMsg, setPasswordMsg] = useState('')

  const [newEmail, setNewEmail] = useState('')
  const [emailPassword, setEmailPassword] = useState('')
  const [changingEmail, setChangingEmail] = useState(false)
  const [emailMsg, setEmailMsg] = useState('')

  const [exporting, setExporting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deletingAccount, setDeletingAccount] = useState(false)

  const reauth = async (password) => {
    const credential = EmailAuthProvider.credential(user.email, password)
    await reauthenticateWithCredential(auth.currentUser, credential)
  }

  const changePassword = async (e) => {
    e.preventDefault()
    setPasswordMsg('')
    if (newPassword.length < 6) {
      setPasswordMsg('New password must be at least 6 characters.')
      return
    }
    setChangingPassword(true)
    try {
      await reauth(currentPassword)
      await updatePassword(auth.currentUser, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      showToast('Password changed')
    } catch (err) {
      setPasswordMsg(err.message.replace('Firebase: ', ''))
    } finally {
      setChangingPassword(false)
    }
  }

  const changeEmail = async (e) => {
    e.preventDefault()
    setEmailMsg('')
    if (!newEmail.trim()) return
    setChangingEmail(true)
    try {
      await reauth(emailPassword)
      await updateEmail(auth.currentUser, newEmail.trim())
      setNewEmail('')
      setEmailPassword('')
      showToast('Email updated — you may need to log in again')
    } catch (err) {
      setEmailMsg(err.message.replace('Firebase: ', ''))
    } finally {
      setChangingEmail(false)
    }
  }

  const exportData = async () => {
    setExporting(true)
    const res = await authedFetch('/export')
    const data = await res.json()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `finance-tracker-export-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setExporting(false)
    showToast('Export downloaded')
  }

  const deleteAccount = async () => {
    setDeletingAccount(true)
    try {
      await authedFetch('/account', { method: 'DELETE' })
      await deleteUser(auth.currentUser)
      // onAuthStateChanged in App.jsx will pick up the sign-out automatically
    } catch (err) {
      showToast(err.message.replace('Firebase: ', ''), 'error')
      setDeletingAccount(false)
      setConfirmDelete(false)
    }
  }

  // --- App preferences ---
  const [backgroundEnabled, setBackgroundEnabled] = useState(() => localStorage.getItem('backgroundEnabled') !== 'false')
  const [defaultTab, setDefaultTab] = useState(() => localStorage.getItem('defaultTab') || 'overview')
  const [perPage, setPerPage] = useState(() => Number(localStorage.getItem('transactionsPerPage')) || 10)

  const savePreferences = () => {
    localStorage.setItem('backgroundEnabled', backgroundEnabled)
    localStorage.setItem('defaultTab', defaultTab)
    localStorage.setItem('transactionsPerPage', perPage)
    showToast('Preferences saved — refresh to see background changes')
  }

  // --- Navigation customization ---
  const buildNavList = () => {
    const byId = Object.fromEntries((baseTabs || []).map(t => [t.id, t]))
    let order = (baseTabs || []).map(t => t.id)
    let labels = {}
    try {
      const savedOrder = JSON.parse(localStorage.getItem('tabOrder') || 'null')
      if (Array.isArray(savedOrder)) order = savedOrder.filter(id => byId[id])
      const savedLabels = JSON.parse(localStorage.getItem('tabLabels') || 'null')
      if (savedLabels && typeof savedLabels === 'object') labels = savedLabels
    } catch {
      // ignore malformed localStorage, fall back to defaults
    }
    const missing = (baseTabs || []).map(t => t.id).filter(id => !order.includes(id))
    return [...order, ...missing].map(id => ({ id, label: labels[id] || byId[id].label, icon: byId[id].icon }))
  }

  const [navItems, setNavItems] = useState(buildNavList)

  const renameNavItem = (id, newLabel) => {
    setNavItems(items => items.map(item => (item.id === id ? { ...item, label: newLabel } : item)))
  }

  const saveNavigation = () => {
    localStorage.setItem('tabOrder', JSON.stringify(navItems.map(t => t.id)))
    localStorage.setItem('tabLabels', JSON.stringify(Object.fromEntries(navItems.map(t => [t.id, t.label]))))
    onTabsChanged?.()
    showToast('Navigation updated')
  }

  const resetNavigation = () => {
    const defaults = (baseTabs || []).map(t => ({ ...t }))
    setNavItems(defaults)
    localStorage.removeItem('tabOrder')
    localStorage.removeItem('tabLabels')
    onTabsChanged?.()
    showToast('Navigation reset to default')
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsCard title="Profile & identity" description="Your name, how the app is set up for you, and contact info.">
        <div className="flex items-center gap-4 mb-4">
          {profile?.photoURL ? (
            <img src={profile.photoURL} alt="Profile" className="w-16 h-16 rounded-full object-cover border border-gray-200 dark:border-gray-700" />
          ) : profile?.avatarEmoji ? (
            <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-3xl">
              {profile.avatarEmoji}
            </div>
          ) : (
            <div className="w-16 h-16 rounded-full bg-navy dark:bg-mint text-white dark:text-navy flex items-center justify-center text-xl font-semibold">
              {(displayName || user.email || '?').charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <label className="inline-block px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition cursor-pointer">
              {uploadingPhoto ? 'Uploading…' : 'Add photos to gallery'}
              <input type="file" accept="image/*" multiple onChange={addToGallery} disabled={uploadingPhoto} className="hidden" />
            </label>
            <p className="text-xs text-slate-400 mt-1">Up to 10 images, resized automatically. Pick your active one below.</p>
          </div>
        </div>

        {/* added-aw */}
        <div className="mb-5">
  <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Pick a preset avatar</p>
  <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
    {PRESET_AVATARS.map(src => (
      <button
        key={src}
        onClick={() => selectFromGallery(src)}
        title="Use this as your avatar"
        className={`shrink-0 w-14 h-14 rounded-full overflow-hidden transition ${
          profile?.photoURL === src ? 'ring-2 ring-mint' : 'ring-1 ring-gray-200 dark:ring-gray-700 hover:ring-mint/50'
        }`}
      >
        <img src={src} alt="" className="w-full h-full object-cover" />
      </button>
    ))}
  </div>
</div>




        {photoGallery.length > 0 && (
          <div className="mb-5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Your gallery ({photoGallery.length}/10)</p>
            <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
              {photoGallery.map((img, i) => (
                <div key={i} className="relative shrink-0 group">
                  <button
                    onClick={() => selectFromGallery(img)}
                    title="Use this as your avatar"
                    className={`w-14 h-14 rounded-full overflow-hidden transition ${
                      profile?.photoURL === img ? 'ring-2 ring-mint' : 'ring-1 ring-gray-200 dark:ring-gray-700 hover:ring-mint/50'
                    }`}
                  >
                    <img src={img} alt="" className="w-full h-full object-cover" />
                  </button>
                  <button
                    onClick={() => removeFromGallery(i)}
                    title="Remove from gallery"
                    className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">…or pick an emoji avatar</p>
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
            {EMOJI_AVATARS.map(emoji => (
              <button
                key={emoji}
                onClick={() => selectEmoji(emoji)}
                disabled={savingEmoji}
                title={`Use ${emoji} as your avatar`}
                className={`shrink-0 w-11 h-11 rounded-full flex items-center justify-center text-xl transition ${
                  profile?.avatarEmoji === emoji && !profile?.photoURL
                    ? 'bg-mint/20 ring-2 ring-mint'
                    : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={saveProfile} className="flex flex-col gap-3 max-w-md">
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Display name</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputClass} required />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">What you use this for</label>
            <select value={purpose} onChange={e => setPurpose(e.target.value)} className={inputClass}>
              <option value="self">Personal use</option>
              <option value="business">Business</option>
              <option value="other">Something else</option>
            </select>
            <p className="text-xs text-slate-400 mt-1">Changes which categories are available.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Phone number (optional)</label>
            <input value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder="Not verified — stored for reference only" className={inputClass} />
          </div>
          <button type="submit" disabled={savingProfile} className={`${btnPrimary} self-start`}>
            {savingProfile ? 'Saving…' : 'Save profile'}
          </button>
        </form>
      </SettingsCard>

      <SettingsCard title="Financial preferences" description="Tune how the app nudges you about spending.">
        <div className="max-w-md flex flex-col gap-2">
          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
            Budget nudge threshold: <span className="text-navy dark:text-mint font-mono">{budgetNudgeThreshold}%</span>
          </label>
          <input
            type="range"
            min="50"
            max="100"
            value={budgetNudgeThreshold}
            onChange={e => setBudgetNudgeThreshold(Number(e.target.value))}
            className="w-full accent-mint"
          />
          <p className="text-xs text-slate-400">You'll get an AI nudge once a category's spending crosses this percentage of its budget.</p>
          <button onClick={saveProfile} className={`${btnPrimary} self-start mt-2`}>Save</button>
        </div>

        <div className="max-w-md mt-6 pt-6 border-t border-gray-100 dark:border-gray-800">
          <h4 className="text-sm font-medium text-navy dark:text-gray-200 mb-1">Custom categories</h4>
          <p className="text-xs text-slate-400 mb-3">Add extra categories on top of your {purpose === 'self' ? 'personal' : purpose === 'business' ? 'business' : 'default'} set — the presets stay available too.</p>

          <form onSubmit={addCategory} className="flex gap-2 mb-3">
            <input
              value={newCategory}
              onChange={e => setNewCategory(e.target.value)}
              placeholder="e.g. Pet Care"
              className={inputClass}
            />
            <button type="submit" disabled={savingCategory} className={`${btnPrimary} shrink-0`}>
              {savingCategory ? 'Adding…' : 'Add'}
            </button>
          </form>

          {customCategories.length === 0 ? (
            <p className="text-xs text-slate-400">No custom categories yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {customCategories.map(c => (
                <span key={c} className="inline-flex items-center gap-1.5 bg-gray-100 dark:bg-gray-800 text-navy dark:text-gray-200 text-xs px-2.5 py-1 rounded-full">
                  {c}
                  <button onClick={() => removeCategory(c)} className="text-slate-400 hover:text-red-500 transition">✕</button>
                </span>
              ))}
            </div>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title="Account & security">
        <div className="flex flex-col gap-6">
          <form onSubmit={changePassword} className="max-w-md flex flex-col gap-2">
            <h4 className="text-sm font-medium text-navy dark:text-gray-200">Change password</h4>
            <input type="password" placeholder="Current password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required className={inputClass} />
            <input type="password" placeholder="New password (6+ characters)" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={6} className={inputClass} />
            {passwordMsg && <p className="text-xs text-red-500">{passwordMsg}</p>}
            <button type="submit" disabled={changingPassword} className={`${btnPrimary} self-start`}>
              {changingPassword ? 'Updating…' : 'Update password'}
            </button>
          </form>

          <form onSubmit={changeEmail} className="max-w-md flex flex-col gap-2 pt-4 border-t border-gray-100 dark:border-gray-800">
            <h4 className="text-sm font-medium text-navy dark:text-gray-200">Change email</h4>
            <p className="text-xs text-slate-400">Current: {user.email}</p>
            <input type="email" placeholder="New email" value={newEmail} onChange={e => setNewEmail(e.target.value)} required className={inputClass} />
            <input type="password" placeholder="Current password (to confirm)" value={emailPassword} onChange={e => setEmailPassword(e.target.value)} required className={inputClass} />
            {emailMsg && <p className="text-xs text-red-500">{emailMsg}</p>}
            <button type="submit" disabled={changingEmail} className={`${btnPrimary} self-start`}>
              {changingEmail ? 'Updating…' : 'Update email'}
            </button>
          </form>

          <div className="pt-4 border-t border-gray-100 dark:border-gray-800">
            <h4 className="text-sm font-medium text-navy dark:text-gray-200 mb-2">Export your data</h4>
            <p className="text-xs text-slate-400 mb-2">Download everything you've logged — transactions, income, savings, budgets — as a JSON file.</p>
            <button onClick={exportData} disabled={exporting} className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition disabled:opacity-60">
              {exporting ? 'Preparing…' : 'Download export'}
            </button>
          </div>

          <div className="pt-4 border-t border-gray-100 dark:border-gray-800">
            <h4 className="text-sm font-medium text-red-500 mb-2">Delete account</h4>
            <p className="text-xs text-slate-400 mb-2">Permanently deletes your account and all data. This can't be undone.</p>
            <button onClick={() => setConfirmDelete(true)} className={btnDanger}>Delete my account</button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Navigation" description="Drag to reorder your sidebar tabs, or rename any of them.">
        <Reorder.Group axis="y" values={navItems} onReorder={setNavItems} className="flex flex-col gap-2 max-w-md">
          {navItems.map(item => (
            <Reorder.Item
              key={item.id}
              value={item}
              className="flex items-center gap-3 bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 cursor-grab active:cursor-grabbing"
            >
              <GripVertical className="w-4 h-4 text-slate-400 shrink-0" />
              {item.icon && <item.icon className="w-4 h-4 text-navy dark:text-gray-300 shrink-0" />}
              <input
                value={item.label}
                onChange={e => renameNavItem(item.id, e.target.value)}
                className="flex-1 bg-transparent text-sm text-navy dark:text-gray-100 focus:outline-none"
              />
            </Reorder.Item>
          ))}
        </Reorder.Group>
        <div className="flex gap-2 mt-4">
          <button onClick={saveNavigation} className={btnPrimary}>Save navigation</button>
          <button onClick={resetNavigation} className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition">
            <RotateCcw className="w-3.5 h-3.5" /> Reset to default
          </button>
        </div>
      </SettingsCard>

      <SettingsCard title="App preferences" description="How the app looks and behaves for you.">
        <div className="max-w-md flex flex-col gap-4">
          <label className="flex items-center justify-between">
            <span className="text-sm text-navy dark:text-gray-200">Animated background</span>
            <input type="checkbox" checked={backgroundEnabled} onChange={e => setBackgroundEnabled(e.target.checked)} className="w-4 h-4 accent-mint" />
          </label>
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Default tab on login</label>
            <select value={defaultTab} onChange={e => setDefaultTab(e.target.value)} className={inputClass}>
              <option value="overview">Overview</option>
              <option value="transactions">Transactions</option>
              <option value="savings">Savings</option>
              <option value="budgets">Budgets</option>
              <option value="chat">Chat</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Transactions per page</label>
            <select value={perPage} onChange={e => setPerPage(Number(e.target.value))} className={inputClass}>
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
          </div>
          <button onClick={savePreferences} className={`${btnPrimary} self-start`}>Save preferences</button>

          <div className="pt-4 border-t border-gray-100 dark:border-gray-800">
            <p className="text-sm text-navy dark:text-gray-200 mb-1">Walkthrough</p>
            <p className="text-xs text-slate-400 mb-2">Replay the tour of what each section does.</p>
            <button
              onClick={() => {
                setProfile(p => ({ ...p, hasSeenTour: false }))
                showToast('Here it is')
              }}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
            >
              Show walkthrough again
            </button>
          </div>
        </div>
      </SettingsCard>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete your account?"
        message="This permanently deletes your account and every transaction, income entry, savings record, and budget you've logged. This cannot be undone."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={deleteAccount}
      />
    </div>
  )
}
