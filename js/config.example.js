/**
 * Firebase Configuration -- LOCAL DEVELOPMENT TEMPLATE
 *
 * Copy this file to js/config.js and replace the values with your Firebase
 * project credentials. js/config.js is gitignored.
 *
 * On Vercel, build/inject-config.js generates js/config.js from environment
 * variables instead -- you do NOT commit your real credentials.
 */

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

export function isFirebaseConfigured() {
  return firebaseConfig.apiKey !== "YOUR_API_KEY" && firebaseConfig.projectId !== "YOUR_PROJECT_ID";
}

export default firebaseConfig;
