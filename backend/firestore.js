import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const KEY_PATH = path.resolve('./serviceAccountKey.json');

let db = null;
let auth = null;

if (fs.existsSync(KEY_PATH)) {
  const serviceAccount = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  auth = admin.auth();
} else {
  console.warn('⚠️  serviceAccountKey.json not found — Firestore is not configured. See README for setup.');
}

export { db, auth };
