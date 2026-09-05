import { initializeApp } from "firebase/app";
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

const firebaseConfig = {
  projectId: "botwiner-research",
  appId: "your-firebase-app-id",
  storageBucket: "your-project-id.firebasestorage.app",
  apiKey: "your-firebase-web-api-key",
  authDomain: "your-project-id.firebaseapp.com",
  messagingSenderId: "your-messaging-sender-id",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);

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
