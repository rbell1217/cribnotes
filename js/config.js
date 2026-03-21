/**
 * Firebase Configuration
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to https://console.firebase.google.com
 * 2. Create a new project or use existing
 * 3. Enable Authentication (Email/Password and Google)
 * 4. Create a Firestore database (Start in test mode initially)
 * 5. Enable Storage
 * 6. Copy your project config from Project Settings
 * 7. Replace the values below with your actual Firebase credentials
 * 8. For production, move this to environment variables
 */

const firebaseConfig = {
  apiKey: "AIzaSyB8LqpZW_K6uANyO7_JIJxzFaDynthGjy8",
  authDomain: "cribnotes-3e6e8.firebaseapp.com",
  projectId: "cribnotes-3e6e8",
  storageBucket: "cribnotes-3e6e8.firebasestorage.app",
  messagingSenderId: "5394850943",
  appId: "1:5394850943:web:5a4f4abb5a33f375e84b4a"
};

// Check if Firebase is configured
export function isFirebaseConfigured() {
  return firebaseConfig.apiKey !== "YOUR_API_KEY" && firebaseConfig.projectId !== "YOUR_PROJECT_ID";
}

export default firebaseConfig;
