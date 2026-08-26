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
  const token = await auth.currentUser.getIdToken()
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`
    }
  })
}
