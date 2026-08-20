import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'

// Fill these in from: Firebase Console → Project settings → General →
// "Your apps" → Web app (</> icon) → register an app if you haven't yet.
// This config is safe to keep in frontend code — it identifies your project,
// it doesn't grant access on its own (Firestore security rules do that).
const firebaseConfig = {
  apiKey: "AIzaSyCg-ijkzPIuoMUpxpvYqoPjcEatFumTVTE",
  authDomain: "finance-tracker-45e42.firebaseapp.com",
  projectId: "finance-tracker-45e42",
  storageBucket: "finance-tracker-45e42.firebasestorage.app",
  messagingSenderId: "194779311484",
  appId: "1:194779311484:web:0ed086fa36cbd9546ac8f9"
};

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
