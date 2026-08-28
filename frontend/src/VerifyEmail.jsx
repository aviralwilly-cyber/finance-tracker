import { useEffect, useState } from 'react'
import { sendEmailVerification, signOut, reload } from 'firebase/auth'
import { auth } from './firebase'
import Lightfall from './Lightfall'
import MoneyBagIcon from './MoneyBagIcon'

// Blocks the app until the email is verified.
//
// Firebase's default verification emails land in spam often enough that a
// hard gate without a working resend and honest troubleshooting would just
// strand people. Hence the explicit spam warning, the resend button with a
// cooldown, and a visible way out via logging out.
export default function VerifyEmail({ user }) {
  const [sending, setSending] = useState(false)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [cooldown, setCooldown] = useState(0)

  const theme = {
    card: 'rgba(17, 34, 64, 0.85)', text: '#e6f1ff',
    subtext: '#8892b0', border: '#233554'
  }

  // Firebase rate-limits verification sends; a cooldown makes that visible
  // rather than letting someone hammer the button into an opaque error.
  useEffect(() => {
    if (cooldown <= 0) return
    const id = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(id)
  }, [cooldown])

  // Clicking the link verifies the account in Firebase, but THIS tab won't
  // know until the user object is refreshed. Poll quietly so it advances on
  // its own if they verify in another tab.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        await reload(auth.currentUser)
        if (auth.currentUser?.emailVerified) {
          // Force-refresh the ID token. Verifying updates the account, but
          // the cached JWT still carries email_verified: false until a new
          // one is issued — and the backend reads the token, not the user.
          await auth.currentUser.getIdToken(true)
          window.location.reload()
        }
      } catch {
        // Offline or transient — the manual button still works.
      }
    }, 5000)
    return () => clearInterval(id)
  }, [])

  const resend = async () => {
    setSending(true)
    setError('')
    setNotice('')
    try {
      await sendEmailVerification(auth.currentUser)
      setNotice('Sent. Check your inbox — and your spam folder.')
      setCooldown(60)
    } catch (err) {
      setError(
        err.code === 'auth/too-many-requests'
          ? 'Too many requests. Wait a few minutes before trying again.'
          : err.message.replace('Firebase: ', '')
      )
    } finally {
      setSending(false)
    }
  }

  const checkNow = async () => {
    setChecking(true)
    setError('')
    try {
      await reload(auth.currentUser)
      if (auth.currentUser?.emailVerified) {
        await auth.currentUser.getIdToken(true) // see note above
        window.location.reload()
      } else {
        setError("Still not verified. Click the link in the email, then try again.")
      }
    } catch (err) {
      setError(err.message.replace('Firebase: ', ''))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div style={{ position: 'relative', minHeight: '100vh', background: '#0a192f' }}>
      <div style={{ position: 'fixed', inset: 0, zIndex: 0 }}>
        <Lightfall
          colors={['#64ffda', '#8892b0', '#112240']}
          backgroundColor="#0a192f"
          speed={0.4}
          streakCount={2}
          mouseInteraction={false}
        />
      </div>

      <div
        style={{
          position: 'relative', zIndex: 1, minHeight: '100vh',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '1rem'
        }}
      >
        <div
          style={{
            width: '100%', maxWidth: 420, padding: '2rem',
            fontFamily: 'system-ui, sans-serif',
            background: theme.card, backdropFilter: 'blur(6px)',
            borderRadius: 16, boxShadow: '0 8px 30px rgba(0,0,0,0.08)',
            color: theme.text
          }}
        >
          <h1 style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8, fontSize: 20 }}>
            <MoneyBagIcon className="w-7 h-7" /> Verify your email
          </h1>

          <p style={{ color: theme.subtext, marginTop: 8, marginBottom: 4, fontSize: 14, lineHeight: 1.6 }}>
            We sent a verification link to
          </p>
          <p style={{ fontSize: 14, fontWeight: 600, marginTop: 0, marginBottom: 16, wordBreak: 'break-all' }}>
            {user.email}
          </p>
          <p style={{ color: theme.subtext, marginTop: 0, marginBottom: 20, fontSize: 13, lineHeight: 1.6 }}>
            Click the link, then come back here. This page checks automatically, or
            use the button below.
          </p>

          <div style={{
            background: 'rgba(250, 204, 21, 0.1)',
            border: '1px solid rgba(250, 204, 21, 0.3)',
            borderRadius: 8, padding: '10px 12px', marginBottom: 20
          }}>
            <p style={{ margin: 0, fontSize: 12, color: '#facc15', lineHeight: 1.5 }}>
              Not in your inbox? Check spam — automated verification emails often
              land there.
            </p>
          </div>

          {error && <p style={{ color: '#ff6b6b', fontSize: 13, marginTop: 0, marginBottom: 12 }}>{error}</p>}
          {notice && <p style={{ color: '#64ffda', fontSize: 13, marginTop: 0, marginBottom: 12 }}>{notice}</p>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              onClick={checkNow}
              disabled={checking}
              style={{
                padding: 10, background: '#64ffda', color: '#0a192f',
                border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer'
              }}
            >
              {checking ? 'Checking…' : "I've verified — continue"}
            </button>

            <button
              onClick={resend}
              disabled={sending || cooldown > 0}
              style={{
                padding: 10, background: 'transparent', color: theme.text,
                border: `1px solid ${theme.border}`, borderRadius: 6,
                cursor: cooldown > 0 ? 'not-allowed' : 'pointer',
                opacity: cooldown > 0 ? 0.6 : 1
              }}
            >
              {sending ? 'Sending…' : cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend the email'}
            </button>
          </div>

          <p style={{ fontSize: 13, color: theme.subtext, marginTop: 20, marginBottom: 0 }}>
            Wrong address, or want to use a different account?{' '}
            <button
              onClick={() => signOut(auth)}
              style={{
                background: 'none', border: 'none', color: theme.text,
                textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit'
              }}
            >
              Log out
            </button>
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
