import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDr0znIkaadvyGEJXE8xJfn_AW7E5tmaso",
  authDomain: "qishan-miyue.firebaseapp.com",
  projectId: "qishan-miyue",
  storageBucket: "qishan-miyue.firebasestorage.app",
  messagingSenderId: "9634874321",
  appId: "1:9634874321:web:09d5d99f19dac92e6296f0"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
