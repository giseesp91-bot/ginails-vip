// Firebase configuration & initialization
// This file is the single place where Firebase is set up for the whole app.
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAIV6s4MRQTZHq-dRw-gqBmK4KceUWnY_c",
  authDomain: "ginails-vip.firebaseapp.com",
  projectId: "ginails-vip",
  storageBucket: "ginails-vip.firebasestorage.app",
  messagingSenderId: "570646656790",
  appId: "1:570646656790:web:aa743301aa60f2d7e4c237"
};

// Initialize the Firebase app once and re-export the services we need
export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const googleProvider = new GoogleAuthProvider();