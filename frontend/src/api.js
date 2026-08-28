import { auth } from './firebase'

// Points at the local backend by default. In deployment, set
// VITE_API_URL to the deployed backend's origin (e.g. on Vercel:
// Settings → Environment Variables → VITE_API_URL).
// Vite inlines this at build time, so changing it requires a redeploy.
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'
export const API = `${API_BASE}/api`

// Attaches the current user's Firebase ID token to every request, so the
// backend can verify who's asking and scope data to that user only.
export async function authedFetch(path, options = {}) {
  const send = async (forceRefresh) => {
    const token = await auth.currentUser.getIdToken(forceRefresh)
    return fetch(`${API}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`
      }
    })
  }

  let res = await send(false)

  // A 403 email_not_verified usually means the cached token predates the
  // user verifying — the claim only updates in a newly issued token. Retry
  // once with a forced refresh rather than making them log out and back in.
  if (res.status === 403) {
    const body = await res.clone().json().catch(() => ({}))
    if (body.code === 'email_not_verified' && auth.currentUser?.emailVerified) {
      res = await send(true)
    }
  }

  return res
}
