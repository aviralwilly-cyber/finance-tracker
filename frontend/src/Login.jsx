import { useEffect, useState } from 'react'
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification
} from 'firebase/auth'
import { auth } from './firebase'
import { API } from './api'
import Lightfall from './Lightfall'
import MoneyBagIcon from './MoneyBagIcon'

export default function Login() {
  const [mode, setMode] = useState('login') // 'login' | 'signup' | 'reset'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)

  // Admins can close signups app-wide. Checked here so the UI reflects it,
  // though the real enforcement is that a closed signup simply isn't offered.
  const [signupsEnabled, setSignupsEnabled] = useState(true)
  useEffect(() => {
    fetch(`${API}/public-settings`)
      .then(r => r.json())
      .then(d => setSignupsEnabled(d.signupsEnabled !== false))
      .catch(() => {}) // default to open if the check fails
  }, [])

  // App is dark-mode only.
  const theme = { bg: '#0a192f', card: 'rgba(17, 34, 64, 0.85)', text: '#e6f1ff', subtext: '#8892b0', border: '#233554', inputBg: '#112240' }

  const switchMode = (next) => {
    setMode(next)
    setError('')
    setNotice('')
  }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setNotice('')
    setLoading(true)
    try {
      if (mode === 'login') {
        await signInWithEmailAndPassword(auth, email, password)
      } else if (mode === 'signup') {
        const credential = await createUserWithEmailAndPassword(auth, email, password)
        // Send immediately on signup so the verification gate isn't the
        // first place they hear about it.
        await sendEmailVerification(credential.user).catch(() => {})
      } else {
        await sendPasswordResetEmail(auth, email)
        // Deliberately worded so it doesn't confirm whether an account
        // exists — otherwise this form becomes a way to check which email
        // addresses are registered.
        setNotice("If an account exists for that email, a reset link is on its way. Check your inbox and spam folder.")
      }
      // onAuthStateChanged in App.jsx picks up the signed-in user automatically
    } catch (err) {
      setError(err.message.replace('Firebase: ', ''))
    } finally {
      setLoading(false)
    }
  }

  const heading = {
    login: 'Log in to see your transactions.',
    signup: 'Create an account to get started.',
    reset: "Enter your email and we'll send you a reset link."
  }[mode]

  const buttonLabel = {
    login: 'Log in',
    signup: 'Sign up',
    reset: 'Send reset link'
  }[mode]

  return (
    <div style={{ position: 'relative', minHeight: '100vh', width: '100%', overflow: 'hidden', background: theme.bg, transition: 'background 0.3s' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <Lightfall
          colors={['#64ffda', '#8892b0', '#112240']}
          backgroundColor="#0a192f"
          speed={0.5}
          streakCount={3}
          streakWidth={1}
          streakLength={1.2}
          glow={1}
          density={0.6}
          twinkle={1}
          zoom={3}
          backgroundGlow={0.4}
          opacity={1}
          mouseInteraction
          mouseStrength={0.5}
          mouseRadius={1}
        />
      </div>

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          minHeight: '100vh',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem'
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 360,
            padding: '2rem',
            fontFamily: 'system-ui, sans-serif',
            background: theme.card,
            backdropFilter: 'blur(6px)',
            borderRadius: 16,
            boxShadow: '0 8px 30px rgba(0,0,0,0.08)',
            color: theme.text,
            transition: 'background 0.3s, color 0.3s'
          }}
        >
          <h1 style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <MoneyBagIcon className="w-7 h-7" /> AI Finance Tracker
          </h1>
          <p style={{ color: theme.subtext, marginTop: 0, marginBottom: 24 }}>
            {heading}
          </p>

          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              style={{ padding: 10, background: theme.inputBg, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 6 }}
            />
            {mode !== 'reset' && (
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={6}
                style={{ padding: 10, background: theme.inputBg, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 6 }}
              />
            )}
            {error && <p style={{ color: '#ff6b6b', fontSize: 13, margin: 0 }}>{error}</p>}
            {notice && <p style={{ color: '#64ffda', fontSize: 13, margin: 0, lineHeight: 1.5 }}>{notice}</p>}
            <button type="submit" disabled={loading} style={{ padding: 10, background: '#64ffda', color: '#0a192f', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}>
              {loading ? 'Please wait…' : buttonLabel}
            </button>
          </form>

          {mode === 'login' && (
            <p style={{ fontSize: 13, marginTop: 12, marginBottom: 0 }}>
              <button
                onClick={() => switchMode('reset')}
                style={{ background: 'none', border: 'none', color: theme.subtext, textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit' }}
              >
                Forgot your password?
              </button>
            </p>
          )}

          <p style={{ fontSize: 13, color: theme.subtext, marginTop: 16 }}>
            {mode === 'reset' ? (
              <>
                Remembered it?{' '}
                <button
                  onClick={() => switchMode('login')}
                  style={{ background: 'none', border: 'none', color: theme.text, textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit' }}
                >
                  Back to log in
                </button>
              </>
            ) : (
              <>
                {mode === 'login' && !signupsEnabled ? (
                  'New signups are currently closed.'
                ) : (
                  <>
                    {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
                    <button
                      onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
                      style={{ background: 'none', border: 'none', color: theme.text, textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit' }}
                    >
                      {mode === 'login' ? 'Sign up' : 'Log in'}
                    </button>
                  </>
                )}
              </>
            )}
          </p>
        </div>

        <p style={{
          fontSize: 13, color: theme.subtext, textAlign: 'center',
          marginTop: 20, marginBottom: 0, lineHeight: 1.7
        }}>
          Built and designed by Aviral Abel Willy.<br />
          © 2026 All rights reserved.
        </p>
      </div>
    </div>
  )
}
