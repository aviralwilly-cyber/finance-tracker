import { useEffect, useState } from 'react'
import { LogOut, Menu, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import MoneyBagIcon from './MoneyBagIcon'

// Two genuinely different layouts rather than one that shrinks:
//
// Desktop (md+): the existing persistent rail, collapsible to icons.
// Mobile: a slide-over drawer behind a hamburger. A 224px fixed sidebar on
// a 390px phone leaves ~160px of usable width, which no amount of
// responsive tweaking makes workable — the sidebar has to get out of the
// way entirely.
export default function Sidebar({ tabs, activeTab, setActiveTab, userEmail, userName, photoURL, avatarEmoji, onLogout }) {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('sidebarCollapsed') === 'true'
  })
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    localStorage.setItem('sidebarCollapsed', collapsed)
  }, [collapsed])

  // Close the drawer on Escape — standard for any overlay, and easy to
  // forget when the only obvious dismissal is tapping the backdrop.
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = e => { if (e.key === 'Escape') setDrawerOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  // Prevent the page scrolling underneath the open drawer.
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [drawerOpen])

  const Avatar = () => (
    photoURL ? (
      <img src={photoURL} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
    ) : avatarEmoji ? (
      <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-base shrink-0">
        {avatarEmoji}
      </div>
    ) : (
      <div className="w-8 h-8 rounded-full bg-navy dark:bg-mint text-white dark:text-navy flex items-center justify-center text-xs font-semibold shrink-0">
        {(userName || userEmail || '?').charAt(0).toUpperCase()}
      </div>
    )
  )

  // `compact` is only ever true on desktop — the drawer always shows labels,
  // since there's no reason to cram icons when it's overlaying anyway.
  const NavItems = ({ compact, onNavigate }) => (
    <nav className="flex-1 overflow-y-auto py-3">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => { setActiveTab(tab.id); onNavigate?.() }}
          title={compact ? tab.label : undefined}
          className={`relative w-full text-left px-5 py-3 md:py-2.5 text-sm font-medium transition-colors flex items-center ${
            compact ? 'justify-center px-0' : ''
          } ${
            activeTab === tab.id
              ? 'text-navy dark:text-mint'
              : 'text-slate-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-navy dark:hover:text-gray-200'
          }`}
        >
          {activeTab === tab.id && (
            <motion.div
              layoutId={compact ? 'sidebar-active-desktop' : 'sidebar-active-drawer'}
              className="absolute inset-0 bg-mint/10 border-r-2 border-mint"
              transition={{ type: 'spring', stiffness: 500, damping: 40 }}
            />
          )}
          {tab.icon && (
            <span className="relative">
              <tab.icon className="w-4 h-4" />
            </span>
          )}
          {!compact && <span className="relative ml-2 whitespace-nowrap">{tab.label}</span>}
        </button>
      ))}
    </nav>
  )

  // Attribution + copyright notice. Sits below the nav (which is flex-1, so
  // it gets pushed to the bottom of the rail) and above the account block.
  // At w-16 two lines of text would wrap into a mess, so the collapsed state
  // degrades to a bare © with the full notice as a tooltip.
  const Credit = ({ compact }) => (
    <div
      className={`px-4 py-3 border-t border-gray-200 dark:border-gray-800 text-center text-slate-400 dark:text-slate-500 ${
        compact ? 'text-[10px]' : 'text-[11px] leading-relaxed'
      }`}
    >
      {compact ? (
        <p title={`Built and designed by Aviral Abel Willy. © ${new Date().getFullYear()} All rights reserved.`}>
          &copy;
        </p>
      ) : (
        <>
          <p>Built and designed by Aviral Abel Willy.</p>
          <p>&copy; {new Date().getFullYear()} All rights reserved.</p>
        </>
      )}
    </div>
  )

  return (
    <>
      {/* Mobile top bar — the only chrome visible on a phone until the
          drawer is opened. */}
      <header className="md:hidden fixed top-0 inset-x-0 z-30 flex items-center gap-3 px-4 h-14 bg-white/90 dark:bg-gray-900/90 backdrop-blur-md border-b border-gray-200 dark:border-gray-800">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="p-1.5 -ml-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
        >
          <Menu className="w-5 h-5" />
        </button>
        <h1 className="text-sm font-bold text-navy dark:text-gray-100 flex items-center gap-2 flex-1 min-w-0">
          <MoneyBagIcon className="w-5 h-5 shrink-0" />
          <span className="truncate">Finance Tracker</span>
        </h1>
        <Avatar />
      </header>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setDrawerOpen(false)}
              className="md:hidden fixed inset-0 bg-black/50 z-40"
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 400, damping: 40 }}
              className="md:hidden fixed inset-y-0 left-0 w-64 max-w-[80vw] z-50 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col"
            >
              <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center gap-3">
                <button
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close menu"
                  className="p-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                >
                  <X className="w-5 h-5" />
                </button>
                <h1 className="text-base font-bold text-navy dark:text-gray-100 flex items-center gap-2">
                  <MoneyBagIcon className="w-6 h-6 shrink-0" />
                  Finance Tracker
                </h1>
              </div>

              <NavItems compact={false} onNavigate={() => setDrawerOpen(false)} />

              <Credit compact={false} />

              <div className="p-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2">
                <Avatar />
                <p className="text-xs text-slate-400 truncate flex-1">{userEmail}</p>
              </div>
              <div className="p-4 border-t border-gray-200 dark:border-gray-800">
                <button
                  onClick={onLogout}
                  className="w-full flex items-center justify-center gap-2 px-2 py-2.5 text-sm rounded-md border border-gray-300 dark:border-gray-700 text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                >
                  <LogOut className="w-4 h-4 shrink-0" /> Log out
                </button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Desktop sidebar — unchanged behaviour, just hidden below md. */}
      <aside
        className={`hidden md:flex shrink-0 h-screen sticky top-0 bg-white/85 dark:bg-gray-900/80 backdrop-blur-md border-r border-gray-200 dark:border-gray-800 flex-col z-10 transition-all duration-300 ease-in-out ${
          collapsed ? 'w-16' : 'w-56'
        }`}
      >
        <div className={`p-4 border-b border-gray-200 dark:border-gray-800 flex ${collapsed ? 'flex-col items-center gap-2' : 'items-center gap-3'}`}>
          <button
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="p-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:text-navy dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition shrink-0"
          >
            <Menu className="w-5 h-5" />
          </button>
          <h1 className="text-base font-bold text-navy dark:text-gray-100 flex items-center gap-2 whitespace-nowrap overflow-hidden">
            <MoneyBagIcon className="w-6 h-6 shrink-0" />
            {!collapsed && 'Finance Tracker'}
          </h1>
        </div>

        <NavItems compact={collapsed} />

        <Credit compact={collapsed} />

        <div className={`p-4 border-t border-gray-200 dark:border-gray-800 flex ${collapsed ? 'flex-col items-center gap-2' : 'items-center gap-2'}`}>
          <Avatar />
          {!collapsed && <p className="text-xs text-slate-400 truncate flex-1">{userEmail}</p>}
        </div>

        <div className="p-4 border-t border-gray-200 dark:border-gray-800">
          <button
            onClick={onLogout}
            title={collapsed ? 'Log out' : undefined}
            className="w-full flex items-center justify-center gap-2 px-2 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-700 text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
          >
            <LogOut className="w-4 h-4 shrink-0" /> {!collapsed && <span className="whitespace-nowrap">Log out</span>}
          </button>
        </div>
      </aside>
    </>
  )
}