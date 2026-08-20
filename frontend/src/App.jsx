import { useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from './firebase'
import Login from './Login'
import Dashboard from './Dashboard'

export default function App() {
  const [user, setUser] = useState(null)
  const [checkingAuth, setCheckingAuth] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u)
      setCheckingAuth(false)
    })
    return unsubscribe
  }, [])

  if (checkingAuth) {
    return <p style={{ textAlign: 'center', marginTop: 80, fontFamily: 'system-ui, sans-serif', color: '#666' }}>Loading…</p>
  }

  return user ? <Dashboard user={user} /> : <Login />
}
