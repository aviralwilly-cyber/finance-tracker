import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
// import { getStorage } from 'firebase/storage'


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
// export const storage = getStorage(app)


