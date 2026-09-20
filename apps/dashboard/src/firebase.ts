import { initializeApp, type FirebaseOptions } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  query,
  orderBy,
  limit,
  onSnapshot,
} from "firebase/firestore";

const env = import.meta.env;
const requiredConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY?.trim(),
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN?.trim(),
  projectId: env.VITE_FIREBASE_PROJECT_ID?.trim(),
  appId: env.VITE_FIREBASE_APP_ID?.trim(),
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim(),
};

const firebaseConfig: FirebaseOptions | null =
  requiredConfig.apiKey &&
  requiredConfig.authDomain &&
  requiredConfig.projectId &&
  requiredConfig.appId &&
  requiredConfig.messagingSenderId
    ? {
        apiKey: requiredConfig.apiKey,
        authDomain: requiredConfig.authDomain,
        projectId: requiredConfig.projectId,
        appId: requiredConfig.appId,
        messagingSenderId: requiredConfig.messagingSenderId,
        ...(env.VITE_FIREBASE_STORAGE_BUCKET?.trim()
          ? { storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET.trim() }
          : {}),
      }
    : null;

const app = firebaseConfig ? initializeApp(firebaseConfig) : null;
export const firebaseEnabled = app !== null;
export const auth = app ? getAuth(app) : null;
export const googleProvider = app ? new GoogleAuthProvider() : null;
export const db = app ? getFirestore(app) : null;

export {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  collection,
  doc,
  query,
  orderBy,
  limit,
  onSnapshot,
  type User,
};
