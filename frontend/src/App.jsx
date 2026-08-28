import { useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from './firebase'
import { authedFetch } from './api'
import Login from './Login'
import Onboarding from './Onboarding'
import Dashboard from './Dashboard'
import VerifyEmail from './VerifyEmail'

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
    if (!user || !user.emailVerified) {
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
  // Hard gate: nothing past this point until the address is confirmed.
  if (!user.emailVerified) return <VerifyEmail user={user} />
  if (!profile?.displayName) return <Onboarding onComplete={setProfile} />
  return <Dashboard key={user.uid} user={user} profile={profile} setProfile={setProfile} />
}
