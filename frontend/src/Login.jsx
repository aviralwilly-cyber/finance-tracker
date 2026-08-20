import { useState } from 'react'
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword
} from 'firebase/auth'
import { auth } from './firebase'
import Ballpit from './Ballpit'

export default function Login() {
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [dark, setDark] = useState(false)

  const theme = dark
    ? { bg: '#0a192f', card: 'rgba(17, 34, 64, 0.85)', text: '#e6f1ff', subtext: '#8892b0', border: '#233554', inputBg: '#112240' }
    : { bg: '#fafafa', card: 'rgba(255, 255, 255, 0.85)', text: '#111', subtext: '#666', border: '#ddd', inputBg: '#fff' }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'login') {
        await signInWithEmailAndPassword(auth, email, password)
      } else {
        await createUserWithEmailAndPassword(auth, email, password)
      }
      // onAuthStateChanged in App.jsx picks up the signed-in user automatically
    } catch (err) {
      setError(err.message.replace('Firebase: ', ''))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ position: 'relative', minHeight: '100vh', width: '100%', overflow: 'hidden', background: theme.bg, transition: 'background 0.3s' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <Ballpit
          count={100}
          gravity={0.01}
          friction={0.9975}
          wallBounce={0.95}
          followCursor={false}
          colors={[0x64ffda, 0x112240, 0x8892b0]}
        />
      </div>

      <button
        onClick={() => setDark(d => !d)}
        aria-label="Toggle background color"
        style={{
          position: 'absolute',
          top: 20,
          right: 20,
          zIndex: 2,
          padding: '8px 14px',
          fontSize: 13,
          borderRadius: 20,
          border: `1px solid ${theme.border}`,
          background: theme.card,
          color: theme.text,
          backdropFilter: 'blur(6px)',
          cursor: 'pointer'
        }}
      >
        {dark ? '☀️ Light' : '🌙 Dark'}
      </button>

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          minHeight: '100vh',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem'
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
          <h1 style={{ marginBottom: 4 }}>💰 AI Finance Tracker</h1>
          <p style={{ color: theme.subtext, marginTop: 0, marginBottom: 24 }}>
            {mode === 'login' ? 'Log in to see your transactions.' : 'Create an account to get started.'}
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
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={6}
              style={{ padding: 10, background: theme.inputBg, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 6 }}
            />
            {error && <p style={{ color: '#ff6b6b', fontSize: 13, margin: 0 }}>{error}</p>}
            <button type="submit" disabled={loading} style={{ padding: 10, background: dark ? '#64ffda' : '#111', color: dark ? '#0a192f' : '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}>
              {loading ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Sign up'}
            </button>
          </form>

          <p style={{ fontSize: 13, color: theme.subtext, marginTop: 16 }}>
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button
              onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError('') }}
              style={{ background: 'none', border: 'none', color: theme.text, textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit' }}
            >
              {mode === 'login' ? 'Sign up' : 'Log in'}
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}
