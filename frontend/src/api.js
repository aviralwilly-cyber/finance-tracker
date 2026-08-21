import { auth } from './firebase'

export const API = 'http://localhost:8080/api'

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
