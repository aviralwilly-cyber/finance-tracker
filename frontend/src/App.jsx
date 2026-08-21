import { useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from './firebase'
import { authedFetch } from './api'
import Login from './Login'
import Onboarding from './Onboarding'
import Dashboard from './Dashboard'

export default function App() {
  const [user, setUser] = useState(null)
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [profile, setProfile] = useState(null)
  const [checkingProfile, setCheckingProfile] = useState(false)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u)
      setCheckingAuth(false)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!user) {
      setProfile(null)
      return
    }
    setCheckingProfile(true)
    authedFetch('/profile')
      .then(res => res.json())
      .then(setProfile)
      .finally(() => setCheckingProfile(false))
  }, [user])

  if (checkingAuth || (user && checkingProfile)) {
    return <p className="text-center mt-20 text-slate-500 text-sm">Loading…</p>
  }

  if (!user) return <Login />
  if (!profile?.displayName) return <Onboarding onComplete={setProfile} />
  return <Dashboard user={user} profile={profile} />
}
