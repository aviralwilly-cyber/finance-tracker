import { useEffect, useState } from 'react'
import { LogOut, Menu } from 'lucide-react'
import { motion } from 'framer-motion'
import MoneyBagIcon from './MoneyBagIcon'

export default function Sidebar({ tabs, activeTab, setActiveTab, userEmail, userName, photoURL, avatarEmoji, onLogout }) {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('sidebarCollapsed') === 'true'
  })

  useEffect(() => {
    localStorage.setItem('sidebarCollapsed', collapsed)
  }, [collapsed])

  return (
    <aside
      className={`shrink-0 h-screen sticky top-0 bg-white/85 dark:bg-gray-900/80 backdrop-blur-md border-r border-gray-200 dark:border-gray-800 flex flex-col z-10 transition-all duration-300 ease-in-out ${
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

      <nav className="flex-1 overflow-y-auto py-3">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            title={collapsed ? tab.label : undefined}
            className={`relative w-full text-left px-5 py-2.5 text-sm font-medium transition-colors flex items-center ${
              collapsed ? 'justify-center px-0' : ''
            } ${
              activeTab === tab.id
                ? 'text-navy dark:text-mint'
                : 'text-slate-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-navy dark:hover:text-gray-200'
            }`}
          >
            {activeTab === tab.id && (
              <motion.div
                layoutId="sidebar-active-tab"
                className="absolute inset-0 bg-mint/10 border-r-2 border-mint"
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              />
            )}
            {tab.icon && (
              <span className="relative">
                <tab.icon className="w-4 h-4" />
              </span>
            )}
            {!collapsed && <span className="relative ml-2 whitespace-nowrap">{tab.label}</span>}
          </button>
        ))}
      </nav>

      <div className={`p-4 border-t border-gray-200 dark:border-gray-800 flex ${collapsed ? 'flex-col items-center gap-2' : 'items-center gap-2'}`}>
        {photoURL ? (
          <img src={photoURL} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
        ) : avatarEmoji ? (
          <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-base shrink-0">
            {avatarEmoji}
          </div>
        ) : (
          <div className="w-8 h-8 rounded-full bg-navy dark:bg-mint text-white dark:text-navy flex items-center justify-center text-xs font-semibold shrink-0">
            {(userName || userEmail || '?').charAt(0).toUpperCase()}
          </div>
        )}
        {!collapsed && <p className="text-xs text-slate-400 truncate flex-1">{userEmail}</p>}
      </div>

      <div className="p-4 border-t border-gray-200 dark:border-gray-800">
        <button
          onClick={onLogout}
          title={collapsed ? 'Log out' : undefined}
          className={`w-full flex items-center justify-center gap-2 px-2 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-700 text-navy dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition`}
        >
          <LogOut className="w-4 h-4 shrink-0" /> {!collapsed && <span className="whitespace-nowrap">Log out</span>}
        </button>
      </div>
    </aside>
  )
}
