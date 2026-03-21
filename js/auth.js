/**
 * Firebase Authentication Module
 * Handles: email/password auth, Google sign-in, role selection, auth state
 */

import firebaseConfig, { isFirebaseConfigured } from './config.js';

let app = null;
let auth = null;
let firestore = null;
let currentUser = null;

// Initialize Firebase
export function initializeFirebase() {
  if (!isFirebaseConfigured()) {
    console.warn('Firebase not configured. Please update js/config.js with your credentials.');
    return false;
  }

  try {
    app = firebase.initializeApp(firebaseConfig);
    auth = firebase.auth(app);
    firestore = firebase.firestore(app);

    // Listen to auth state changes
    auth.onAuthStateChanged(async (user) => {
      currentUser = user;
      if (user) {
        // Load user profile from Firestore
        try {
          const docSnap = await firestore.collection('users').doc(user.uid).get();
          if (docSnap.exists) {
            const userData = docSnap.data();
            // Dispatch custom event so app.js can update UI
            window.dispatchEvent(new CustomEvent('authStateChanged', {
              detail: { user, userData }
            }));
          } else {
            // User logged in but no profile yet (should create during signup)
            window.dispatchEvent(new CustomEvent('authStateChanged', {
              detail: { user, userData: null }
            }));
          }
        } catch (error) {
          console.error('Error loading user profile:', error);
          window.dispatchEvent(new CustomEvent('authStateChanged', {
            detail: { user, userData: null, error }
          }));
        }
      } else {
        // User logged out
        window.dispatchEvent(new CustomEvent('authStateChanged', {
          detail: { user: null, userData: null }
        }));
      }
    });

    return true;
  } catch (error) {
    console.error('Firebase initialization error:', error);
    return false;
  }
}

export function getAuth() {
  return auth;
}

export function getFirestore() {
  return firestore;
}

export function getCurrentUser() {
  return currentUser;
}

/**
 * Sign up with email and password
 * @param {string} email
 * @param {string} password
 * @param {string} name - Display name
 * @param {string} role - 'parent' or 'babysitter'
 */
export async function signUpWithEmail(email, password, name, role) {
  try {
    // Create auth user
    const result = await auth.createUserWithEmailAndPassword(email, password);
    const user = result.user;

    // Update display name
    await user.updateProfile({ displayName: name });

    // Create user profile in Firestore
    await firestore.collection('users').doc(user.uid).set({
      email: user.email,
      name: name,
      role: role, // 'parent' or 'babysitter'
      familyId: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      avatar: null
    });

    return { success: true, user };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Sign in with email and password
 * @param {string} email
 * @param {string} password
 */
export async function signInWithEmail(email, password) {
  try {
    const result = await auth.signInWithEmailAndPassword(email, password);
    return { success: true, user: result.user };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Sign in with Google
 */
export async function signInWithGoogle() {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const result = await auth.signInWithPopup(provider);
    const user = result.user;

    // Check if user profile exists
    const docSnap = await firestore.collection('users').doc(user.uid).get();
    if (!docSnap.exists) {
      // New Google user - create profile
      await firestore.collection('users').doc(user.uid).set({
        email: user.email,
        name: user.displayName || 'User',
        role: null, // Will be set during onboarding
        familyId: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        avatar: user.photoURL || null
      });
    }

    return { success: true, user };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Set user role (parent or babysitter)
 * @param {string} role
 */
export async function setUserRole(role) {
  try {
    if (!currentUser) throw new Error('No user logged in');

    await firestore.collection('users').doc(currentUser.uid).update({
      role: role
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Send password reset email
 * @param {string} email
 */
export async function sendPasswordResetEmail(email) {
  try {
    await auth.sendPasswordResetEmail(email);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Sign out
 */
export async function signOut() {
  try {
    await auth.signOut();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get user's family ID
 */
export async function getUserFamilyId(uid) {
  try {
    const docSnap = await firestore.collection('users').doc(uid).get();
    if (docSnap.exists) {
      return docSnap.data().familyId;
    }
    return null;
  } catch (error) {
    console.error('Error getting family ID:', error);
    return null;
  }
}

/**
 * Update family ID in user profile
 */
export async function setUserFamilyId(uid, familyId) {
  try {
    await firestore.collection('users').doc(uid).update({
      familyId: familyId
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
