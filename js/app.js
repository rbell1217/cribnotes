/**
 * CribNotes Main Application
 * Single-page app with routing, auth state management, and UI rendering
 */

import {
  initializeFirebase, getAuth, getFirestore, getCurrentUser,
  signUpWithEmail, signInWithEmail, signInWithGoogle,
  setUserRole, sendPasswordResetEmail, signOut,
  setUserFamilyId, getUserFamilyId
} from './auth.js';

import {
  createFamily, getFamily, joinFamilyWithCode,
  addChild, getChildren, getChild, updateChild, deleteChild,
  getCareGuide, updateGuideSection, addGuideItem, removeGuideItem, clearCareGuide,
  createChecklist, getChecklists, updateChecklistItem, deleteChecklist,
  sendMessage, getMessages,
  addPhotoMetadata, getPhotos, deletePhoto,
  searchGuide, getGuideSections, getSectionLabel,
  updateCriticalInfo, getCriticalInfo,
  postQuickStatus,
  setSitterPermissions, getSitterPermissions,
  enableOfflinePersistence,
  searchFamiliesByParentEmail, requestToJoinFamily,
  listMyJoinRequests, listFamilyJoinRequests,
  approveJoinRequest, declineJoinRequest,
  searchSittersByEmail, inviteSitterByEmail,
  listMyFamilyInvites, listFamilyInvitesSent,
  acceptFamilyInvite, declineFamilyInvite, cancelFamilyInvite
} from './database.js';

import {
  isSpeechRecognitionAvailable, categorizeText,
  startDictation, stopDictation, abortDictation
} from './dictation.js';

import { processTranscript } from './textProcessor.js';

import { isFirebaseConfigured } from './config.js';

import {
  computeContext, filterGuideByContext, inferTagsFromText,
  describeContext, ALL_TAG_GROUPS, DAY_TAGS, TIME_TAGS, SHIFT_TAGS, SPECIAL_TAGS,
  tagBadgeColor
} from './context.js';

import {
  startShift, endShift, getActiveShift, getShift, listShifts,
  appendShiftLog, subscribeShiftLog, getShiftLog, summarizeShift,
  subscribeFlagged, acknowledgeFlag, getShiftTypes
} from './shift.js';

import {
  addMedication, listMedications, deactivateMedication,
  recordDose, listDoses, getMedicationStatus
} from './medication.js';

import {
  isPushSupported, requestNotificationPermission,
  subscribeToPush, showLocalNotification
} from './notifications.js';

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const state = {
  currentUser: null,
  userData: null,
  currentFamily: null,
  currentChild: null,
  currentScreen: 'auth-login', // routing
  route: {
    screen: 'auth-login',
    params: {}
  },
  dictationActive: false,
  searchResults: null,
  messageUnsubscribe: null,

  // Shift + context state
  activeShift: null,           // shift document for the currently-running shift
  contextTags: [],             // tag array driving guide filtering
  contextOverride: false,      // sitter chose "Show all notes" to bypass filter
  shiftLogUnsubscribe: null,
  flaggedUnsubscribe: null,
  pendingMedReminders: [],     // medication prompts due now
  permissions: null            // sitter permissions for the active family
};

// ============================================================================
// INITIALIZATION
// ============================================================================

// Tear down the diagnostic boot screen as soon as the module has parsed.
// If we got here, ES modules loaded successfully -- the rest of any failure
// will be surfaced inside the app instead of by the boot diagnostic.
function dismissBootScreen() {
  const boot = document.getElementById('boot-screen');
  if (boot) boot.remove();
}

document.addEventListener('DOMContentLoaded', async () => {
  // Check if Firebase is configured
  if (!isFirebaseConfigured()) {
    dismissBootScreen();
    renderSetupRequired();
    return;
  }

  // Honor "fresh start" flags from landing-page CTAs.
  // Visiting /app.html?signup=1 always force-signs-out the current Firebase
  // session and lands the user on the sign-up form. Visiting ?signin=1 does
  // the same but routes to the login form. Without a flag, a cached session
  // takes them straight to their dashboard (normal behavior).
  const url = new URL(window.location.href);
  const wantsSignup = url.searchParams.has('signup');
  const wantsSignin = url.searchParams.has('signin');
  if (wantsSignup || wantsSignin) {
    state.forceAuthScreen = wantsSignup ? 'signup' : 'signin';
    // Strip the query so refreshes don't re-trigger
    url.searchParams.delete('signup');
    url.searchParams.delete('signin');
    history.replaceState(null, '', url.toString());
    // Sign out any cached session before anything else loads
    try {
      if (firebase.apps && firebase.apps.length) {
        await firebase.auth().signOut();
      }
    } catch (e) { /* swallow — auth may not be initialized yet */ }
  }

  // Initialize Firebase
  const initialized = initializeFirebase();
  if (!initialized) {
    renderSetupRequired();
    return;
  }

  // Enable Firestore offline persistence for low-signal areas
  enableOfflinePersistence().then(r => {
    if (r.success) console.log('[CribNotes] Offline persistence enabled');
    else console.log('[CribNotes] Offline persistence not enabled:', r.error);
  });

  // Listen for auth state changes
  window.addEventListener('authStateChanged', async (e) => {
    const { user, userData } = e.detail;
    state.currentUser = user;
    state.userData = userData;

    if (user && userData) {
      // Load family data if user has one
      if (userData.familyId) {
        try {
          const familyResult = await getFamily(userData.familyId);
          if (familyResult.success) {
            state.currentFamily = familyResult.data;
            // Load any active shift so context filtering kicks in immediately
            await refreshActiveShift();
            // Load sitter permissions if user is a sitter
            if (userData.role === 'babysitter') {
              const p = await getSitterPermissions(userData.familyId, user.uid);
              if (p.success) state.permissions = p.data;
            }
          } else {
            console.warn('Failed to load family:', familyResult.error);
            state.currentFamily = null;
          }
        } catch (err) {
          console.error('Error loading family:', err);
          state.currentFamily = null;
        }
      } else {
        state.currentFamily = null;
      }
    } else {
      cleanupSubscriptions();
      state.currentFamily = null;
      state.activeShift = null;
      state.contextTags = [];
    }

    // Route to appropriate screen
    await routeApp();
  });

  // Periodically refresh medication status while a shift is running
  setInterval(async () => {
    if (state.activeShift && state.currentChild && state.currentFamily) {
      await checkPendingMedications();
    }
  }, 60 * 1000);

  // Initial route
  await routeApp();
});

// ============================================================================
// ROUTING
// ============================================================================

async function routeApp() {
  dismissBootScreen();

  // While the user is signed out, honor any ?signup=1 / ?signin=1 intent that
  // arrived in the URL. We DON'T clear the flag after rendering so that the
  // second routeApp() call (triggered by authStateChanged firing with user=null)
  // can't override the signup form back to the login form. The flag is only
  // cleared once the user successfully signs in/up and currentUser becomes set.
  if (!state.currentUser) {
    if (state.forceAuthScreen === 'signup') {
      state.currentScreen = 'auth-signup';
      renderAuthSignup();
      return;
    }
    // Force-signin and default both end up here
    state.currentScreen = 'auth-login';
    renderAuthLogin();
    return;
  }

  // User signed in: the force-auth flag has served its purpose. Drop it so
  // post-login routing isn't affected.
  state.forceAuthScreen = null;

  if (!state.userData) {
    // User logged in but no profile yet -- wait briefly for it to be created
    // This handles the race condition during signup where auth fires before Firestore write completes
    state.currentScreen = 'auth-loading';
    renderLoading('Setting up your account...');
    // Retry loading user data after a short delay
    setTimeout(async () => {
      try {
        const firestore = getFirestore();
        const docSnap = await firestore.collection('users').doc(state.currentUser.uid).get();
        if (docSnap.exists) {
          state.userData = docSnap.data();
          await routeApp();
        } else {
          // Still no profile after retry -- sign out
          await signOut();
          state.currentScreen = 'auth-login';
          renderAuthLogin();
          showToast('Account setup failed. Please try again.', 'error');
        }
      } catch (error) {
        console.error('Error loading user profile on retry:', error);
        await signOut();
        state.currentScreen = 'auth-login';
        renderAuthLogin();
        showToast('Error loading account. Please try again.', 'error');
      }
    }, 1500);
    return;
  } else if (!state.userData.role || !state.currentFamily) {
    // Pre-family states all flow through the unified split-screen onboarding:
    // - no role: shows role picker on left, "choose a side" placeholder on right
    // - parent with no family: role picker stays, right shows create-family + invite
    // - sitter with no family: role picker stays, right shows invites/search/code
    state.currentScreen = 'onboarding-split';
    await renderOnboardingSplit();
  } else {
    // User fully set up with family
    if (state.userData.role === 'parent') {
      state.currentScreen = 'parent-dashboard';
      // Subscribe to flagged-entry pushes so parents get instant alerts
      subscribeFlaggedForParent();
      renderParentDashboard();
    } else {
      // Sitter: must start a shift before viewing context-filtered guides
      if (!state.activeShift) {
        state.currentScreen = 'sitter-shift-start';
        renderShiftStartScreen();
      } else {
        state.currentScreen = 'sitter-dashboard';
        renderSitterDashboard();
      }
    }
  }
}

// ============================================================================
// SUBSCRIPTIONS / CLEANUP
// ============================================================================

function cleanupSubscriptions() {
  if (state.messageUnsubscribe) { state.messageUnsubscribe(); state.messageUnsubscribe = null; }
  if (state.shiftLogUnsubscribe) { state.shiftLogUnsubscribe(); state.shiftLogUnsubscribe = null; }
  if (state.flaggedUnsubscribe) { state.flaggedUnsubscribe(); state.flaggedUnsubscribe = null; }
}

async function refreshActiveShift() {
  if (!state.currentFamily) return;
  const result = await getActiveShift(state.currentFamily.id);
  if (result.success && result.data) {
    state.activeShift = result.data;
    state.contextTags = result.data.contextTags || [];
    // Re-compute live context (some tags update with the wall clock)
    const start = result.data.startTime?.toDate?.() || new Date();
    state.contextTags = computeContext(
      new Date(),
      result.data.shiftType,
      undefined,
      result.data.specials || []
    );
  } else {
    state.activeShift = null;
    state.contextTags = [];
  }
}

function subscribeFlaggedForParent() {
  if (!state.currentFamily || state.userData?.role !== 'parent') return;
  if (state.flaggedUnsubscribe) state.flaggedUnsubscribe();
  let lastCount = -1;
  state.flaggedUnsubscribe = subscribeFlagged(state.currentFamily.id, (flagged) => {
    const unack = flagged.filter(f => !f.acknowledged);
    if (lastCount >= 0 && unack.length > lastCount) {
      // New flagged entry came in
      const latest = unack[0];
      showLocalNotification(`Flagged by ${latest.authorName || 'sitter'}`, {
        body: latest.text || 'New flagged moment',
        tag: 'cribnotes-flag',
        data: { type: 'flag', shiftId: latest.shiftId },
        requireInteraction: true
      });
    }
    lastCount = unack.length;
  });
}

// ============================================================================
// SCREEN RENDERING FUNCTIONS
// ============================================================================

function renderSetupRequired() {
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="setup-container">
      <div class="setup-card">
        <h1>One-time Setup</h1>
        <p style="color: var(--color-text-light); margin-bottom: 16px;">
          CribNotes uses Firebase for auth, real-time sync, and storage.
          Connect your project once and the app is fully operational.
        </p>

        <h3 style="color: var(--color-navy); margin-top: 16px;">Steps</h3>
        <ol>
          <li>Open <a href="https://console.firebase.google.com" target="_blank" rel="noopener">Firebase Console</a> and create a project (free tier is fine).</li>
          <li>Under <strong>Authentication</strong> &rarr; Sign-in method, enable <strong>Email/Password</strong> and <strong>Google</strong>.</li>
          <li>Under <strong>Firestore Database</strong>, click Create Database (start in test mode).</li>
          <li>Under <strong>Storage</strong>, click Get Started.</li>
          <li>Open <strong>Project Settings</strong> &rarr; General &rarr; "Your apps" and add a Web app.</li>
          <li>Copy the <code>firebaseConfig</code> object Firebase shows you.</li>
          <li>Open <code>js/config.js</code> and replace the placeholder object with yours.</li>
          <li>Refresh this page.</li>
        </ol>

        <h3 style="color: var(--color-navy); margin-top: 24px;">Need a quick local server?</h3>
        <p style="color: var(--color-text-light); font-size: 0.95em;">
          From a terminal in the <code>cribnotes-app</code> folder, run any of:
        </p>
        <pre style="background: #2C3E6B; color: #fff; padding: 12px; border-radius: 8px; font-size: 0.9em; overflow: auto;">python3 -m http.server 8000</pre>
        <p style="color: var(--color-text-light); font-size: 0.95em;">
          Then visit <a href="http://localhost:8000" target="_blank" rel="noopener">http://localhost:8000</a>.
        </p>

        <p style="margin-top: 16px; color: var(--color-text-light); font-size: 0.85em;">
          See <code>README.md</code> for a more detailed walkthrough.
        </p>
      </div>
    </div>
  `;
}

// ============================================================================
// AUTH SCREENS
// ============================================================================

function renderAuthLogin() {
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <h1>CribNotes</h1>
          <p>Care Guide for Babysitters</p>
        </div>

        <form id="login-form" class="auth-form">
          <input type="email" id="login-email" placeholder="Email" required>
          <input type="password" id="login-password" placeholder="Password" required>
          <button type="submit" class="btn btn-primary">Sign In</button>
        </form>

        <div class="auth-divider">OR</div>

        <button id="google-login-btn" class="btn btn-outline btn-full">
          <span>Sign in with Google</span>
        </button>

        <div class="auth-footer">
          <p>Don't have an account? <a href="#" id="go-to-signup">Sign up</a></p>
          <p><a href="#" id="go-to-reset">Forgot password?</a></p>
        </div>
      </div>
    </div>
  `;

  // Event listeners
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('google-login-btn').addEventListener('click', handleGoogleLogin);
  document.getElementById('go-to-signup').addEventListener('click', async (e) => {
    e.preventDefault();
    // Force sign-out of any cached Firebase session so a fresh sign-up
    // starts cleanly. Firebase persists auth state in localStorage, which
    // can mask a logged-in user behind the login screen.
    try { await signOut(); } catch (err) { /* ignore */ }
    state.currentUser = null;
    state.userData = null;
    state.currentFamily = null;
    state.activeShift = null;
    renderAuthSignup();
  });
  document.getElementById('go-to-reset').addEventListener('click', (e) => {
    e.preventDefault();
    renderPasswordReset();
  });
}

function renderAuthSignup() {
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <h1>Create Account</h1>
          <p>Join CribNotes</p>
        </div>

        <form id="signup-form" class="auth-form">
          <input type="text" id="signup-name" placeholder="Full Name" required>
          <input type="email" id="signup-email" placeholder="Email" required>
          <input type="password" id="signup-password" placeholder="Password" minlength="6" required>
          <input type="password" id="signup-password-confirm" placeholder="Confirm Password" minlength="6" required>
          <button type="submit" class="btn btn-primary">Create Account</button>
        </form>

        <div class="auth-divider">OR</div>

        <button id="google-signup-btn" class="btn btn-outline btn-full">
          <span>Sign up with Google</span>
        </button>

        <div class="auth-footer">
          <p>Already have an account? <a href="#" id="go-to-login">Sign in</a></p>
        </div>
      </div>
    </div>
  `;

  document.getElementById('signup-form').addEventListener('submit', handleSignup);
  document.getElementById('google-signup-btn').addEventListener('click', handleGoogleLogin);
  document.getElementById('go-to-login').addEventListener('click', (e) => {
    e.preventDefault();
    renderAuthLogin();
  });
}

function renderPasswordReset() {
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <h1>Reset Password</h1>
          <p>We'll send a reset link to your email</p>
        </div>

        <form id="reset-form" class="auth-form">
          <input type="email" id="reset-email" placeholder="Email" required>
          <button type="submit" class="btn btn-primary">Send Reset Link</button>
        </form>

        <div class="auth-footer">
          <p><a href="#" id="go-to-login-from-reset">Back to login</a></p>
        </div>
      </div>
    </div>
  `;

  document.getElementById('reset-form').addEventListener('submit', handlePasswordReset);
  document.getElementById('go-to-login-from-reset').addEventListener('click', (e) => {
    e.preventDefault();
    renderAuthLogin();
  });
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  showLoading();

  const result = await signInWithEmail(email, password);
  if (!result.success) {
    showToast(result.error, 'error');
    hideLoading();
  }
  // On success, auth state change listener will route
}

async function handleSignup(e) {
  e.preventDefault();
  const name = document.getElementById('signup-name').value;
  const email = document.getElementById('signup-email').value;
  const password = document.getElementById('signup-password').value;
  const confirm = document.getElementById('signup-password-confirm').value;

  if (password !== confirm) {
    showToast('Passwords do not match', 'error');
    return;
  }

  showLoading();

  const result = await signUpWithEmail(email, password, name, null);
  if (!result.success) {
    showToast(result.error, 'error');
    hideLoading();
  }
  // On success, user will see role selection
}

async function handleGoogleLogin() {
  showLoading();
  const result = await signInWithGoogle();
  if (!result.success) {
    showToast(result.error, 'error');
    hideLoading();
  }
}

async function handlePasswordReset(e) {
  e.preventDefault();
  const email = document.getElementById('reset-email').value;

  showLoading();

  const result = await sendPasswordResetEmail(email);
  if (result.success) {
    showToast('Password reset link sent to your email', 'success');
    setTimeout(() => renderAuthLogin(), 2000);
  } else {
    showToast(result.error, 'error');
  }

  hideLoading();
}

async function handleChangeRole() {
  showLoading();
  const result = await setUserRole(null);
  if (result.success) {
    state.userData.role = null;
    state.currentFamily = null;
    state.activeShift = null;
    hideLoading();
    await routeApp();
  } else {
    showToast(result.error || 'Failed to change role', 'error');
    hideLoading();
  }
}

// ============================================================================
// ONBOARDING — SPLIT SCREEN
// ============================================================================
//
// One screen, two columns. Left column is the role picker that stays put;
// the right column reveals the right next step the moment the user picks a role:
//   - Parent: name your family, then invite sitters by email
//   - Sitter: accept pending invites, search families, or paste invite code
// Mobile collapses to a stacked layout while preserving the same content.

async function renderOnboardingSplit() {
  const root = document.getElementById('app-root');
  const role = state.userData?.role || null;
  const hasFamily = !!state.currentFamily;
  const userName = state.currentUser?.displayName || state.userData?.name || state.currentUser?.email || 'there';

  // Pre-load anything the right-hand panel might need so the render is instant.
  let sitterInvites = [];
  let pendingRequests = [];
  let sentInvites = [];
  if (role === 'babysitter' && !hasFamily) {
    const invs = await listMyFamilyInvites();
    sitterInvites = invs.success ? invs.data : [];
    const reqs = await listMyJoinRequests();
    pendingRequests = (reqs.success ? reqs.data : []).filter(r => r.status === 'pending');
  }
  if (role === 'parent' && hasFamily) {
    const sent = await listFamilyInvitesSent(state.currentFamily.id);
    sentInvites = sent.success ? sent.data : [];
  }

  root.innerHTML = `
    <div class="app-layout onboarding-layout">
      <header class="app-header onboarding-header">
        <h1 class="header-title">CribNotes</h1>
        <button class="btn btn-outline btn-small" id="onboarding-signout">Sign out</button>
      </header>

      <main class="app-content onboarding-content">
        <div class="onboarding-split">

          <!-- LEFT: role picker. Always visible. Currently-selected role highlighted. -->
          <aside class="onboarding-left">
            <span class="eyebrow">Welcome, ${escapeHtml(userName)}</span>
            <h2 class="onboarding-heading">Who are you on CribNotes?</h2>
            <p class="onboarding-sub">
              Pick a role to get started. You can switch later from Settings.
            </p>

            <div class="role-stack">
              <button class="role-tile ${role === 'parent' ? 'is-active' : ''}" data-role="parent">
                <span class="role-icon">👨‍👩‍👧‍👦</span>
                <div class="role-body">
                  <strong>I'm a parent</strong>
                  <small>Create a family, write the care guide, invite sitters</small>
                </div>
                <span class="role-arrow">→</span>
              </button>

              <button class="role-tile ${role === 'babysitter' ? 'is-active' : ''}" data-role="babysitter">
                <span class="role-icon">🧑‍💼</span>
                <div class="role-body">
                  <strong>I'm a babysitter</strong>
                  <small>Join a family, view the guide, log your shift</small>
                </div>
                <span class="role-arrow">→</span>
              </button>
            </div>
          </aside>

          <!-- RIGHT: dynamic next step. Updates based on the selected role. -->
          <section class="onboarding-right" id="onboarding-right">
            ${renderOnboardingRight({ role, hasFamily, sitterInvites, pendingRequests, sentInvites })}
          </section>

        </div>
      </main>
    </div>
  `;

  attachOnboardingHandlers();
}

function renderOnboardingRight({ role, hasFamily, sitterInvites, pendingRequests, sentInvites }) {
  if (!role) {
    return `
      <div class="onboarding-placeholder">
        <span class="eyebrow">Next</span>
        <h2 class="onboarding-heading">Choose a side</h2>
        <p>
          Pick <strong>parent</strong> if you're building the care guide and inviting sitters,
          or <strong>babysitter</strong> if you're joining an existing family.
        </p>
        <div class="placeholder-illustration">🧭</div>
      </div>
    `;
  }

  if (role === 'parent' && !hasFamily) {
    return `
      <div class="onboarding-step">
        <span class="eyebrow">Step 1 of 2</span>
        <h2 class="onboarding-heading">Name your family</h2>
        <p>This is the umbrella every child and sitter sits under. You can rename it any time.</p>
        <form id="parent-family-form" class="onboarding-form">
          <div class="form-group">
            <label for="family-name-input">Family name</label>
            <input type="text" id="family-name-input" placeholder="The Bell Family" required>
          </div>
          <button type="submit" class="btn btn-primary btn-full">Create family</button>
        </form>
      </div>
    `;
  }

  if (role === 'parent' && hasFamily) {
    const family = state.currentFamily;
    return `
      <div class="onboarding-step">
        <span class="eyebrow">Step 2 of 2</span>
        <h2 class="onboarding-heading">Invite your sitter</h2>
        <p>Send an email invite or share your family code. Sitters can also find you by your email.</p>

        <div class="invite-code-card">
          <span class="ic-label">Family code</span>
          <strong class="ic-code">${escapeHtml(family.inviteCode || '------')}</strong>
          <button class="btn btn-small btn-outline" id="copy-code-onboarding">Copy</button>
        </div>

        <form id="parent-invite-form" class="onboarding-form">
          <div class="form-group">
            <label for="invite-sitter-email">Sitter email</label>
            <input type="email" id="invite-sitter-email" placeholder="sitter@example.com">
          </div>
          <div class="form-group">
            <label for="invite-sitter-message">Message (optional)</label>
            <input type="text" id="invite-sitter-message" placeholder="Welcome to the family!">
          </div>
          <button type="submit" class="btn btn-primary btn-full">Send invite</button>
        </form>

        ${sentInvites.length ? `
          <div class="divider"></div>
          <h3 style="font-family: var(--font-display); font-size: 1rem; margin-bottom: 8px;">Pending invitations</h3>
          ${sentInvites.map(i => `
            <div class="jr-row">
              <div class="jr-info">
                <strong>${escapeHtml(i.toSitterEmail)}</strong>
                <small>${i.createdAt?.toDate ? 'sent ' + i.createdAt.toDate().toLocaleDateString() : 'sent recently'}</small>
              </div>
              <div class="jr-actions">
                <button class="btn btn-small btn-outline cancel-invite-ob" data-invite-id="${i.id}" style="color: var(--color-rust); border-color: var(--color-rust);">Cancel</button>
              </div>
            </div>
          `).join('')}
        ` : ''}

        <div class="divider"></div>
        <button class="btn btn-primary btn-full" id="continue-to-dashboard">Continue to dashboard →</button>
      </div>
    `;
  }

  if (role === 'babysitter' && !hasFamily) {
    return `
      <div class="onboarding-step">
        ${sitterInvites.length ? `
          <span class="eyebrow" style="color: var(--color-teal);">You're invited</span>
          <h2 class="onboarding-heading">Accept an invitation</h2>
          <div class="invite-list">
            ${sitterInvites.map(i => `
              <div class="invite-card">
                <div class="invite-card-text">
                  <strong>${escapeHtml(i.familyName || 'Family')}</strong>
                  <small>Invited by ${escapeHtml(i.fromParentName || 'a parent')}</small>
                  ${i.message ? `<p class="jr-msg">"${escapeHtml(i.message)}"</p>` : ''}
                </div>
                <div class="invite-card-actions">
                  <button class="btn btn-small btn-primary invite-accept-ob" data-invite-id="${i.id}">Accept</button>
                  <button class="btn btn-small btn-outline invite-decline-ob" data-invite-id="${i.id}">Decline</button>
                </div>
              </div>
            `).join('')}
          </div>
          <div class="divider"></div>
        ` : `
          <span class="eyebrow">Step 1</span>
          <h2 class="onboarding-heading">Find a family to join</h2>
        `}

        ${pendingRequests.length ? `
          <div class="handoff-note" style="margin-bottom: 1rem;">
            <strong>Pending request</strong><br>
            You've requested to join ${pendingRequests.length} ${pendingRequests.length === 1 ? 'family' : 'families'}. Waiting on the parent.
          </div>
        ` : ''}

        <p>Search by the parent's email, or paste an invite code if you have one.</p>

        <div class="form-group">
          <label for="ob-family-search">Search by parent email</label>
          <input type="text" id="ob-family-search" placeholder="parent@example.com">
        </div>
        <button class="btn btn-outline btn-full" id="ob-search-btn">Search families</button>

        <div id="ob-search-results" style="margin-top: 12px;"></div>

        <div class="divider"></div>

        <form id="ob-invite-code-form" class="onboarding-form">
          <div class="form-group">
            <label for="ob-invite-code">Or enter an invite code</label>
            <input type="text" id="ob-invite-code" placeholder="ABC123" maxlength="6"
              style="text-transform: uppercase; letter-spacing: 0.15em; text-align: center; font-size: 1.1em;">
          </div>
          <button type="submit" class="btn btn-primary btn-full">Join with code</button>
        </form>
      </div>
    `;
  }

  if (role === 'babysitter' && hasFamily) {
    return `
      <div class="onboarding-step">
        <span class="eyebrow">All set</span>
        <h2 class="onboarding-heading">You're in ${escapeHtml(state.currentFamily.name || 'the family')}</h2>
        <p>Continue to start your first shift.</p>
        <button class="btn btn-primary btn-full" id="continue-to-dashboard">Continue →</button>
      </div>
    `;
  }

  return '';
}

function attachOnboardingHandlers() {
  // Sign out
  document.getElementById('onboarding-signout')?.addEventListener('click', async () => {
    await signOut();
  });

  // Role tiles — pick a role
  document.querySelectorAll('.role-tile').forEach(tile => {
    tile.addEventListener('click', async () => {
      const newRole = tile.dataset.role;
      if (state.userData?.role === newRole) return; // already selected
      showLoading();
      const r = await setUserRole(newRole);
      hideLoading();
      if (!r.success) { showToast(r.error || 'Could not set role', 'error'); return; }
      state.userData.role = newRole;
      renderOnboardingSplit();
    });
  });

  // Continue to dashboard
  document.getElementById('continue-to-dashboard')?.addEventListener('click', async () => {
    await routeApp();
  });

  // PARENT: create family form
  document.getElementById('parent-family-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('family-name-input').value.trim();
    if (!name) { showToast('Enter a family name', 'error'); return; }
    showLoading();
    const r = await createFamily(name);
    hideLoading();
    if (!r.success) { showToast(r.error || 'Could not create family', 'error'); return; }
    state.currentFamily = { id: r.familyId, name, inviteCode: r.inviteCode, parentIds: [state.currentUser.uid], sitterIds: [] };
    showToast('Family created!', 'success');
    renderOnboardingSplit();
  });

  // PARENT: invite sitter
  document.getElementById('parent-invite-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('invite-sitter-email').value.trim();
    const message = document.getElementById('invite-sitter-message').value.trim();
    if (!email || !email.includes('@')) { showToast('Enter a valid email', 'error'); return; }
    showLoading();
    const search = await searchSittersByEmail(email);
    const found = search.success ? search.data.find(s => (s.email || '').toLowerCase() === email.toLowerCase()) : null;
    const r = await inviteSitterByEmail(state.currentFamily.id, email, found?.id || null, message);
    hideLoading();
    if (!r.success) { showToast(r.error || 'Could not send invite', 'error'); return; }
    showToast(r.alreadyPending ? 'Already invited' : 'Invitation sent', 'success');
    renderOnboardingSplit();
  });

  // PARENT: cancel a pending invite
  document.querySelectorAll('.cancel-invite-ob').forEach(btn =>
    btn.addEventListener('click', async () => {
      showLoading();
      const r = await cancelFamilyInvite(btn.dataset.inviteId);
      hideLoading();
      if (r.success) renderOnboardingSplit();
      else showToast(r.error || 'Could not cancel', 'error');
    }));

  // PARENT: copy family code
  document.getElementById('copy-code-onboarding')?.addEventListener('click', () => {
    const code = state.currentFamily?.inviteCode;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => showToast('Code copied', 'success'));
  });

  // SITTER: accept/decline invite
  document.querySelectorAll('.invite-accept-ob').forEach(btn =>
    btn.addEventListener('click', async () => {
      showLoading();
      const r = await acceptFamilyInvite(btn.dataset.inviteId);
      hideLoading();
      if (r.success) {
        showToast('Joined family!', 'success');
        state.currentFamily = { id: r.familyId };
        await routeApp();
      } else showToast(r.error || 'Could not accept', 'error');
    }));
  document.querySelectorAll('.invite-decline-ob').forEach(btn =>
    btn.addEventListener('click', async () => {
      showLoading();
      await declineFamilyInvite(btn.dataset.inviteId);
      hideLoading();
      renderOnboardingSplit();
    }));

  // SITTER: search families by parent email
  document.getElementById('ob-search-btn')?.addEventListener('click', async () => {
    const q = document.getElementById('ob-family-search').value.trim();
    if (q.length < 3) { showToast('Type at least 3 characters', 'error'); return; }
    const box = document.getElementById('ob-search-results');
    box.innerHTML = '<p class="text-muted">Searching...</p>';
    const r = await searchFamiliesByParentEmail(q);
    if (!r.success || r.data.length === 0) {
      box.innerHTML = '<p class="text-muted">No families found. Try a different email or use an invite code.</p>';
      return;
    }
    box.innerHTML = r.data.map(f => `
      <div class="search-result-card">
        <div>
          <strong>${escapeHtml(f.name)}</strong>
          <small>${f.parentNames.map(p => escapeHtml(p.name || p.email)).join(', ')}</small>
        </div>
        <button class="btn btn-small btn-primary ob-request-join" data-family-id="${f.id}">Request to join</button>
      </div>
    `).join('');
    document.querySelectorAll('.ob-request-join').forEach(btn =>
      btn.addEventListener('click', async () => {
        showLoading();
        const req = await requestToJoinFamily(btn.dataset.familyId);
        hideLoading();
        if (req.success) {
          showToast(req.alreadyPending ? 'Request already pending' : 'Request sent', 'success');
          renderOnboardingSplit();
        } else showToast(req.error || 'Could not request', 'error');
      }));
  });

  // SITTER: join via invite code
  document.getElementById('ob-invite-code-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('ob-invite-code').value.toUpperCase().trim();
    if (!code) { showToast('Enter an invite code', 'error'); return; }
    showLoading();
    const r = await joinFamilyWithCode(code);
    hideLoading();
    if (!r.success) { showToast(r.error || 'Invalid code', 'error'); return; }
    showToast('Joined family!', 'success');
    state.currentFamily = { id: r.familyId };
    await routeApp();
  });
}

// ============================================================================
// ROLE SELECTION (legacy single-purpose screen, kept for re-pick from settings)
// ============================================================================

function renderRoleSelect() {
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="container container-small">
      <div class="card">
        <h1>Welcome, ${state.currentUser.displayName || state.currentUser.email}!</h1>
        <p>What is your role?</p>

        <div class="role-selection">
          <button class="role-card" id="select-parent">
            <div class="role-icon">👨‍👩‍👧‍👦</div>
            <h2>Parent/Guardian</h2>
            <p>Create and manage care guides for your children</p>
          </button>

          <button class="role-card" id="select-sitter">
            <div class="role-icon">🧑‍💼</div>
            <h2>Babysitter</h2>
            <p>Access care guides and communicate with parents</p>
          </button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('select-parent').addEventListener('click', async () => {
    showLoading();
    const result = await setUserRole('parent');
    if (!result.success) {
      showToast(result.error, 'error');
      hideLoading();
    } else {
      state.userData.role = 'parent';
      hideLoading();
      await routeApp();
    }
  });

  document.getElementById('select-sitter').addEventListener('click', async () => {
    showLoading();
    const result = await setUserRole('babysitter');
    if (!result.success) {
      showToast(result.error, 'error');
      hideLoading();
    } else {
      state.userData.role = 'babysitter';
      hideLoading();
      await routeApp();
    }
  });
}

// ============================================================================
// PARENT ONBOARDING
// ============================================================================

function renderParentOnboarding() {
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="container container-small">
      <div class="card">
        <h1>Create Your Family</h1>
        <p>Let's get started by creating a family profile</p>

        <form id="family-form" class="form">
          <div class="form-group">
            <label for="family-name">Family Name</label>
            <input type="text" id="family-name" placeholder="The Smith Family" required>
          </div>
          <button type="submit" class="btn btn-primary btn-full">Create Family</button>
        </form>

        <div class="divider"></div>

        <button id="change-role-btn" class="btn btn-outline btn-full">Change Role</button>
      </div>
    </div>
  `;

  document.getElementById('family-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const familyName = document.getElementById('family-name').value;

    showLoading();
    const result = await createFamily(familyName);
    if (!result.success) {
      showToast(result.error, 'error');
      hideLoading();
    } else {
      state.currentFamily = {
        id: result.familyId,
        name: familyName,
        inviteCode: result.inviteCode
      };
      showToast('Family created!', 'success');
      hideLoading();
      await routeApp();
    }
  });

  document.getElementById('change-role-btn').addEventListener('click', handleChangeRole);
}

// ============================================================================
// SITTER ONBOARDING
// ============================================================================

async function renderSitterOnboarding() {
  const root = document.getElementById('app-root');

  // Pending join requests THIS user initiated
  const myReqs = await listMyJoinRequests();
  const pending = (myReqs.success ? myReqs.data : []).filter(r => r.status === 'pending');

  // Pending family invites SENT TO this user (parent-initiated)
  const invitesResult = await listMyFamilyInvites();
  const invites = invitesResult.success ? invitesResult.data : [];

  root.innerHTML = `
    <div class="container container-small">
      <div class="card">
        <h1 style="font-family: var(--font-display); font-size: 2.25rem; letter-spacing: -0.025em;">Join a family</h1>
        <p style="color: var(--color-text-light); margin-bottom: 1.5rem;">
          Accept a family invite, search by parent email, or paste an invite code.
        </p>

        ${invites.length ? `
          <div class="join-requests-banner" style="border-color: var(--color-teal); margin-bottom: 1rem;">
            <div class="jr-header">
              <span class="eyebrow" style="color: var(--color-teal);">You're invited</span>
              <h3>${invites.length} pending invitation${invites.length === 1 ? '' : 's'}</h3>
            </div>
            ${invites.map(i => `
              <div class="jr-row" data-invite-id="${i.id}">
                <div class="jr-info">
                  <strong>${escapeHtml(i.familyName || 'Family')}</strong>
                  <small>Invited by ${escapeHtml(i.fromParentName || 'a parent')}</small>
                  ${i.message ? `<p class="jr-msg">"${escapeHtml(i.message)}"</p>` : ''}
                </div>
                <div class="jr-actions">
                  <button class="btn btn-small btn-primary invite-accept" data-invite-id="${i.id}">Accept</button>
                  <button class="btn btn-small btn-outline invite-decline" data-invite-id="${i.id}">Decline</button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${pending.length ? `
          <div class="handoff-note" style="margin-bottom: 1rem;">
            <strong>Pending request</strong><br>
            You've requested to join ${pending.length} ${pending.length === 1 ? 'family' : 'families'}. Waiting for approval.
          </div>
        ` : ''}

        <div class="form-group">
          <label for="family-search">Search by parent email</label>
          <input type="text" id="family-search" placeholder="parent@example.com">
        </div>
        <button id="search-families-btn" class="btn btn-outline btn-full">Search families</button>

        <div id="search-results" style="margin-top: 1rem;"></div>

        <div class="divider"></div>

        <form id="invite-form" class="form">
          <div class="form-group">
            <label for="invite-code">Or enter an invite code</label>
            <input type="text" id="invite-code" placeholder="e.g., ABC123" maxlength="6"
              style="text-transform: uppercase; letter-spacing: 0.15em; font-size: 1.2em; text-align: center;">
          </div>
          <button type="submit" class="btn btn-primary btn-full">Join with code</button>
        </form>

        <div class="divider"></div>

        <button id="change-role-btn" class="btn btn-outline btn-full">Change Role</button>
        <button id="logout-btn" class="btn btn-outline btn-full" style="margin-top: 0.5rem;">Sign Out</button>
      </div>
    </div>
  `;

  // Invite code path (existing behavior)
  document.getElementById('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('invite-code').value.toUpperCase();
    if (!code) {
      showToast('Enter an invite code first', 'error');
      return;
    }
    showLoading();
    const result = await joinFamilyWithCode(code);
    if (!result.success) {
      showToast(result.error || 'Invalid invite code', 'error');
      hideLoading();
    } else {
      showToast('Joined family!', 'success');
      state.currentFamily = { id: result.familyId };
      hideLoading();
      await routeApp();
    }
  });

  // Family search path
  document.getElementById('search-families-btn').addEventListener('click', async () => {
    const q = document.getElementById('family-search').value.trim();
    if (!q || q.length < 3) {
      showToast('Type at least 3 characters of the parent email', 'error');
      return;
    }
    const resultsBox = document.getElementById('search-results');
    resultsBox.innerHTML = '<p class="text-muted">Searching...</p>';
    const result = await searchFamiliesByParentEmail(q);
    if (!result.success) {
      resultsBox.innerHTML = `<p class="text-muted">${escapeHtml(result.error || 'No families found')}</p>`;
      return;
    }
    if (result.data.length === 0) {
      resultsBox.innerHTML = '<p class="text-muted">No families found. Try a different email or use an invite code.</p>';
      return;
    }
    resultsBox.innerHTML = result.data.map(f => `
      <div class="card" style="margin-bottom: 8px; padding: 14px;">
        <h3 style="font-family: var(--font-display); margin: 0 0 4px; font-size: 1.1rem;">${escapeHtml(f.name)}</h3>
        <p class="text-muted" style="font-size: 0.85rem; margin: 0 0 10px;">
          ${f.parentNames.map(p => escapeHtml(p.name || p.email)).join(', ')}
        </p>
        <button class="btn btn-small btn-primary request-join-btn" data-family-id="${f.id}">Request to join</button>
      </div>
    `).join('');

    document.querySelectorAll('.request-join-btn').forEach(btn =>
      btn.addEventListener('click', async () => {
        showLoading();
        const r = await requestToJoinFamily(btn.dataset.familyId);
        hideLoading();
        if (r.success) {
          if (r.alreadyPending) showToast('Already requested. Waiting on the parent.', 'info');
          else showToast('Request sent. The parent will see it on their dashboard.', 'success');
          // Re-render to show pending state
          renderSitterOnboarding();
        } else {
          showToast(r.error || 'Could not send request', 'error');
        }
      }));
  });

  // Accept / decline family invitations sent BY a parent
  document.querySelectorAll('.invite-accept').forEach(btn =>
    btn.addEventListener('click', async () => {
      showLoading();
      const r = await acceptFamilyInvite(btn.dataset.inviteId);
      hideLoading();
      if (r.success) {
        showToast('Joined family!', 'success');
        state.currentFamily = { id: r.familyId };
        await routeApp();
      } else {
        showToast(r.error || 'Could not accept', 'error');
      }
    }));
  document.querySelectorAll('.invite-decline').forEach(btn =>
    btn.addEventListener('click', async () => {
      showLoading();
      const r = await declineFamilyInvite(btn.dataset.inviteId);
      hideLoading();
      if (r.success) { showToast('Invitation declined', 'info'); renderSitterOnboarding(); }
      else showToast(r.error || 'Could not decline', 'error');
    }));

  document.getElementById('change-role-btn').addEventListener('click', handleChangeRole);

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await signOut();
  });
}

// ============================================================================
// PARENT DASHBOARD
// ============================================================================

async function renderParentDashboard() {
  const root = document.getElementById('app-root');

  // Load children
  const childrenResult = await getChildren(state.currentFamily.id);
  const children = childrenResult.success ? childrenResult.data : [];

  // Load any pending sitter join requests so the parent sees them up top
  const reqResult = await listFamilyJoinRequests(state.currentFamily.id);
  const joinRequests = reqResult.success ? reqResult.data : [];

  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <div class="header-left">
          <button class="btn-icon" id="menu-btn" title="Menu">☰</button>
          <h1 class="header-title">CribNotes</h1>
        </div>
        <div class="header-right">
          <input type="text" id="search-input" placeholder="Search..." class="search-input">
        </div>
      </header>

      <main class="app-content">
        <div class="container">
          <div class="section-header">
            <h2>Welcome, ${escapeHtml(state.userData.name)}!</h2>
            <p>${escapeHtml(state.currentFamily.name)}</p>
          </div>

          ${joinRequests.length ? `
            <div class="join-requests-banner">
              <div class="jr-header">
                <span class="eyebrow">Pending requests</span>
                <h3>${joinRequests.length} sitter${joinRequests.length === 1 ? '' : 's'} want${joinRequests.length === 1 ? 's' : ''} to join</h3>
              </div>
              ${joinRequests.map(r => `
                <div class="jr-row" data-request-id="${r.id}">
                  <div class="jr-info">
                    <strong>${escapeHtml(r.sitterName || 'Sitter')}</strong>
                    <small>${escapeHtml(r.sitterEmail || '')}</small>
                    ${r.message ? `<p class="jr-msg">"${escapeHtml(r.message)}"</p>` : ''}
                  </div>
                  <div class="jr-actions">
                    <button class="btn btn-small btn-primary jr-approve" data-request-id="${r.id}">Approve</button>
                    <button class="btn btn-small btn-outline jr-decline" data-request-id="${r.id}">Decline</button>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : ''}

          <div class="quick-actions">
            <button class="action-btn" id="messages-btn">
              <span class="icon">💬</span>
              <span>Messages</span>
            </button>
            <button class="action-btn" id="settings-btn">
              <span class="icon">⚙️</span>
              <span>Settings</span>
            </button>
          </div>

          ${children.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">👶</div>
              <h3>No children yet</h3>
              <p>Add your first child to get started</p>
              <button class="btn btn-primary" id="add-child-btn">Add Child</button>
            </div>
          ` : `
            <div class="section">
              <div class="section-title">
                <h3>Your Children</h3>
                <button class="btn-icon" id="add-child-btn">+</button>
              </div>
              <div class="children-grid">
                ${children.map(child => `
                  <div class="child-card" data-child-id="${child.id}">
                    <div class="child-avatar">${child.avatar || '👶'}</div>
                    <h4>${child.name}</h4>
                    <p>Age ${child.age}</p>
                    <button class="btn btn-small btn-outline" onclick="viewChildGuide('${child.id}')">View Guide</button>
                  </div>
                `).join('')}
              </div>
            </div>
          `}
        </div>
      </main>

      <nav class="bottom-nav">
        <button class="nav-item active" data-screen="home">
          <span class="icon">🏠</span>
          <span>Home</span>
        </button>
        <button class="nav-item" data-screen="guide">
          <span class="icon">📖</span>
          <span>Guide</span>
        </button>
        <button class="nav-item" data-screen="messages">
          <span class="icon">💬</span>
          <span>Messages</span>
        </button>
        <button class="nav-item" data-screen="lists">
          <span class="icon">✓</span>
          <span>Lists</span>
        </button>
        <button class="nav-item" data-screen="photos">
          <span class="icon">📸</span>
          <span>Photos</span>
        </button>
      </nav>
    </div>
  `;

  // Event listeners
  document.getElementById('messages-btn')?.addEventListener('click', () => {
    renderMessagesScreen();
  });

  document.getElementById('settings-btn')?.addEventListener('click', () => {
    renderParentSettings();
  });

  document.getElementById('add-child-btn')?.addEventListener('click', () => {
    renderAddChildForm();
  });

  // Sitter join requests: approve / decline
  document.querySelectorAll('.jr-approve').forEach(btn =>
    btn.addEventListener('click', async () => {
      showLoading();
      const r = await approveJoinRequest(btn.dataset.requestId);
      hideLoading();
      if (r.success) {
        showToast('Sitter added to your family', 'success');
        renderParentDashboard();
      } else {
        showToast(r.error || 'Could not approve', 'error');
      }
    }));
  document.querySelectorAll('.jr-decline').forEach(btn =>
    btn.addEventListener('click', async () => {
      showLoading();
      const r = await declineJoinRequest(btn.dataset.requestId);
      hideLoading();
      if (r.success) {
        showToast('Request declined', 'info');
        renderParentDashboard();
      } else {
        showToast(r.error || 'Could not decline', 'error');
      }
    }));

  document.getElementById('search-input')?.addEventListener('input', async (e) => {
    if (e.target.value.length < 2) return;
    await renderSearchResults(e.target.value);
  });

  document.getElementById('menu-btn')?.addEventListener('click', () => {
    renderParentSettings();
  });

  // Bottom nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const screen = btn.dataset.screen;
      if (screen === 'home') renderParentDashboard();
      else if (screen === 'messages') renderMessagesScreen();
      else if (screen === 'photos') renderPhotosScreen();
      // Guide and lists will need child context
    });
  });

  hideLoading();
}

// ============================================================================
// SITTER DASHBOARD
// ============================================================================

async function renderSitterDashboard() {
  const root = document.getElementById('app-root');

  // Refresh active shift in case it ended elsewhere
  await refreshActiveShift();
  if (!state.activeShift) {
    return renderShiftStartScreen();
  }

  // Load children for the family
  const childrenResult = await getChildren(state.currentFamily.id);
  const children = childrenResult.success ? childrenResult.data : [];

  // Load medication status across the family for the home banner
  let dueCount = 0;
  for (const c of children) {
    const r = await getMedicationStatus(state.currentFamily.id, c.id);
    if (r.success) dueCount += r.data.due.length;
  }

  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <div class="header-left">
          <button class="btn-icon" id="menu-btn" title="Menu">☰</button>
          <h1 class="header-title">CribNotes</h1>
        </div>
        <div class="header-right">
          <input type="text" id="search-input" placeholder="Search..." class="search-input">
        </div>
      </header>

      ${renderContextBanner()}

      <main class="app-content">
        <div class="container">
          <div class="section-header">
            <h2>Welcome, ${escapeHtml(state.userData.name)}!</h2>
            <p>${escapeHtml(state.currentFamily.name)} &middot; Shift started ${formatTime(state.activeShift.startTime)}</p>
          </div>

          ${dueCount > 0 ? `
            <div class="med-due-banner">
              <strong>${dueCount} medication${dueCount > 1 ? 's' : ''} due now</strong>
              <button class="btn btn-small" id="meds-due-btn">Review</button>
            </div>` : ''}

          ${state.activeShift.startNote ? `
            <div class="handoff-note">
              <strong>Handoff note:</strong> ${escapeHtml(state.activeShift.startNote)}
            </div>` : ''}

          <div class="quick-actions">
            <button class="action-btn" id="log-btn">
              <span class="icon">📍</span>
              <span>Quick Log</span>
            </button>
            <button class="action-btn" id="messages-btn">
              <span class="icon">💬</span>
              <span>Chat</span>
            </button>
          </div>

          ${children.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">👶</div>
              <h3>Waiting for setup</h3>
              <p>The parent will add children soon</p>
            </div>
          ` : `
            <div class="section">
              <h3>Children in Care</h3>
              <div class="children-grid">
                ${children.map(child => `
                  <div class="child-card" data-child-id="${child.id}">
                    <div class="child-avatar">${child.avatar || '👶'}</div>
                    <h4>${escapeHtml(child.name)}</h4>
                    <p>Age ${escapeHtml(String(child.age))}</p>
                    <button class="btn btn-small btn-primary" onclick="viewChildGuide('${child.id}')">View Care Guide</button>
                  </div>
                `).join('')}
              </div>
            </div>
          `}
        </div>
      </main>

      ${renderSitterBottomNav('home')}
    </div>
  `;

  document.getElementById('messages-btn')?.addEventListener('click', renderMessagesScreen);
  document.getElementById('log-btn')?.addEventListener('click', renderShiftLogScreen);
  document.getElementById('meds-due-btn')?.addEventListener('click', () => {
    if (children.length) renderMedicationsScreen(children[0].id);
  });

  document.getElementById('search-input')?.addEventListener('input', async (e) => {
    if (e.target.value.length < 2) return;
    await renderSearchResults(e.target.value);
  });

  document.getElementById('menu-btn')?.addEventListener('click', renderSitterSettings);

  attachSitterBottomNavHandlers();
  attachContextBannerHandlers();
  mountEmergencyButton();
  hideLoading();
}

// ============================================================================
// CHILD CARE GUIDE
// ============================================================================

async function viewChildGuide(childId) {
  state.currentChild = childId;
  const childResult = await getChild(state.currentFamily.id, childId);

  if (!childResult.success) {
    showToast('Error loading child', 'error');
    return;
  }

  const child = childResult.data;
  const guideResult = await getCareGuide(state.currentFamily.id, childId);
  const rawGuide = guideResult.success ? guideResult.data : {};
  // Apply the context filter for sitters (parents always see everything)
  const guide = applyContextFilter(rawGuide);

  const isParent = state.userData.role === 'parent';
  const root = document.getElementById('app-root');

  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">${escapeHtml(child.name)}'s Guide</h1>
        <button class="btn-icon" id="more-btn">⋯</button>
      </header>

      ${renderContextBanner()}

      <main class="app-content">
        <div class="container">
          ${renderCriticalInfoCard(child)}

          ${isParent ? `
          <div class="guide-action-buttons">
            <button id="dictate-guide-btn" class="dictate-banner-btn">
              <span class="dictate-banner-icon">🎤</span>
              <span class="dictate-banner-text">
                <strong>Dictate Care Guide</strong>
                <small>Speak and auto-organize into sections</small>
              </span>
            </button>
            <button id="upload-doc-btn" class="dictate-banner-btn upload-banner-btn">
              <span class="dictate-banner-icon">📄</span>
              <span class="dictate-banner-text">
                <strong>Upload Instructions</strong>
                <small>Import from PDF or Word doc</small>
              </span>
            </button>
            <button id="critical-info-btn" class="dictate-banner-btn critical-banner-btn">
              <span class="dictate-banner-icon">🛡️</span>
              <span class="dictate-banner-text">
                <strong>Edit Critical Info</strong>
                <small>Allergies, meds, insurance &amp; pediatrician</small>
              </span>
            </button>
            <button id="meds-btn" class="dictate-banner-btn meds-banner-btn">
              <span class="dictate-banner-icon">💊</span>
              <span class="dictate-banner-text">
                <strong>Medication Schedule</strong>
                <small>Add scheduled and as-needed meds</small>
              </span>
            </button>
          </div>
          <input type="file" id="doc-file-input" accept=".pdf,.docx,.doc,.txt" style="display: none;">
          ` : `
          <div class="guide-action-buttons">
            <button id="meds-btn" class="dictate-banner-btn meds-banner-btn">
              <span class="dictate-banner-icon">💊</span>
              <span class="dictate-banner-text">
                <strong>Medications</strong>
                <small>See schedule and record doses</small>
              </span>
            </button>
            <button id="log-btn" class="dictate-banner-btn">
              <span class="dictate-banner-icon">📍</span>
              <span class="dictate-banner-text">
                <strong>Shift Log</strong>
                <small>Quick statuses, notes, flag moments</small>
              </span>
            </button>
          </div>
          `}

          <div class="tabs">
            ${getGuideSections().map(section => `
              <button class="tab-btn" data-section="${section}">
                ${getSectionLabel(section)}
                ${(rawGuide[section] || []).length !== (guide[section] || []).length
                  ? `<span class="tab-filtered-count">${(guide[section] || []).length}/${(rawGuide[section] || []).length}</span>`
                  : ''}
              </button>
            `).join('')}
          </div>

          <div id="guide-sections">
            ${getGuideSections().map(sectionKey => `
              <div class="section-content" data-section="${sectionKey}" style="display: none;">
                <div class="section-header">
                  <h2>${getSectionLabel(sectionKey)}</h2>
                  ${isParent ? `<button class="btn-icon" onclick="editGuideSection('${sectionKey}')">✏️</button>` : ''}
                </div>
                <div class="guide-items">
                  ${(guide[sectionKey] || []).length === 0 ? `
                    <p class="text-muted">${state.userData.role === 'babysitter' && !state.contextOverride && (rawGuide[sectionKey] || []).length > 0
                      ? 'Nothing in this context. Tap "Show all" above to see all notes.'
                      : 'No information added yet'}</p>
                  ` : `
                    <ul class="guide-list">
                      ${(guide[sectionKey] || []).map(item => {
                        const text = typeof item === 'string' ? item : (item.text || '');
                        const tags = (typeof item === 'object' && Array.isArray(item.tags)) ? item.tags : [];
                        return `
                          <li>
                            <span class="guide-text">${escapeHtml(text)}</span>
                            ${tags.length ? `<span class="tag-row">${tags.map(t => `<span class="tag-badge tag-${tagBadgeColor(t)}">${escapeHtml(t.replace(/-/g, ' '))}</span>`).join('')}</span>` : ''}
                          </li>
                        `;
                      }).join('')}
                    </ul>
                  `}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </main>

      <nav class="bottom-nav">
        <button class="nav-item" onclick="viewChildGuide('${childId}')">
          <span class="icon">📖</span>
          <span>Guide</span>
        </button>
        <button class="nav-item" onclick="renderChildChecklists('${childId}')">
          <span class="icon">✓</span>
          <span>Lists</span>
        </button>
        <button class="nav-item" onclick="renderChildPhotos('${childId}')">
          <span class="icon">📸</span>
          <span>Photos</span>
        </button>
        <button class="nav-item" onclick="${isParent ? `renderParentDashboard()` : `renderSitterDashboard()`}">
          <span class="icon">🏠</span>
          <span>Home</span>
        </button>
      </nav>
    </div>
  `;

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.section-content').forEach(s => s.style.display = 'none');

      btn.classList.add('active');
      document.querySelector(`.section-content[data-section="${btn.dataset.section}"]`).style.display = 'block';
    });
  });

  // Show first tab
  document.querySelector('.tab-btn')?.click();

  document.getElementById('back-btn')?.addEventListener('click', async () => {
    if (state.userData.role === 'parent') {
      renderParentDashboard();
    } else {
      renderSitterDashboard();
    }
  });

  document.getElementById('dictate-guide-btn')?.addEventListener('click', () => {
    renderDictationScreen(childId);
  });

  // Upload document handler
  document.getElementById('upload-doc-btn')?.addEventListener('click', () => {
    document.getElementById('doc-file-input')?.click();
  });

  document.getElementById('doc-file-input')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleDocumentUpload(file, childId, child);
  });

  document.getElementById('more-btn')?.addEventListener('click', () => {
    renderChildMenu(childId);
  });

  document.getElementById('critical-info-btn')?.addEventListener('click', () => {
    renderEditCriticalInfoForm(childId, child.critical || {});
  });

  document.getElementById('meds-btn')?.addEventListener('click', () => {
    renderMedicationsScreen(childId);
  });

  document.getElementById('log-btn')?.addEventListener('click', renderShiftLogScreen);

  attachContextBannerHandlers();
  mountEmergencyButton();
}

function renderChildMenu(childId) {
  const isParent = state.userData.role === 'parent';
  showModal(`
    <h3>Options</h3>
    ${isParent ? `
      <button class="btn btn-full" onclick="renderEditChildForm('${childId}')">Edit Child</button>
      <button class="btn btn-full" onclick="clearGuideConfirm('${childId}')" style="color: #e76f51;">Clear Care Guide</button>
      <button class="btn btn-full" onclick="deleteChildConfirm('${childId}')" style="color: #c0392b;">Delete Child</button>
    ` : ''}
    <button class="btn btn-outline btn-full" onclick="closeModal()">Close</button>
  `);
}

async function deleteChildConfirm(childId) {
  closeModal();
  if (confirm('Delete this child and all their data?')) {
    showLoading();
    const result = await deleteChild(state.currentFamily.id, childId);
    if (!result.success) {
      showToast(result.error, 'error');
      hideLoading();
    } else {
      showToast('Child deleted', 'success');
      renderParentDashboard();
    }
  }
}

async function clearGuideConfirm(childId) {
  closeModal();
  showModal(`
    <h3>Clear Care Guide</h3>
    <p>This will remove all care guide entries for this child. This cannot be undone.</p>
    <div style="display: flex; gap: 8px; margin-top: 20px;">
      <button class="btn btn-primary" id="confirm-clear-guide-btn" style="flex: 1; background: #e76f51;">Clear Everything</button>
      <button class="btn btn-outline" onclick="closeModal()" style="flex: 1;">Cancel</button>
    </div>
  `);
  document.getElementById('confirm-clear-guide-btn')?.addEventListener('click', async () => {
    closeModal();
    showLoading();
    try {
      const result = await clearCareGuide(state.currentFamily.id, childId);
      hideLoading();
      if (result.success) {
        showToast('Care guide cleared', 'success');
        viewChildGuide(childId);
      } else {
        showToast('Failed to clear guide: ' + result.error, 'error');
      }
    } catch (err) {
      hideLoading();
      showToast('Error: ' + err.message, 'error');
    }
  });
}

async function editGuideSection(sectionKey) {
  const child = await getChild(state.currentFamily.id, state.currentChild);
  const guide = await getCareGuide(state.currentFamily.id, state.currentChild);

  const items = (guide.data ? guide.data[sectionKey] : []) || [];
  // Render each item on its own line. Append "[tag1, tag2]" so the parent
  // can edit tags inline. Items without tags render as plain text.
  const itemsText = items.map(item => {
    if (typeof item === 'string') return item;
    const tags = Array.isArray(item.tags) && item.tags.length
      ? `  [${item.tags.join(', ')}]` : '';
    return `${item.text || ''}${tags}`;
  }).join('\n');

  showModal(`
    <h3>Edit ${escapeHtml(getSectionLabel(sectionKey))}</h3>
    <p style="font-size: 0.85em; color: var(--color-text-light); margin-bottom: 8px;">
      One item per line. Add context tags in brackets at the end:<br>
      <code>Bath at 7pm  [evening, bedtime, weekday]</code>
    </p>
    <textarea id="edit-items" rows="10" class="form-input">${escapeHtml(itemsText)}</textarea>
    <details style="margin-top: 8px; font-size: 0.85em;">
      <summary>Available tags</summary>
      <div style="margin-top: 6px;">
        <strong>Day:</strong> ${DAY_TAGS.join(', ')}<br>
        <strong>Time:</strong> ${TIME_TAGS.join(', ')}<br>
        <strong>Shift:</strong> ${SHIFT_TAGS.join(', ')}<br>
        <strong>Special:</strong> ${SPECIAL_TAGS.join(', ')}
      </div>
    </details>
    <div style="display: flex; gap: 8px; margin-top: 16px;">
      <button class="btn btn-primary" onclick="saveGuideSection('${sectionKey}')">Save</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function saveGuideSection(sectionKey) {
  const text = document.getElementById('edit-items')?.value || '';
  const lines = text.split('\n').map(s => s.trim()).filter(s => s.length > 0);

  // Parse "text [tag1, tag2]" into { text, tags }; pure text becomes a string.
  const items = lines.map(line => {
    const m = line.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
    if (!m) return line;
    const itemText = m[1].trim();
    const tags = m[2].split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    return { text: itemText, tags };
  });

  showLoading();
  closeModal();

  const result = await updateGuideSection(state.currentFamily.id, state.currentChild, sectionKey, items);
  if (!result.success) {
    showToast(result.error, 'error');
    hideLoading();
  } else {
    showToast('Guide updated', 'success');
    viewChildGuide(state.currentChild);
  }
}

// ============================================================================
// DICTATION SCREEN
// ============================================================================

async function renderDictationScreen(childId) {
  if (!isSpeechRecognitionAvailable()) {
    showToast('Speech recognition not supported on this browser', 'error');
    return;
  }

  state.currentChild = childId;
  const child = await getChild(state.currentFamily.id, childId);
  if (!child.success) {
    showToast('Error loading child', 'error');
    return;
  }

  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">Dictate for ${child.data.name}</h1>
      </header>

      <main class="app-content dictation-screen">
        <div class="container">
          <div class="dictation-card">
            <p style="text-align: center; color: #666; margin-bottom: 1rem;">
              Talk about ${child.data.name}'s care and I'll organize it into the right sections automatically.
            </p>

            <div id="mic-area" style="text-align: center; margin: 1.5rem 0;">
              <button id="start-btn" class="mic-button">
                <span class="mic-icon">🎤</span>
                <span>Start Dictation</span>
              </button>

              <div id="recording-area" style="display: none;">
                <div class="recording-status">
                  <div class="pulse-dot"></div>
                  <span>Listening...</span>
                </div>
                <button id="stop-btn" class="btn btn-primary" style="margin-top: 1rem; background: #e74c3c; min-width: 180px; padding: 12px 24px; font-size: 1.1em;">
                  Stop Dictation
                </button>
              </div>
            </div>

            <div id="transcript-display" class="transcript-display" style="min-height: 60px;">
              <p id="final-text" class="final-text" style="white-space: pre-wrap;"></p>
              <p id="interim-text" class="interim-text" style="color: #999; font-style: italic;"></p>
            </div>

            <div id="organized-results" style="display: none; margin-top: 1.5rem;">
              <h4 style="margin-bottom: 0.75rem;">Organized into sections:</h4>
              <div id="results-list"></div>
              <div style="display: flex; gap: 8px; margin-top: 1.5rem;">
                <button class="btn btn-primary" id="save-all-btn" style="flex: 1;">Save All to Guide</button>
                <button class="btn btn-outline" id="retake-btn">Redo</button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  `;

  let isRecording = false;
  let finalTranscript = '';
  let organizedItems = {};

  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const recordingArea = document.getElementById('recording-area');
  const finalText = document.getElementById('final-text');
  const interimText = document.getElementById('interim-text');
  const organizedResults = document.getElementById('organized-results');
  const resultsList = document.getElementById('results-list');

  // Start dictation
  startBtn.addEventListener('click', async () => {
    if (isRecording) return;
    isRecording = true;
    startBtn.style.display = 'none';
    recordingArea.style.display = 'block';
    finalText.textContent = '';
    interimText.textContent = '';
    organizedResults.style.display = 'none';

    try {
      const result = await startDictation();
      if (result.success) {
        // Use the returned transcript, or fall back to whatever text was displayed on screen
        finalTranscript = result.transcript || finalText.textContent || window._lastDictationText || '';
        isRecording = false;
        recordingArea.style.display = 'none';
        startBtn.style.display = 'inline-flex';
        interimText.textContent = '';

        console.log('[CribNotes] Dictation result transcript length:', result.transcript?.length, 'Final used:', finalTranscript.length);

        if (finalTranscript.trim().length > 0) {
          finalText.textContent = finalTranscript;
          showOrganizedResults(finalTranscript);
        } else {
          showToast('No speech detected. Try again.', 'info');
        }
      }
    } catch (error) {
      isRecording = false;
      recordingArea.style.display = 'none';
      startBtn.style.display = 'inline-flex';
      showToast(error.message, 'error');
    }
  });

  // Stop dictation
  stopBtn.addEventListener('click', () => {
    stopDictation();
  });

  // Live transcript updates
  const dictationHandler = (e) => {
    if (e.detail.final) {
      finalText.textContent = e.detail.final;
    }
    if (e.detail.interim) {
      interimText.textContent = e.detail.interim;
    } else {
      interimText.textContent = '';
    }
  };
  window.addEventListener('dictationUpdate', dictationHandler);

  // Organize transcript into guide sections
  async function showOrganizedResults(transcript) {
    // Show processing indicator
    resultsList.innerHTML = `
      <div style="text-align: center; padding: 20px; color: #666;">
        <div style="font-size: 1.5em; margin-bottom: 8px;">Organizing your notes...</div>
        <div style="font-size: 0.9em;">Cleaning up and categorizing</div>
      </div>
    `;
    organizedResults.style.display = 'block';

    try {
      // Process transcript through AI or smart cleanup
      const result = await processTranscript(transcript, child.data.name);
      console.log('[CribNotes] Processed result:', JSON.stringify(result));

      organizedItems = result.sections || {};

      if (Object.keys(organizedItems).length === 0) {
        resultsList.innerHTML = `<p style="color: #666; text-align: center;">Could not organize the text. Try dictating again with more detail.</p>`;
        return;
      }

      // Render polished results
      resultsList.innerHTML = Object.entries(organizedItems).map(([section, items]) => `
        <div style="background: #f8f9fa; border-radius: 8px; padding: 12px; margin-bottom: 8px;">
          <strong style="color: #1a365d;">${getSectionLabel(section)}</strong>
          <ul style="margin: 8px 0 0 16px; padding: 0; list-style: none;">
            ${items.map(item => `<li style="margin: 6px 0; color: #333; padding-left: 12px; border-left: 3px solid #e76f51; line-height: 1.4;">${item}</li>`).join('')}
          </ul>
        </div>
      `).join('');
    } catch (error) {
      console.error('[CribNotes] Processing error:', error);
      resultsList.innerHTML = `<p style="color: #e74c3c;">Error processing text: ${error.message}</p>`;
    }
  }

  // Save all organized items to guide
  document.getElementById('save-all-btn')?.addEventListener('click', async () => {
    if (Object.keys(organizedItems).length === 0) {
      showToast('Nothing to save', 'error');
      return;
    }

    showLoading();
    let savedCount = 0;
    let errorCount = 0;
    let lastError = '';

    console.log('[CribNotes] Saving to family:', state.currentFamily.id, 'child:', childId);
    console.log('[CribNotes] Items to save:', JSON.stringify(organizedItems));

    // Ensure the care guide doc exists before trying arrayUnion
    const guideCheck = await getCareGuide(state.currentFamily.id, childId);
    console.log('[CribNotes] Guide doc check:', guideCheck.success);

    for (const [section, items] of Object.entries(organizedItems)) {
      for (const item of items) {
        try {
          // Auto-attach inferred context tags from the item text. The parent
          // can fine-tune later by editing the section.
          const text = typeof item === 'string' ? item : item.text;
          const tags = inferTagsFromText(text);
          const tagged = tags.length ? { text, tags } : text;
          console.log('[CribNotes] Saving item to section:', section, 'tags:', tags);
          const result = await addGuideItem(state.currentFamily.id, childId, section, tagged);
          if (result.success) {
            savedCount++;
          } else {
            errorCount++;
            lastError = result.error || 'Unknown error';
            console.error('[CribNotes] Save failed:', result.error);
          }
        } catch (err) {
          errorCount++;
          lastError = err.message;
          console.error('[CribNotes] Save exception:', err);
        }
      }
    }

    hideLoading();
    if (savedCount === 0 && errorCount > 0) {
      // All failed - stay on page so user can see error and retry
      showToast(`Failed to save: ${lastError}`, 'error');
    } else if (errorCount > 0) {
      showToast(`Saved ${savedCount}, ${errorCount} failed`, 'error');
      setTimeout(() => viewChildGuide(childId), 2000);
    } else {
      showToast(`Saved ${savedCount} items to guide!`, 'success');
      setTimeout(() => viewChildGuide(childId), 1500);
    }
  });

  // Retake
  document.getElementById('retake-btn')?.addEventListener('click', () => {
    finalTranscript = '';
    organizedItems = {};
    finalText.textContent = '';
    interimText.textContent = '';
    organizedResults.style.display = 'none';
    startBtn.style.display = 'inline-flex';
  });

  // Back - clean up listener
  document.getElementById('back-btn')?.addEventListener('click', () => {
    stopDictation();
    window.removeEventListener('dictationUpdate', dictationHandler);
    viewChildGuide(childId);
  });
}

// ============================================================================
// DOCUMENT UPLOAD & PARSING
// ============================================================================

async function handleDocumentUpload(file, childId, child) {
  const fileName = file.name.toLowerCase();
  const maxSize = 10 * 1024 * 1024; // 10MB

  if (file.size > maxSize) {
    showToast('File too large. Max 10MB.', 'error');
    return;
  }

  showLoading();

  try {
    let extractedText = '';

    if (fileName.endsWith('.pdf')) {
      extractedText = await extractTextFromPDF(file);
    } else if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
      extractedText = await extractTextFromDocx(file);
    } else if (fileName.endsWith('.txt')) {
      extractedText = await file.text();
    } else {
      hideLoading();
      showToast('Unsupported file type. Use PDF, Word, or text files.', 'error');
      return;
    }

    if (!extractedText || extractedText.trim().length < 10) {
      hideLoading();
      showToast('Could not extract text from the file. It may be image-based or empty.', 'error');
      return;
    }

    console.log('[CribNotes] Extracted text from upload:', extractedText.length, 'chars');

    // Load all children in the family for multi-child distribution
    const childrenResult = await getChildren(state.currentFamily.id);
    const allChildren = childrenResult.success ? childrenResult.data : [];

    hideLoading();

    // Show the extracted text and let user review before organizing
    renderUploadReview(extractedText, childId, child, allChildren);

  } catch (error) {
    hideLoading();
    console.error('[CribNotes] Document upload error:', error);
    showToast('Error reading file: ' + error.message, 'error');
  }
}

async function extractTextFromPDF(file) {
  if (!window.pdfjsLib) {
    throw new Error('PDF reader not loaded. Please refresh and try again.');
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    // Use y-coordinates to detect line and paragraph breaks.
    // PDF.js items have transform[5] = y position (higher = higher on page).
    let lastY = null;
    let lastHeight = 12;
    let pageText = '';

    for (const item of content.items) {
      const y = item.transform ? item.transform[5] : null;
      const height = item.height || lastHeight;

      if (lastY !== null && y !== null) {
        const yDiff = Math.abs(lastY - y);

        if (yDiff > height * 1.8) {
          // Large gap = paragraph break
          pageText += '\n\n';
        } else if (yDiff > height * 0.5) {
          // Normal line break
          pageText += '\n';
        } else if (item.str && !item.str.startsWith(' ') && pageText && !pageText.endsWith(' ') && !pageText.endsWith('\n')) {
          // Same line, add space between words
          pageText += ' ';
        }
      }

      pageText += item.str;
      if (y !== null) lastY = y;
      if (height > 0) lastHeight = height;
    }

    fullText += pageText + '\n\n';
  }

  return fullText.trim();
}

async function extractTextFromDocx(file) {
  if (!window.mammoth) {
    throw new Error('Word doc reader not loaded. Please refresh and try again.');
  }

  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.trim();
}

/**
 * Distribute organized items across multiple children.
 * Items mentioning a specific child's name go only to that child.
 * Items not mentioning any specific child are shared across all children.
 */
function distributeItemsAcrossChildren(organizedItems, allChildren) {
  // Build name-to-child map: include nicknames and variations
  const nameToChild = {};
  for (const child of allChildren) {
    const name = (child.name || '').trim();
    if (!name) continue;
    // Full name
    nameToChild[name.toLowerCase()] = child.id;
    // First name only
    const firstName = name.split(/\s+/)[0];
    if (firstName) nameToChild[firstName.toLowerCase()] = child.id;
    // Common nickname: "Malakai" -> "Kai"
    if (firstName.toLowerCase() === 'malakai') {
      nameToChild['kai'] = child.id;
    }
  }

  // Result: { childId: { section: [items] } }
  const perChild = {};
  for (const child of allChildren) {
    perChild[child.id] = {};
  }

  for (const [section, items] of Object.entries(organizedItems)) {
    for (const item of items) {
      const itemLower = item.toLowerCase();

      // Check which children are mentioned in this item
      const mentionedChildIds = new Set();
      for (const [nameLower, cid] of Object.entries(nameToChild)) {
        // Use word boundary check to avoid partial matches
        const regex = new RegExp(`\\b${nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(itemLower)) {
          mentionedChildIds.add(cid);
        }
      }

      if (mentionedChildIds.size === 0) {
        // No specific child mentioned -- shared item, goes to all children
        for (const child of allChildren) {
          if (!perChild[child.id][section]) perChild[child.id][section] = [];
          perChild[child.id][section].push(item);
        }
      } else {
        // Only save to the mentioned child(ren)
        for (const cid of mentionedChildIds) {
          if (!perChild[cid][section]) perChild[cid][section] = [];
          perChild[cid][section].push(item);
        }
      }
    }
  }

  return perChild;
}

function renderUploadReview(extractedText, childId, child, allChildren) {
  const root = document.getElementById('app-root');
  const childName = child.data?.name || child.name || '';
  const hasMultipleChildren = allChildren.length > 1;

  // Build a display name map for children
  const childNameMap = {};
  for (const c of allChildren) {
    childNameMap[c.id] = c.name || 'Child';
  }

  // Truncate preview if very long
  const previewText = extractedText.length > 1500
    ? extractedText.substring(0, 1500) + '...'
    : extractedText;

  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">&#8592;</button>
        <h1 class="header-title">Review Upload</h1>
      </header>

      <main class="app-content">
        <div class="container">
          <div class="dictation-card">
            <p style="text-align: center; color: #666; margin-bottom: 1rem;">
              Extracted text from your document.${hasMultipleChildren ? ' Items will be distributed across your children automatically.' : ` Review and organize into ${childName}'s care guide.`}
            </p>

            <div id="extracted-text-display" class="transcript-display" style="max-height: 300px; overflow-y: auto; font-size: 0.9em; line-height: 1.5;">
              <p style="white-space: pre-wrap;">${previewText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
            </div>

            <div style="text-align: center; color: #999; margin: 8px 0; font-size: 0.85em;">
              ${extractedText.length} characters extracted
            </div>

            <div style="display: flex; gap: 8px; margin-top: 1rem;">
              <button class="btn btn-primary" id="organize-upload-btn" style="flex: 1;">Organize into Guide</button>
              <button class="btn btn-outline" id="cancel-upload-btn">Cancel</button>
            </div>

            <div id="upload-organized-results" style="display: none; margin-top: 1.5rem;">
              <h4 style="margin-bottom: 0.75rem;">Organized into sections:</h4>
              <div id="upload-results-list"></div>
              <div style="display: flex; gap: 8px; margin-top: 1.5rem;">
                <button class="btn btn-primary" id="save-upload-btn" style="flex: 1;">Save All to Guide</button>
                <button class="btn btn-outline" id="reorg-upload-btn">Re-organize</button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  `;

  let organizedItems = {};
  let perChildDistribution = {};

  document.getElementById('back-btn')?.addEventListener('click', () => {
    viewChildGuide(childId);
  });

  document.getElementById('cancel-upload-btn')?.addEventListener('click', () => {
    viewChildGuide(childId);
  });

  // Organize the extracted text
  const handleOrganize = async () => {
    const resultsList = document.getElementById('upload-results-list');
    const organizedResults = document.getElementById('upload-organized-results');

    resultsList.innerHTML = `
      <div style="text-align: center; padding: 20px; color: #666;">
        <div style="font-size: 1.5em; margin-bottom: 8px;">Organizing your document...</div>
        <div style="font-size: 0.9em;">Cleaning up and categorizing</div>
      </div>
    `;
    organizedResults.style.display = 'block';

    try {
      const result = await processTranscript(extractedText, childName, 'document');
      console.log('[CribNotes] Upload processed result:', JSON.stringify(result));

      organizedItems = result.sections || {};

      if (Object.keys(organizedItems).length === 0) {
        resultsList.innerHTML = '<p style="color: #666; text-align: center;">Could not organize the text. The document may not contain care guide information.</p>';
        return;
      }

      // Distribute across children if multiple exist
      if (hasMultipleChildren) {
        perChildDistribution = distributeItemsAcrossChildren(organizedItems, allChildren);

        // Render per-child breakdown
        let html = '';
        for (const c of allChildren) {
          const childItems = perChildDistribution[c.id] || {};
          const totalItems = Object.values(childItems).reduce((sum, arr) => sum + arr.length, 0);

          html += `<div style="margin-bottom: 16px;">
            <div style="background: #1a365d; color: white; padding: 8px 12px; border-radius: 8px 8px 0 0; font-weight: 600;">
              ${childNameMap[c.id]} <span style="font-weight: 400; opacity: 0.8;">(${totalItems} items)</span>
            </div>
            <div style="background: #f8f9fa; border-radius: 0 0 8px 8px; padding: 12px;">`;

          if (totalItems === 0) {
            html += `<p style="color: #999; margin: 0;">No items specific to this child</p>`;
          } else {
            for (const [section, items] of Object.entries(childItems)) {
              html += `<div style="margin-bottom: 8px;">
                <strong style="color: #2a9d8f; font-size: 0.9em;">${getSectionLabel(section)}</strong>
                <ul style="margin: 4px 0 0 16px; padding: 0; list-style: none;">
                  ${items.map(item => `<li style="margin: 4px 0; color: #333; padding-left: 10px; border-left: 3px solid #2a9d8f; line-height: 1.4; font-size: 0.9em;">${item}</li>`).join('')}
                </ul>
              </div>`;
            }
          }

          html += `</div></div>`;
        }
        resultsList.innerHTML = html;
      } else {
        // Single child -- show flat list like before
        resultsList.innerHTML = Object.entries(organizedItems).map(([section, items]) => `
          <div style="background: #f8f9fa; border-radius: 8px; padding: 12px; margin-bottom: 8px;">
            <strong style="color: #1a365d;">${getSectionLabel(section)}</strong>
            <ul style="margin: 8px 0 0 16px; padding: 0; list-style: none;">
              ${items.map(item => `<li style="margin: 6px 0; color: #333; padding-left: 12px; border-left: 3px solid #2a9d8f; line-height: 1.4;">${item}</li>`).join('')}
            </ul>
          </div>
        `).join('');
      }
    } catch (error) {
      console.error('[CribNotes] Upload processing error:', error);
      resultsList.innerHTML = `<p style="color: #e74c3c;">Error processing document: ${error.message}</p>`;
    }
  };

  document.getElementById('organize-upload-btn')?.addEventListener('click', handleOrganize);
  document.getElementById('reorg-upload-btn')?.addEventListener('click', handleOrganize);

  // Save all organized items
  document.getElementById('save-upload-btn')?.addEventListener('click', async () => {
    if (Object.keys(organizedItems).length === 0) {
      showToast('Nothing to save', 'error');
      return;
    }

    showLoading();
    let savedCount = 0;
    let errorCount = 0;

    const tagItem = (raw) => {
      const text = typeof raw === 'string' ? raw : (raw.text || '');
      const tags = inferTagsFromText(text);
      return tags.length ? { text, tags } : text;
    };

    if (hasMultipleChildren && Object.keys(perChildDistribution).length > 0) {
      // Save distributed items to each child
      for (const c of allChildren) {
        const childItems = perChildDistribution[c.id] || {};
        // Initialize guide doc if needed
        await getCareGuide(state.currentFamily.id, c.id);

        for (const [section, items] of Object.entries(childItems)) {
          for (const item of items) {
            try {
              const result = await addGuideItem(state.currentFamily.id, c.id, section, tagItem(item));
              if (result.success) savedCount++;
              else errorCount++;
            } catch (err) {
              errorCount++;
            }
          }
        }
      }
    } else {
      // Single child save
      await getCareGuide(state.currentFamily.id, childId);
      for (const [section, items] of Object.entries(organizedItems)) {
        for (const item of items) {
          try {
            const result = await addGuideItem(state.currentFamily.id, childId, section, tagItem(item));
            if (result.success) savedCount++;
            else errorCount++;
          } catch (err) {
            errorCount++;
          }
        }
      }
    }

    hideLoading();
    if (savedCount > 0) {
      const childCount = hasMultipleChildren ? ` across ${allChildren.length} children` : '';
      showToast(`Saved ${savedCount} items${childCount}!`, 'success');
      setTimeout(() => viewChildGuide(childId), 1500);
    } else {
      showToast('Failed to save items', 'error');
    }
  });
}

// ============================================================================
// CHECKLISTS
// ============================================================================

async function renderChildChecklists(childId) {
  const child = await getChild(state.currentFamily.id, childId);
  if (!child.success) {
    showToast('Error loading child', 'error');
    return;
  }

  const checklistsResult = await getChecklists(state.currentFamily.id, childId);
  const checklists = checklistsResult.success ? checklistsResult.data : [];

  const isParent = state.userData.role === 'parent';

  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">${child.data.name}'s Lists</h1>
        ${isParent ? `<button class="btn-icon" id="add-checklist-btn">+</button>` : ''}
      </header>

      <main class="app-content">
        <div class="container">
          ${checklists.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">✓</div>
              <h3>No checklists yet</h3>
              ${isParent ? `<button class="btn btn-primary" onclick="renderAddChecklistForm('${childId}')">Create Checklist</button>` : ''}
            </div>
          ` : `
            <div class="checklists">
              ${checklists.map(checklist => {
                const completed = checklist.items.filter(i => i.done).length;
                const total = checklist.items.length;
                const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

                return `
                  <div class="checklist-card">
                    <div class="checklist-header">
                      <h3>${checklist.title}</h3>
                      ${isParent ? `<button class="btn-icon" onclick="deleteChecklistConfirm('${childId}', '${checklist.id}')">✕</button>` : ''}
                    </div>
                    <div class="progress-bar">
                      <div class="progress-fill" style="width: ${percent}%"></div>
                    </div>
                    <p class="progress-text">${completed} of ${total}</p>
                    <ul class="checklist-items">
                      ${checklist.items.map((item, idx) => `
                        <li>
                          <input type="checkbox" ${item.done ? 'checked' : ''}
                            onchange="handleUpdateChecklistItem('${childId}', '${checklist.id}', ${idx}, this.checked)">
                          <label>${item.text}</label>
                        </li>
                      `).join('')}
                    </ul>
                  </div>
                `;
              }).join('')}
            </div>
          `}
        </div>
      </main>
    </div>
  `;

  document.getElementById('back-btn')?.addEventListener('click', () => {
    viewChildGuide(childId);
  });

  if (isParent) {
    document.getElementById('add-checklist-btn')?.addEventListener('click', () => {
      renderAddChecklistForm(childId);
    });
  }
}

async function handleUpdateChecklistItem(childId, checklistId, itemIndex, done) {
  showLoading();
  const result = await updateChecklistItem(
    state.currentFamily.id,
    childId,
    checklistId,
    itemIndex,
    done
  );

  if (!result.success) {
    showToast(result.error, 'error');
  }

  hideLoading();
  renderChildChecklists(childId);
}

async function deleteChecklistConfirm(childId, checklistId) {
  if (confirm('Delete this checklist?')) {
    showLoading();
    const result = await deleteChecklist(
      state.currentFamily.id,
      childId,
      checklistId
    );

    if (!result.success) {
      showToast(result.error, 'error');
      hideLoading();
    } else {
      showToast('Checklist deleted', 'success');
      renderChildChecklists(childId);
    }
  }
}

function renderAddChecklistForm(childId) {
  showModal(`
    <h3>Create Checklist</h3>
    <input type="text" id="checklist-title" placeholder="List name" style="width: 100%; margin-bottom: 12px; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    <textarea id="checklist-items" rows="6" placeholder="One item per line" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;"></textarea>
    <div style="display: flex; gap: 8px; margin-top: 16px;">
      <button class="btn btn-primary" onclick="saveChecklist('${childId}')">Create</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function saveChecklist(childId) {
  const title = document.getElementById('checklist-title')?.value;
  const itemsText = document.getElementById('checklist-items')?.value || '';

  if (!title) {
    showToast('Please enter a name', 'error');
    return;
  }

  const items = itemsText.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  if (items.length === 0) {
    showToast('Please add at least one item', 'error');
    return;
  }

  showLoading();
  closeModal();

  const result = await createChecklist(
    state.currentFamily.id,
    childId,
    title,
    items
  );

  if (!result.success) {
    showToast(result.error, 'error');
    hideLoading();
  } else {
    showToast('Checklist created', 'success');
    renderChildChecklists(childId);
  }
}

// ============================================================================
// PHOTOS
// ============================================================================

async function renderPhotosScreen() {
  if (!state.currentChild) {
    // Show all children's photos
    renderParentDashboard();
    return;
  }

  renderChildPhotos(state.currentChild);
}

async function renderChildPhotos(childId) {
  const child = await getChild(state.currentFamily.id, childId);
  if (!child.success) {
    showToast('Error loading child', 'error');
    return;
  }

  const photosResult = await getPhotos(state.currentFamily.id, childId);
  const photos = photosResult.success ? photosResult.data : [];

  const isParent = state.userData.role === 'parent';

  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">${child.data.name}'s Photos</h1>
        ${isParent ? `<button class="btn-icon" id="upload-btn">⬆️</button>` : ''}
      </header>

      <main class="app-content">
        <div class="container">
          ${photos.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">📸</div>
              <h3>No photos yet</h3>
              ${isParent ? `<p>Share moments with the babysitter</p>` : '<p>No photos shared yet</p>'}
            </div>
          ` : `
            <div class="photos-grid">
              ${photos.map(photo => `
                <div class="photo-card">
                  <img src="${photo.url}" alt="${photo.caption || 'Photo'}">
                  ${photo.caption ? `<p>${photo.caption}</p>` : ''}
                  ${isParent ? `<button class="btn-icon" onclick="deletePhotoConfirm('${childId}', '${photo.id}')">✕</button>` : ''}
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </main>
    </div>
  `;

  document.getElementById('back-btn')?.addEventListener('click', () => {
    viewChildGuide(childId);
  });

  if (isParent) {
    document.getElementById('upload-btn')?.addEventListener('click', () => {
      renderUploadPhotoForm(childId);
    });
  }
}

function renderUploadPhotoForm(childId) {
  showModal(`
    <h3>Add Photo</h3>
    <input type="file" id="photo-file" accept="image/*" style="width: 100%; margin-bottom: 12px;">
    <input type="text" id="photo-caption" placeholder="Caption (optional)" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    <div style="display: flex; gap: 8px; margin-top: 16px;">
      <button class="btn btn-primary" onclick="uploadPhoto('${childId}')">Upload</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function uploadPhoto(childId) {
  const fileInput = document.getElementById('photo-file');
  const caption = document.getElementById('photo-caption')?.value || '';

  if (!fileInput?.files[0]) {
    showToast('Please select a photo', 'error');
    return;
  }

  showLoading();

  // For now, use a placeholder URL (in real app, upload to Firebase Storage)
  const photoUrl = URL.createObjectURL(fileInput.files[0]);

  const result = await addPhotoMetadata(
    state.currentFamily.id,
    childId,
    photoUrl,
    caption
  );

  closeModal();

  if (!result.success) {
    showToast(result.error, 'error');
    hideLoading();
  } else {
    showToast('Photo added', 'success');
    renderChildPhotos(childId);
  }
}

async function deletePhotoConfirm(childId, photoId) {
  if (confirm('Delete this photo?')) {
    showLoading();
    const result = await deletePhoto(
      state.currentFamily.id,
      childId,
      photoId
    );

    if (!result.success) {
      showToast(result.error, 'error');
      hideLoading();
    } else {
      showToast('Photo deleted', 'success');
      renderChildPhotos(childId);
    }
  }
}

// ============================================================================
// MESSAGES / CHAT
// ============================================================================

async function renderMessagesScreen() {
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">Messages</h1>
      </header>

      <main class="app-content">
        <div id="messages-container" class="messages-container">
          <!-- Messages will be loaded here -->
        </div>
      </main>

      <div class="message-input-area">
        <input type="text" id="message-input" placeholder="Type a message..." class="message-input">
        <button id="send-btn" class="btn btn-icon btn-primary">→</button>
      </div>
    </div>
  `;

  const messagesContainer = document.getElementById('messages-container');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');

  // Load messages with real-time listener
  const msgResult = await getMessages(state.currentFamily.id, (messages) => {
    messagesContainer.innerHTML = messages.map(msg => `
      <div class="message ${msg.from === state.currentUser.uid ? 'sent' : 'received'}">
        <div class="message-bubble">
          ${msg.text}
        </div>
        <span class="message-time">${new Date(msg.timestamp?.toDate?.() || msg.timestamp).toLocaleTimeString()}</span>
      </div>
    `).join('');

    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });

  if (msgResult.success) {
    state.messageUnsubscribe = msgResult.unsubscribe;
  }

  sendBtn.addEventListener('click', async () => {
    const text = messageInput.value.trim();
    if (!text) return;

    messageInput.value = '';

    const result = await sendMessage(state.currentFamily.id, text);
    if (!result.success) {
      showToast(result.error, 'error');
    }
  });

  messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendBtn.click();
    }
  });

  document.getElementById('back-btn')?.addEventListener('click', () => {
    if (state.messageUnsubscribe) {
      state.messageUnsubscribe();
    }
    if (state.userData.role === 'parent') {
      renderParentDashboard();
    } else {
      renderSitterDashboard();
    }
  });
}

// ============================================================================
// EMERGENCY CONTACTS
// ============================================================================

function renderEmergencyContacts() {
  if (!state.currentChild) {
    showToast('Please select a child first', 'error');
    return;
  }

  // Render using the care guide emergency contacts
  viewChildGuide(state.currentChild);
  // The guide will show emergency contacts section
}

// ============================================================================
// SETTINGS
// ============================================================================

function renderParentSettings() {
  showModal(`
    <h3>Settings</h3>
    <div style="padding: 16px 0;">
      <p><strong>Family Code:</strong></p>
      <div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin: 8px 0; font-family: monospace; font-size: 1.2em; letter-spacing: 0.15em; text-align: center;">
        ${state.currentFamily.inviteCode || 'Loading...'}
      </div>
      <p style="font-size: 0.9em; color: #666;">Share this code with babysitters to invite them</p>
    </div>
    <hr style="margin: 16px 0;">
    <button class="btn btn-outline btn-full" onclick="copyInviteCode()">Copy Code</button>
    <button class="btn btn-full" onclick="renderInviteSitterScreen()">Invite a Sitter</button>
    <button class="btn btn-full" onclick="renderProfileSettings()">Profile</button>
    <button class="btn btn-full" onclick="renderSitterPermissionsScreen()">Sitter Permissions</button>
    <button class="btn btn-full" onclick="renderShiftHistoryScreen()">Shift History</button>
    <button class="btn btn-full" onclick="switchFamilyOrRole()" style="background: var(--color-clay); color: white;">Switch family or role</button>
    <button class="btn btn-outline btn-full" onclick="handleLogout()">Sign Out</button>
  `);
}

/**
 * Resets the user's role + family so they re-enter the split-screen onboarding.
 * Used by the dashboard "Switch family or role" buttons across the app.
 */
async function switchFamilyOrRole() {
  closeModal();
  if (!confirm('Switch family or role? You will return to onboarding where you can pick a different role, search for a family, or invite a sitter. Your existing family data is preserved.')) return;
  showLoading();
  try {
    const firestore = getFirestore();
    await firestore.collection('users').doc(state.currentUser.uid).update({
      role: null,
      familyId: null
    });
    state.userData.role = null;
    state.userData.familyId = null;
    state.currentFamily = null;
    state.activeShift = null;
    state.contextTags = [];
    hideLoading();
    await routeApp();
  } catch (err) {
    hideLoading();
    showToast('Could not switch: ' + err.message, 'error');
  }
}

async function renderInviteSitterScreen() {
  closeModal();
  showLoading();
  const family = state.currentFamily;
  const sent = await listFamilyInvitesSent(family.id);
  hideLoading();
  const pending = sent.success ? sent.data : [];

  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">Invite a Sitter</h1>
      </header>
      <main class="app-content">
        <div class="container container-small">
          <div class="card">
            <h2 style="font-family: var(--font-display); font-size: 1.5rem; letter-spacing: -0.02em; margin-bottom: 8px;">
              Send a sitter an invitation
            </h2>
            <p style="color: var(--color-text-light); margin-bottom: 1rem; font-size: 0.92rem;">
              Search a babysitter on CribNotes by email. If they accept, they'll join ${escapeHtml(family.name)} automatically.
              They can also join if you share your invite code <strong>${escapeHtml(family.inviteCode || '')}</strong>.
            </p>

            <div class="form-group">
              <label for="invite-email">Sitter email</label>
              <input type="email" id="invite-email" placeholder="sitter@example.com">
            </div>
            <div class="form-group">
              <label for="invite-message">Message (optional)</label>
              <input type="text" id="invite-message" placeholder="Join the Bell family!">
            </div>
            <button class="btn btn-primary btn-full" id="send-invite-btn">Send invite</button>

            <div id="invite-search-results" style="margin-top: 1rem;"></div>

            ${pending.length ? `
              <div class="divider"></div>
              <h3 style="font-family: var(--font-display); margin-bottom: 8px;">Pending invitations</h3>
              ${pending.map(i => `
                <div class="jr-row" data-invite-id="${i.id}">
                  <div class="jr-info">
                    <strong>${escapeHtml(i.toSitterEmail)}</strong>
                    <small>Sent ${i.createdAt?.toDate ? i.createdAt.toDate().toLocaleDateString() : 'recently'}</small>
                  </div>
                  <div class="jr-actions">
                    <button class="btn btn-small btn-outline cancel-invite" data-invite-id="${i.id}" style="color: var(--color-rust); border-color: var(--color-rust);">Cancel</button>
                  </div>
                </div>
              `).join('')}
            ` : ''}
          </div>
        </div>
      </main>
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', renderParentDashboard);

  document.getElementById('send-invite-btn').addEventListener('click', async () => {
    const email = document.getElementById('invite-email').value.trim();
    const message = document.getElementById('invite-message').value.trim();
    if (!email || !email.includes('@')) {
      showToast('Enter a valid email', 'error');
      return;
    }
    showLoading();
    // Look up the user (best-effort) so we can store toSitterId too
    const searchResult = await searchSittersByEmail(email);
    const found = searchResult.success
      ? searchResult.data.find(s => (s.email || '').toLowerCase() === email.toLowerCase())
      : null;
    const r = await inviteSitterByEmail(family.id, email, found?.id || null, message);
    hideLoading();
    if (r.success) {
      if (r.alreadyPending) showToast('That sitter already has a pending invite', 'info');
      else showToast('Invitation sent', 'success');
      renderInviteSitterScreen();
    } else {
      showToast(r.error || 'Could not send invite', 'error');
    }
  });

  document.querySelectorAll('.cancel-invite').forEach(btn =>
    btn.addEventListener('click', async () => {
      showLoading();
      const r = await cancelFamilyInvite(btn.dataset.inviteId);
      hideLoading();
      if (r.success) { showToast('Invite cancelled', 'info'); renderInviteSitterScreen(); }
      else showToast(r.error || 'Could not cancel', 'error');
    }));
}

async function renderSitterPermissionsScreen() {
  closeModal();
  showLoading();
  const family = state.currentFamily;
  const sitterIds = family.sitterIds || [];
  // Load each sitter's user doc + permissions
  const fs = getFirestore();
  const sitters = [];
  for (const sid of sitterIds) {
    const u = await fs.collection('users').doc(sid).get();
    if (!u.exists) continue;
    const p = await getSitterPermissions(family.id, sid);
    sitters.push({ id: sid, user: u.data(), permissions: p.success ? p.data : {} });
  }
  hideLoading();

  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">Sitter Permissions</h1>
      </header>
      <main class="app-content">
        <div class="container">
          ${sitters.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">🧑‍💼</div>
              <h3>No sitters yet</h3>
              <p>Share your invite code so a sitter can join.</p>
            </div>` : sitters.map(s => `
            <div class="card permission-card" data-sitter-id="${s.id}">
              <h3>${escapeHtml(s.user.name || s.user.email)}</h3>
              <p style="color: var(--color-text-light); font-size: 0.9em;">${escapeHtml(s.user.email || '')}</p>
              ${[
                ['canViewGuide', 'View care guide'],
                ['canEditGuide', 'Edit care guide'],
                ['canPostLog', 'Post shift log entries'],
                ['canViewPhotos', 'View photos'],
                ['canPostPhotos', 'Post photos'],
                ['canFlagParents', 'Flag moments to parent'],
                ['canViewMessages', 'See chat'],
                ['canViewMedications', 'View medications &amp; record doses']
              ].map(([key, label]) => `
                <label class="perm-row">
                  <input type="checkbox" data-key="${key}" ${s.permissions[key] !== false ? 'checked' : ''}>
                  <span>${label}</span>
                </label>
              `).join('')}
              <button class="btn btn-primary save-perm-btn" data-sitter-id="${s.id}">Save</button>
            </div>
          `).join('')}
        </div>
      </main>
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', renderParentDashboard);
  document.querySelectorAll('.save-perm-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.sitterId;
      const card = document.querySelector(`.permission-card[data-sitter-id="${sid}"]`);
      const updates = {};
      card.querySelectorAll('input[type=checkbox]').forEach(cb => {
        updates[cb.dataset.key] = cb.checked;
      });
      showLoading();
      const r = await setSitterPermissions(family.id, sid, updates);
      hideLoading();
      if (r.success) showToast('Permissions saved', 'success');
      else showToast(r.error, 'error');
    }));
}

async function renderShiftHistoryScreen() {
  closeModal();
  showLoading();
  const result = await listShifts(state.currentFamily.id, 50);
  hideLoading();
  const shifts = result.success ? result.data : [];
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">Shift History</h1>
      </header>
      <main class="app-content">
        <div class="container">
          ${shifts.length === 0 ? '<p class="text-muted">No shifts logged yet.</p>' : shifts.map(s => `
            <div class="card shift-history-card">
              <div class="shift-row-head">
                <strong>${escapeHtml(s.sitterName || 'Sitter')}</strong>
                <span class="shift-type-pill">${escapeHtml(s.shiftType || 'shift')}</span>
              </div>
              <p>
                ${s.startTime?.toDate ? s.startTime.toDate().toLocaleString() : ''}
                ${s.endTime?.toDate ? ' &mdash; ' + s.endTime.toDate().toLocaleString() : (s.active ? ' &mdash; <em>Active</em>' : '')}
              </p>
              ${s.summary ? `
                <div class="shift-history-summary">
                  ⏱ ${escapeHtml(s.summary.hoursLabel || '')} &middot;
                  💤 ${s.summary.counts?.nap || 0} naps &middot;
                  🍽 ${s.summary.counts?.meal || 0} meals &middot;
                  👶 ${s.summary.counts?.diaper || 0} diapers &middot;
                  💊 ${s.summary.counts?.medication || 0} meds
                  ${s.summary.flaggedCount ? ` &middot; <span class="flagged-text">🚩 ${s.summary.flaggedCount} flagged</span>` : ''}
                </div>
                ${s.endNote ? `<p class="shift-end-note">"${escapeHtml(s.endNote)}"</p>` : ''}
              ` : ''}
            </div>
          `).join('')}
        </div>
      </main>
    </div>
  `;
  document.getElementById('back-btn').addEventListener('click', renderParentDashboard);
}

function renderSitterSettings() {
  showModal(`
    <h3>Settings</h3>
    ${state.activeShift ? `
      <p style="font-size: 0.9em; color: var(--color-text-light); margin-bottom: 8px;">
        Shift started ${formatTime(state.activeShift.startTime)}
      </p>
      <button class="btn btn-full" onclick="endShiftFlow()" style="background: var(--color-coral); color: white;">End Shift &amp; Generate Summary</button>
    ` : ''}
    <button class="btn btn-full" onclick="renderProfileSettings()">Profile</button>
    <button class="btn btn-full" onclick="enablePushFromSettings()">Enable Push Notifications</button>
    <button class="btn btn-outline btn-full" onclick="handleLogout()">Sign Out</button>
  `);
}

async function enablePushFromSettings() {
  closeModal();
  const r = await requestNotificationPermission();
  if (r.success) {
    await subscribeToPush();
    showToast('Notifications enabled', 'success');
  } else {
    showToast(r.error || 'Notification permission not granted', 'error');
  }
}

function renderProfileSettings() {
  showModal(`
    <h3>Profile</h3>
    <p><strong>Name:</strong> ${state.userData.name}</p>
    <p><strong>Email:</strong> ${state.userData.email}</p>
    <p><strong>Role:</strong> ${state.userData.role === 'parent' ? 'Parent/Guardian' : 'Babysitter'}</p>
    <hr style="margin: 16px 0;">
    <button class="btn btn-outline btn-full" onclick="switchProfile()" style="color: #e76f51; border-color: #e76f51;">
      Switch Role
    </button>
    <p style="font-size: 0.8em; color: #999; margin-top: 8px; text-align: center;">
      Change between Parent and Babysitter profiles
    </p>
  `);
}

function copyInviteCode() {
  const code = state.currentFamily.inviteCode;
  navigator.clipboard.writeText(code).then(() => {
    showToast('Copied!', 'success');
  });
}

async function switchProfile() {
  closeModal();

  // Confirm with user
  showModal(`
    <h3>Switch Role</h3>
    <p>This will change your profile type. You'll need to select a new role and set up your family connection again.</p>
    <p style="margin-top: 12px; font-weight: 600;">Current role: ${state.userData.role === 'parent' ? 'Parent/Guardian' : 'Babysitter'}</p>
    <div style="display: flex; gap: 8px; margin-top: 20px;">
      <button class="btn btn-primary" id="confirm-switch-btn" style="flex: 1; background: #e76f51;">Confirm Switch</button>
      <button class="btn btn-outline" onclick="closeModal()" style="flex: 1;">Cancel</button>
    </div>
  `);

  document.getElementById('confirm-switch-btn')?.addEventListener('click', async () => {
    closeModal();
    showLoading();

    try {
      const firestore = getFirestore();
      // Clear role and family so user goes through selection again
      await firestore.collection('users').doc(state.currentUser.uid).update({
        role: null,
        familyId: null
      });

      state.userData.role = null;
      state.userData.familyId = null;
      state.currentFamily = null;
      state.activeShift = null;
      state.contextTags = [];

      hideLoading();
      await routeApp();
    } catch (err) {
      hideLoading();
      showToast('Failed to switch role: ' + err.message, 'error');
    }
  });
}

async function handleLogout() {
  closeModal();
  showLoading();

  if (state.messageUnsubscribe) {
    state.messageUnsubscribe();
  }

  await signOut();
}

// ============================================================================
// CHILD MANAGEMENT
// ============================================================================

function renderAddChildForm() {
  showModal(`
    <h3>Add Child</h3>
    <input type="text" id="child-name" placeholder="Name" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 12px;">
    <input type="number" id="child-age" placeholder="Age" min="0" max="18" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 12px;">
    <div style="display: flex; gap: 8px; margin-top: 16px;">
      <button class="btn btn-primary" onclick="saveChild()">Add</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

function renderEditChildForm(childId) {
  // Quick edit form
  renderAddChildForm();
}

async function saveChild() {
  const name = document.getElementById('child-name')?.value;
  const age = parseInt(document.getElementById('child-age')?.value || 0);

  if (!name || age < 0) {
    showToast('Please enter name and age', 'error');
    return;
  }

  showLoading();
  closeModal();

  const result = await addChild(state.currentFamily.id, name, age);
  if (!result.success) {
    showToast(result.error, 'error');
    hideLoading();
  } else {
    showToast('Child added', 'success');
    renderParentDashboard();
  }
}

// ============================================================================
// SEARCH
// ============================================================================

async function renderSearchResults(term) {
  if (!state.currentChild) {
    showToast('Please select a child first', 'error');
    return;
  }

  const results = await searchGuide(state.currentFamily.id, state.currentChild, term);

  if (!results.success || results.data.length === 0) {
    showToast('No results found', 'info');
    return;
  }

  state.searchResults = results.data;

  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">Search Results</h1>
      </header>

      <main class="app-content">
        <div class="container">
          <p style="color: #666; margin-bottom: 16px;">${results.data.reduce((sum, r) => sum + r.items.length, 0)} results for "${term}"</p>
          ${results.data.map(result => `
            <div class="section" style="margin-bottom: 24px;">
              <h3>${result.label}</h3>
              <ul>
                ${result.items.map(item => `
                  <li>${typeof item === 'string' ? item : item.text}</li>
                `).join('')}
              </ul>
            </div>
          `).join('')}
        </div>
      </main>
    </div>
  `;

  document.getElementById('back-btn')?.addEventListener('click', () => {
    viewChildGuide(state.currentChild);
  });
}

// ============================================================================
// UI UTILITIES
// ============================================================================

function renderLoading(message = 'Loading...') {
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="auth-container">
      <div class="auth-card" style="text-align: center; padding: 3rem;">
        <div class="spinner"></div>
        <p style="margin-top: 1rem; color: #666;">${message}</p>
      </div>
    </div>
  `;
}

function showLoading() {
  const root = document.getElementById('app-root');
  if (!document.getElementById('loading-overlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = '<div class="spinner"></div>';
    root.appendChild(overlay);
  }
}

function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.remove();
  }
}

function showToast(message, type = 'info') {
  const root = document.getElementById('app-root');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  root.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

function showModal(content) {
  const root = document.getElementById('app-root');
  if (!document.getElementById('modal-overlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    root.appendChild(overlay);
  }

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = content;
  document.getElementById('modal-overlay').appendChild(modal);

  // Close on overlay click
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) {
      closeModal();
    }
  });
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) {
    overlay.remove();
  }
}

// ============================================================================
// SHIFT START / END (sitter-facing)
// ============================================================================

/**
 * The shift start screen is the first thing a sitter sees when they're not
 * in an active shift. They pick the shift type, date/time (defaults to now),
 * and any special contexts. Submitting this writes a shift to Firestore and
 * the context engine kicks in.
 */
function renderShiftStartScreen() {
  const root = document.getElementById('app-root');
  const shiftTypes = getShiftTypes();
  const now = new Date();
  const isoNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);

  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <h1 class="header-title">Start Shift</h1>
        <div class="header-right" style="gap: 8px;">
          <button class="btn btn-outline btn-small" id="switch-family-btn">Switch family / role</button>
          <button class="btn btn-outline btn-small" id="logout-btn">Sign out</button>
        </div>
      </header>
      <main class="app-content">
        <div class="container container-small">
          <div class="card">
            <h2 style="color: var(--color-navy);">Welcome, ${escapeHtml(state.userData.name)}</h2>
            <p style="color: var(--color-text-light);">${escapeHtml(state.currentFamily.name || 'Family')}</p>

            <div style="background: var(--color-cream); border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0; font-size: 0.95em;">
                CribNotes will filter the care guide to show only notes relevant to
                this shift's day, time, and length. You can always tap <strong>"Show all"</strong>
                to see everything.
              </p>
            </div>

            <form id="shift-start-form" class="form">
              <div class="form-group">
                <label for="shift-start-time">Shift starts</label>
                <input type="datetime-local" id="shift-start-time" value="${isoNow}" required>
              </div>

              <div class="form-group">
                <label>Shift type</label>
                <div class="shift-type-grid">
                  ${Object.entries(shiftTypes).map(([key, info], idx) => `
                    <label class="shift-type-card">
                      <input type="radio" name="shift-type" value="${key}" ${idx === 0 ? 'checked' : ''}>
                      <div class="shift-type-content">
                        <strong>${escapeHtml(info.label)}</strong>
                        <small>${escapeHtml(info.description)}</small>
                      </div>
                    </label>
                  `).join('')}
                </div>
              </div>

              <div class="form-group">
                <label>Special contexts (optional)</label>
                <div class="tag-chip-row">
                  ${SPECIAL_TAGS.map(t => `
                    <label class="tag-chip">
                      <input type="checkbox" name="special" value="${t}">
                      <span>${escapeHtml(t.replace(/-/g, ' '))}</span>
                    </label>
                  `).join('')}
                </div>
              </div>

              <div class="form-group">
                <label for="shift-note">Handoff note (optional)</label>
                <textarea id="shift-note" rows="3" placeholder="Anything the previous sitter or parent left for you?"></textarea>
              </div>

              <button type="submit" class="btn btn-primary btn-full">Start Shift</button>
            </form>

            <div class="divider"></div>
            <button type="button" class="btn btn-outline btn-full" id="enable-push-btn">
              Enable push notifications
            </button>
          </div>
        </div>
      </main>
    </div>
  `;

  document.getElementById('shift-start-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const startTimeStr = document.getElementById('shift-start-time').value;
    const shiftType = document.querySelector('input[name="shift-type"]:checked')?.value;
    const specials = Array.from(document.querySelectorAll('input[name="special"]:checked'))
      .map(el => el.value);
    const note = document.getElementById('shift-note').value;

    showLoading();
    const result = await startShift(state.currentFamily.id, {
      startTime: new Date(startTimeStr),
      shiftType,
      specials,
      note
    });
    hideLoading();

    if (!result.success) {
      showToast(result.error || 'Could not start shift', 'error');
      return;
    }
    showToast('Shift started', 'success');
    await refreshActiveShift();
    renderSitterDashboard();
  });

  document.getElementById('enable-push-btn').addEventListener('click', async () => {
    const r = await requestNotificationPermission();
    if (r.success) {
      await subscribeToPush();
      showToast('Notifications enabled', 'success');
    } else {
      showToast(r.error || 'Notification permission not granted', 'error');
    }
  });

  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  document.getElementById('switch-family-btn')?.addEventListener('click', async () => {
    if (!confirm('Switch family or role? This will return you to onboarding where you can pick a different role, search for a family, or invite a sitter.')) return;
    showLoading();
    try {
      const firestore = getFirestore();
      await firestore.collection('users').doc(state.currentUser.uid).update({
        role: null,
        familyId: null
      });
      state.userData.role = null;
      state.userData.familyId = null;
      state.currentFamily = null;
      state.activeShift = null;
      state.contextTags = [];
      hideLoading();
      await routeApp();
    } catch (err) {
      hideLoading();
      showToast('Could not switch: ' + err.message, 'error');
    }
  });
}

/**
 * End the running shift. Aggregates the log into a summary and shows it.
 */
async function endShiftFlow() {
  if (!state.activeShift) {
    showToast('No active shift', 'error');
    return;
  }
  showModal(`
    <h3>End Shift</h3>
    <p style="color: var(--color-text-light); margin-bottom: 12px;">
      Add a note for the parent or next sitter (optional):
    </p>
    <textarea id="end-shift-note" rows="4" style="width: 100%; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px;" placeholder="How did it go?"></textarea>
    <div style="display: flex; gap: 8px; margin-top: 16px;">
      <button class="btn btn-primary" id="confirm-end-shift-btn" style="flex: 1; background: var(--color-coral);">End & Generate Summary</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);

  document.getElementById('confirm-end-shift-btn').addEventListener('click', async () => {
    const endNote = document.getElementById('end-shift-note').value;
    closeModal();
    showLoading();

    // Pull the full log to build the summary
    const logResult = await getShiftLog(state.currentFamily.id, state.activeShift.id);
    const log = logResult.success ? logResult.data : [];
    const shiftForSummary = { ...state.activeShift, endTime: new Date() };
    const summary = summarizeShift(shiftForSummary, log);

    const result = await endShift(state.currentFamily.id, state.activeShift.id, {
      endNote,
      summary: {
        totalMinutes: summary.totalMinutes,
        hoursLabel: summary.hoursLabel,
        counts: summary.counts,
        napMinutes: summary.napMinutes,
        flaggedCount: summary.flagged.length,
        endNote
      }
    });
    hideLoading();

    if (!result.success) {
      showToast(result.error || 'Could not end shift', 'error');
      return;
    }

    const endedShift = state.activeShift;
    state.activeShift = null;
    state.contextTags = [];
    renderEndOfShiftSummary(endedShift, summary, log);
  });
}

function renderEndOfShiftSummary(shift, summary, log) {
  const root = document.getElementById('app-root');
  const c = summary.counts;
  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <h1 class="header-title">Shift Summary</h1>
      </header>
      <main class="app-content">
        <div class="container container-small">
          <div class="card summary-card">
            <h2 style="color: var(--color-navy); margin-bottom: 4px;">${escapeHtml(shift.sitterName || 'Sitter')}</h2>
            <p style="color: var(--color-text-light); margin-bottom: 16px;">
              ${summary.startedAt.toLocaleString()} &mdash; ${summary.endedAt.toLocaleString()}
            </p>

            <div class="summary-stats">
              <div class="summary-stat">
                <div class="stat-num">${summary.hoursLabel}</div>
                <div class="stat-label">Total time</div>
              </div>
              <div class="summary-stat">
                <div class="stat-num">${c.nap || 0}</div>
                <div class="stat-label">Naps (${summary.napMinutes}m)</div>
              </div>
              <div class="summary-stat">
                <div class="stat-num">${c.meal || 0}</div>
                <div class="stat-label">Meals</div>
              </div>
              <div class="summary-stat">
                <div class="stat-num">${c.diaper || 0}</div>
                <div class="stat-label">Diapers</div>
              </div>
              <div class="summary-stat">
                <div class="stat-num">${c.medication || 0}</div>
                <div class="stat-label">Meds</div>
              </div>
              <div class="summary-stat ${summary.flagged.length ? 'highlight' : ''}">
                <div class="stat-num">${summary.flagged.length}</div>
                <div class="stat-label">Flagged</div>
              </div>
            </div>

            ${summary.flagged.length > 0 ? `
              <div class="summary-section">
                <h3>Flagged moments</h3>
                ${summary.flagged.map(f => `
                  <div class="flagged-row">
                    <strong>${escapeHtml(f.authorName || 'Sitter')}</strong>
                    <span>${escapeHtml(f.text || '')}</span>
                    <small>${formatTime(f.timestamp)}</small>
                  </div>
                `).join('')}
              </div>
            ` : ''}

            <div class="summary-section">
              <h3>Timeline</h3>
              <div class="timeline">
                ${(log || []).map(entry => `
                  <div class="timeline-row">
                    <span class="timeline-time">${formatTime(entry.timestamp)}</span>
                    <span class="timeline-icon">${eventIcon(entry.type)}</span>
                    <span class="timeline-text">${escapeHtml(entry.text || entry.type)}</span>
                  </div>
                `).join('') || '<p class="text-muted">No events logged.</p>'}
              </div>
            </div>

            <div style="display: flex; gap: 8px; margin-top: 24px;">
              <button class="btn btn-primary btn-full" id="finish-summary-btn">Done</button>
            </div>
          </div>
        </div>
      </main>
    </div>
  `;
  document.getElementById('finish-summary-btn').addEventListener('click', () => {
    routeApp();
  });
}

function eventIcon(type) {
  switch (type) {
    case 'meal': return '🍽️';
    case 'nap': return '💤';
    case 'diaper': return '👶';
    case 'photo': return '📸';
    case 'medication': return '💊';
    case 'flag': return '🚩';
    case 'status': return '📍';
    default: return '📝';
  }
}

function formatTime(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ============================================================================
// CRITICAL INFO CARD (always-on, never context-filtered)
// ============================================================================

function renderCriticalInfoCard(child) {
  const c = child.critical || {};
  const allergies = Array.isArray(c.allergies) ? c.allergies : [];
  const meds = Array.isArray(c.medications) ? c.medications : [];
  const ec = Array.isArray(c.emergencyContacts) ? c.emergencyContacts : [];
  const ins = c.insurance || {};
  const ped = c.pediatrician || {};

  const hasAny = allergies.length || meds.length || ec.length ||
    ins.provider || ped.name || c.bloodType;
  if (!hasAny) {
    return `
      <div class="critical-card empty">
        <div class="critical-header">
          <span class="critical-icon">🛡️</span>
          <h3>Critical Info</h3>
        </div>
        <p style="color: var(--color-text-light); font-size: 0.9em; margin: 8px 0 0;">
          No critical info added yet. Allergies, current medications, blood type,
          and insurance live here so they're always one tap away.
        </p>
      </div>
    `;
  }

  return `
    <div class="critical-card">
      <div class="critical-header">
        <span class="critical-icon">🛡️</span>
        <h3>Critical Info</h3>
      </div>

      ${allergies.length ? `
        <div class="critical-row">
          <span class="critical-label">Allergies</span>
          <ul class="critical-list">
            ${allergies.map(a => `
              <li>
                <strong>${escapeHtml(a.allergen || a)}</strong>
                ${a.severity ? `<span class="severity ${a.severity}">${escapeHtml(a.severity)}</span>` : ''}
                ${a.reaction ? `<small>Reaction: ${escapeHtml(a.reaction)}</small>` : ''}
                ${a.treatment ? `<small>Treatment: ${escapeHtml(a.treatment)}</small>` : ''}
              </li>`).join('')}
          </ul>
        </div>` : ''}

      ${meds.length ? `
        <div class="critical-row">
          <span class="critical-label">Current Meds</span>
          <ul class="critical-list">
            ${meds.map(m => `<li><strong>${escapeHtml(m.name || m)}</strong>${m.dose ? ` &mdash; ${escapeHtml(m.dose)}` : ''}${m.schedule ? ` <small>(${escapeHtml(m.schedule)})</small>` : ''}</li>`).join('')}
          </ul>
        </div>` : ''}

      ${c.bloodType ? `
        <div class="critical-row">
          <span class="critical-label">Blood type</span>
          <span>${escapeHtml(c.bloodType)}</span>
        </div>` : ''}

      ${ped.name ? `
        <div class="critical-row">
          <span class="critical-label">Pediatrician</span>
          <span>${escapeHtml(ped.name)}${ped.phone ? ` &mdash; <a href="tel:${escapeHtml(ped.phone)}">${escapeHtml(ped.phone)}</a>` : ''}</span>
        </div>` : ''}

      ${ins.provider ? `
        <div class="critical-row">
          <span class="critical-label">Insurance</span>
          <span>${escapeHtml(ins.provider)}${ins.policyNumber ? ` &middot; #${escapeHtml(ins.policyNumber)}` : ''}</span>
        </div>` : ''}

      ${ec.length ? `
        <div class="critical-row">
          <span class="critical-label">Emergency contacts</span>
          <ul class="critical-list">
            ${ec.map(p => `<li><strong>${escapeHtml(p.name)}</strong> ${p.relationship ? `(${escapeHtml(p.relationship)})` : ''} ${p.phone ? `<a href="tel:${escapeHtml(p.phone)}">${escapeHtml(p.phone)}</a>` : ''}</li>`).join('')}
          </ul>
        </div>` : ''}
    </div>
  `;
}

function renderEditCriticalInfoForm(childId, critical) {
  const c = critical || {};
  const allergiesText = (c.allergies || []).map(a =>
    typeof a === 'string' ? a : [a.allergen, a.severity, a.reaction, a.treatment].filter(Boolean).join(' | ')
  ).join('\n');
  const medsText = (c.medications || []).map(m =>
    typeof m === 'string' ? m : [m.name, m.dose, m.schedule, m.notes].filter(Boolean).join(' | ')
  ).join('\n');
  const ecText = (c.emergencyContacts || []).map(p =>
    [p.name, p.relationship, p.phone].filter(Boolean).join(' | ')
  ).join('\n');
  const ins = c.insurance || {};
  const ped = c.pediatrician || {};

  showModal(`
    <h3>Critical Info</h3>
    <p style="color: var(--color-text-light); font-size: 0.9em; margin-bottom: 12px;">
      One per line. Use " | " between fields.
    </p>

    <label class="form-label">Allergies <small>(allergen | severity | reaction | treatment)</small></label>
    <textarea id="ci-allergies" rows="3" class="form-input">${escapeHtml(allergiesText)}</textarea>

    <label class="form-label">Current Medications <small>(name | dose | schedule | notes)</small></label>
    <textarea id="ci-meds" rows="3" class="form-input">${escapeHtml(medsText)}</textarea>

    <label class="form-label">Blood type</label>
    <input id="ci-bloodtype" class="form-input" value="${escapeHtml(c.bloodType || '')}" placeholder="O+">

    <label class="form-label">Pediatrician name / phone</label>
    <input id="ci-ped-name" class="form-input" value="${escapeHtml(ped.name || '')}" placeholder="Dr. Smith">
    <input id="ci-ped-phone" class="form-input" value="${escapeHtml(ped.phone || '')}" placeholder="Phone">

    <label class="form-label">Insurance (provider | policy # | group #)</label>
    <input id="ci-ins-provider" class="form-input" value="${escapeHtml(ins.provider || '')}" placeholder="Provider">
    <input id="ci-ins-policy" class="form-input" value="${escapeHtml(ins.policyNumber || '')}" placeholder="Policy #">
    <input id="ci-ins-group" class="form-input" value="${escapeHtml(ins.groupNumber || '')}" placeholder="Group #">

    <label class="form-label">Emergency contacts <small>(name | relationship | phone)</small></label>
    <textarea id="ci-ec" rows="3" class="form-input">${escapeHtml(ecText)}</textarea>

    <div style="display: flex; gap: 8px; margin-top: 16px;">
      <button class="btn btn-primary" id="save-critical-btn" style="flex: 1;">Save</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);

  document.getElementById('save-critical-btn').addEventListener('click', async () => {
    const parseLines = (text, fields) => text.split('\n')
      .map(l => l.trim()).filter(Boolean)
      .map(line => {
        const parts = line.split('|').map(s => s.trim());
        const obj = {};
        fields.forEach((f, i) => { if (parts[i]) obj[f] = parts[i]; });
        return obj;
      });

    const updates = {
      allergies: parseLines(document.getElementById('ci-allergies').value,
        ['allergen', 'severity', 'reaction', 'treatment']),
      medications: parseLines(document.getElementById('ci-meds').value,
        ['name', 'dose', 'schedule', 'notes']),
      emergencyContacts: parseLines(document.getElementById('ci-ec').value,
        ['name', 'relationship', 'phone']),
      bloodType: document.getElementById('ci-bloodtype').value.trim(),
      pediatrician: {
        name: document.getElementById('ci-ped-name').value.trim(),
        phone: document.getElementById('ci-ped-phone').value.trim()
      },
      insurance: {
        provider: document.getElementById('ci-ins-provider').value.trim(),
        policyNumber: document.getElementById('ci-ins-policy').value.trim(),
        groupNumber: document.getElementById('ci-ins-group').value.trim()
      }
    };

    showLoading();
    closeModal();
    const result = await updateCriticalInfo(state.currentFamily.id, childId, updates);
    hideLoading();
    if (!result.success) showToast(result.error, 'error');
    else {
      showToast('Critical info saved', 'success');
      viewChildGuide(childId);
    }
  });
}

// ============================================================================
// EMERGENCY MODE
// ============================================================================

/**
 * Persistent floating Emergency button. Mounts into #emergency-portal so it's
 * accessible from anywhere in the sitter view. Tap to open the quick-dial stack.
 */
function mountEmergencyButton() {
  const portal = document.getElementById('emergency-portal');
  if (!portal) return;
  if (!state.activeShift && state.userData?.role !== 'parent') {
    portal.innerHTML = '';
    return;
  }
  if (state.userData?.role !== 'babysitter') {
    portal.innerHTML = '';
    return;
  }
  portal.innerHTML = `
    <button id="emergency-fab" class="emergency-fab" aria-label="Emergency">
      <span class="ef-icon">🚨</span>
      <span class="ef-text">Emergency</span>
    </button>
  `;
  document.getElementById('emergency-fab').addEventListener('click', renderEmergencyStack);
}

async function renderEmergencyStack() {
  // Pull critical info for the current/first child
  let child = null;
  if (state.currentChild) {
    const r = await getChild(state.currentFamily.id, state.currentChild);
    if (r.success) child = r.data;
  } else {
    const r = await getChildren(state.currentFamily.id);
    if (r.success && r.data.length) child = r.data[0];
  }
  const critical = child?.critical || {};
  const family = state.currentFamily;

  // Build quick-dial list: 911, Poison Control, parents on the family,
  // emergency contacts on the child, then pediatrician
  const dials = [];
  dials.push({ label: 'Call 911', sub: 'Emergency Services', tel: '911', accent: 'red' });
  dials.push({ label: 'Poison Control', sub: '1-800-222-1222', tel: '18002221222', accent: 'orange' });
  // Parents (first parentId resolved in family doc; we render generically)
  if (family?.parentIds?.length) {
    dials.push({ label: 'Call Parent', sub: 'Family parent on file', tel: family.primaryParentPhone || '', accent: 'navy' });
  }
  (critical.emergencyContacts || []).forEach(p => {
    if (!p?.phone) return;
    dials.push({ label: p.name, sub: p.relationship || 'Emergency contact', tel: p.phone, accent: 'navy' });
  });
  if (critical.pediatrician?.phone) {
    dials.push({
      label: 'Pediatrician',
      sub: critical.pediatrician.name || '',
      tel: critical.pediatrician.phone,
      accent: 'teal'
    });
  }

  showModal(`
    <div class="emergency-modal">
      <h2 style="color: var(--color-coral); margin-bottom: 4px;">Emergency Mode</h2>
      <p style="color: var(--color-text-light); font-size: 0.9em; margin-bottom: 16px;">
        Tap to call. Critical medical info shown below.
      </p>

      <div class="emergency-dials">
        ${dials.map(d => `
          <a class="emergency-dial accent-${d.accent}" href="${d.tel ? `tel:${escapeHtml(d.tel.replace(/[^\d+]/g, ''))}` : '#'}">
            <strong>${escapeHtml(d.label)}</strong>
            <span>${escapeHtml(d.sub || '')}</span>
            ${d.tel ? `<small>${escapeHtml(d.tel)}</small>` : ''}
          </a>
        `).join('')}
      </div>

      ${child ? `
        <div class="emergency-medical">
          <h4>Medical at-a-glance &mdash; ${escapeHtml(child.name)}</h4>
          ${critical.bloodType ? `<p><strong>Blood type:</strong> ${escapeHtml(critical.bloodType)}</p>` : ''}
          ${(critical.allergies || []).length ? `<p><strong>Allergies:</strong> ${(critical.allergies || []).map(a => escapeHtml(a.allergen || a)).join(', ')}</p>` : ''}
          ${(critical.medications || []).length ? `<p><strong>Meds:</strong> ${(critical.medications || []).map(m => escapeHtml(m.name || m)).join(', ')}</p>` : ''}
          ${(critical.conditions || []).length ? `<p><strong>Conditions:</strong> ${(critical.conditions || []).map(c => escapeHtml(c.name || c)).join(', ')}</p>` : ''}
        </div>
      ` : ''}

      <button class="btn btn-outline btn-full" onclick="closeModal()">Close</button>
    </div>
  `);
}

// ============================================================================
// CONTEXT BANNER + FILTER TOGGLE
// ============================================================================

function renderContextBanner() {
  if (state.userData?.role !== 'babysitter' || !state.activeShift) return '';
  const desc = describeContext(state.contextTags);
  return `
    <div class="context-banner">
      <div class="cb-left">
        <span class="cb-icon">🧭</span>
        <div>
          <strong>Filtered: ${escapeHtml(desc)}</strong>
          <small>${state.contextOverride ? 'Showing all notes' : 'Only context-matching notes shown'}</small>
        </div>
      </div>
      <button class="cb-toggle" id="cb-toggle-btn">${state.contextOverride ? 'Re-filter' : 'Show all'}</button>
      <button class="cb-end" id="cb-end-btn">End shift</button>
    </div>
  `;
}

function attachContextBannerHandlers() {
  document.getElementById('cb-toggle-btn')?.addEventListener('click', () => {
    state.contextOverride = !state.contextOverride;
    if (state.currentChild) viewChildGuide(state.currentChild);
    else renderSitterDashboard();
  });
  document.getElementById('cb-end-btn')?.addEventListener('click', endShiftFlow);
}

// ============================================================================
// QUICK STATUS + SHIFT LOG
// ============================================================================

const QUICK_STATUSES = [
  { label: 'Down for nap', icon: '💤', subtype: 'nap', extra: { subtype: 'start' } },
  { label: 'Awake from nap', icon: '😊', subtype: 'nap', extra: { subtype: 'end' } },
  { label: 'Just ate', icon: '🍽️', subtype: 'meal' },
  { label: 'Snack time', icon: '🍪', subtype: 'meal', extra: { snack: true } },
  { label: 'Diaper change', icon: '👶', subtype: 'diaper' },
  { label: 'Outside / playing', icon: '🌳', subtype: 'status' },
  { label: 'Watching TV', icon: '📺', subtype: 'status' },
  { label: 'In the bath', icon: '🛁', subtype: 'status' }
];

async function postQuickStatusFromUI(label, subtype, extra = {}) {
  if (!state.activeShift) {
    showToast('Start a shift first', 'error');
    return;
  }
  const result = await appendShiftLog(state.currentFamily.id, state.activeShift.id, {
    type: subtype || 'status',
    text: label,
    childId: state.currentChild || null,
    ...extra
  });
  if (result.success) showToast('Logged', 'success');
  else showToast(result.error || 'Could not log', 'error');
}

async function flagMomentFromUI(text) {
  if (!state.activeShift) {
    showToast('Start a shift first', 'error');
    return;
  }
  const result = await appendShiftLog(state.currentFamily.id, state.activeShift.id, {
    type: 'flag',
    text,
    flagged: true,
    childId: state.currentChild || null
  });
  if (result.success) {
    showToast('Flagged. Parent will be notified.', 'success');
    // Try a local notification too (best-effort)
    showLocalNotification('Flagged moment sent', { body: text, tag: 'cribnotes-flag' });
  } else {
    showToast(result.error || 'Could not flag', 'error');
  }
}

async function renderShiftLogScreen() {
  if (!state.activeShift) {
    showToast('No active shift', 'error');
    return;
  }
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">Shift Log</h1>
      </header>
      ${renderContextBanner()}
      <main class="app-content">
        <div class="container">
          <div class="quick-status-grid">
            ${QUICK_STATUSES.map((s, idx) => `
              <button class="qs-card" data-idx="${idx}">
                <span class="qs-icon">${s.icon}</span>
                <span class="qs-label">${escapeHtml(s.label)}</span>
              </button>
            `).join('')}
          </div>

          <div class="log-input-row">
            <input type="text" id="log-text" placeholder="Add a note to the log..." class="search-input">
            <button class="btn btn-primary" id="log-post-btn">Log</button>
            <button class="btn" id="log-flag-btn" style="background: var(--color-coral); color: white;">🚩 Flag</button>
          </div>

          <div id="log-feed" class="log-feed">
            <p class="text-muted">Loading log...</p>
          </div>
        </div>
      </main>
      ${renderSitterBottomNav('log')}
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', renderSitterDashboard);
  attachContextBannerHandlers();

  document.querySelectorAll('.qs-card').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const s = QUICK_STATUSES[idx];
      await postQuickStatusFromUI(s.label, s.subtype, s.extra || {});
    });
  });

  document.getElementById('log-post-btn').addEventListener('click', async () => {
    const text = document.getElementById('log-text').value.trim();
    if (!text) return;
    document.getElementById('log-text').value = '';
    await postQuickStatusFromUI(text, 'note');
  });

  document.getElementById('log-flag-btn').addEventListener('click', async () => {
    const text = document.getElementById('log-text').value.trim() || 'Flagged moment';
    document.getElementById('log-text').value = '';
    await flagMomentFromUI(text);
  });

  // Real-time subscribe
  if (state.shiftLogUnsubscribe) state.shiftLogUnsubscribe();
  state.shiftLogUnsubscribe = subscribeShiftLog(state.currentFamily.id, state.activeShift.id, (entries) => {
    const feed = document.getElementById('log-feed');
    if (!feed) return;
    if (!entries.length) {
      feed.innerHTML = '<p class="text-muted">No log entries yet. Use a quick status or type a note above.</p>';
      return;
    }
    feed.innerHTML = entries.slice().reverse().map(e => `
      <div class="log-entry ${e.flagged ? 'flagged' : ''}">
        <span class="le-icon">${eventIcon(e.type)}</span>
        <div class="le-body">
          <strong>${escapeHtml(e.text || e.type)}</strong>
          <small>${escapeHtml(e.authorName || '')} &middot; ${formatTime(e.timestamp)}</small>
        </div>
      </div>
    `).join('');
  });

  mountEmergencyButton();
}

// ============================================================================
// MEDICATIONS UI
// ============================================================================

async function renderMedicationsScreen(childId) {
  state.currentChild = childId;
  const childResult = await getChild(state.currentFamily.id, childId);
  if (!childResult.success) {
    showToast('Error loading child', 'error');
    return;
  }
  const child = childResult.data;
  const medsResult = await listMedications(state.currentFamily.id, childId);
  const meds = medsResult.success ? medsResult.data : [];
  const isParent = state.userData.role === 'parent';

  const statusResult = await getMedicationStatus(state.currentFamily.id, childId);
  const status = statusResult.success ? statusResult.data : { due: [], soon: [], administeredToday: [] };

  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">${escapeHtml(child.name)}'s Meds</h1>
        ${isParent ? `<button class="btn-icon" id="add-med-btn">+</button>` : ''}
      </header>
      <main class="app-content">
        <div class="container">
          ${status.due.length ? `
            <div class="med-due-banner">
              <strong>${status.due.length} dose${status.due.length > 1 ? 's' : ''} due now</strong>
            </div>` : ''}

          ${meds.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">💊</div>
              <h3>No medications yet</h3>
              ${isParent ? `<button class="btn btn-primary" id="add-med-empty-btn">Add Medication</button>` : ''}
            </div>
          ` : `
            <div class="meds-list">
              ${meds.map(m => {
                const due = status.due.find(d => d.med.id === m.id);
                const soon = status.soon.find(d => d.med.id === m.id);
                const adminEntry = status.administeredToday.find(a => a.med.id === m.id);
                const givenCount = adminEntry?.dosesToday?.length || 0;
                return `
                <div class="med-card ${due ? 'due' : (soon ? 'soon' : '')}">
                  <div class="med-header">
                    <h3>${escapeHtml(m.name)}</h3>
                    ${due ? `<span class="med-badge due-badge">Due now</span>` :
                       soon ? `<span class="med-badge soon-badge">Soon</span>` : ''}
                  </div>
                  <p class="med-dose">${escapeHtml(m.dose || 'Dose not set')} ${m.route ? `&middot; ${escapeHtml(m.route)}` : ''}</p>
                  ${(m.scheduledTimes || []).length ? `
                    <p class="med-schedule">Scheduled: ${m.scheduledTimes.map(t => escapeHtml(t)).join(', ')}</p>` : ''}
                  ${m.notes ? `<p class="med-notes">${escapeHtml(m.notes)}</p>` : ''}
                  <p class="med-given-today">Given today: <strong>${givenCount}</strong></p>
                  <div class="med-actions">
                    <button class="btn btn-primary med-give-btn" data-med-id="${m.id}">Record Dose</button>
                    <button class="btn btn-outline med-history-btn" data-med-id="${m.id}">History</button>
                    ${isParent ? `<button class="btn btn-outline med-remove-btn" data-med-id="${m.id}" style="color: var(--color-coral); border-color: var(--color-coral);">Remove</button>` : ''}
                  </div>
                </div>`;
              }).join('')}
            </div>
          `}
        </div>
      </main>
      ${state.userData.role === 'babysitter' && state.activeShift ? renderSitterBottomNav('meds') : ''}
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', () => {
    if (state.userData.role === 'parent') viewChildGuide(childId);
    else renderSitterDashboard();
  });
  document.getElementById('add-med-btn')?.addEventListener('click', () => renderAddMedicationForm(childId));
  document.getElementById('add-med-empty-btn')?.addEventListener('click', () => renderAddMedicationForm(childId));

  document.querySelectorAll('.med-give-btn').forEach(btn =>
    btn.addEventListener('click', () => recordDoseFromUI(childId, btn.dataset.medId)));
  document.querySelectorAll('.med-history-btn').forEach(btn =>
    btn.addEventListener('click', () => showMedHistory(childId, btn.dataset.medId)));
  document.querySelectorAll('.med-remove-btn').forEach(btn =>
    btn.addEventListener('click', () => removeMedicationConfirm(childId, btn.dataset.medId)));

  mountEmergencyButton();
}

function renderAddMedicationForm(childId) {
  showModal(`
    <h3>Add Medication</h3>
    <input id="med-name" class="form-input" placeholder="Name (e.g., Tylenol)">
    <input id="med-dose" class="form-input" placeholder="Dose (e.g., 5 mL)">
    <input id="med-route" class="form-input" placeholder="Route (oral, topical, etc.)">
    <input id="med-times" class="form-input" placeholder="Scheduled times (e.g., 08:00, 14:00, 20:00)">
    <input id="med-cooldown" class="form-input" type="number" min="0" step="0.5" placeholder="Cooldown hours (default 4)">
    <label style="display: flex; align-items: center; gap: 8px; margin: 8px 0;">
      <input type="checkbox" id="med-asneeded">
      <span>As-needed (PRN), no schedule</span>
    </label>
    <textarea id="med-notes" class="form-input" rows="2" placeholder="Notes for sitter"></textarea>
    <div style="display: flex; gap: 8px; margin-top: 16px;">
      <button class="btn btn-primary" id="med-save-btn">Save</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
  document.getElementById('med-save-btn').addEventListener('click', async () => {
    const name = document.getElementById('med-name').value.trim();
    if (!name) { showToast('Name required', 'error'); return; }
    const dose = document.getElementById('med-dose').value.trim();
    const route = document.getElementById('med-route').value.trim();
    const timesText = document.getElementById('med-times').value.trim();
    const scheduledTimes = timesText.split(',').map(t => t.trim()).filter(Boolean);
    const cooldownHours = parseFloat(document.getElementById('med-cooldown').value) || 4;
    const asNeeded = document.getElementById('med-asneeded').checked;
    const notes = document.getElementById('med-notes').value.trim();

    showLoading();
    closeModal();
    const result = await addMedication(state.currentFamily.id, childId, {
      name, dose, route, scheduledTimes, cooldownHours, asNeeded, notes
    });
    hideLoading();
    if (!result.success) showToast(result.error, 'error');
    else { showToast('Medication added', 'success'); renderMedicationsScreen(childId); }
  });
}

async function recordDoseFromUI(childId, medId, force = false) {
  showLoading();
  const result = await recordDose(state.currentFamily.id, childId, medId, { force });
  hideLoading();

  if (!result.success && result.warning === 'cooldown') {
    showModal(`
      <h3 style="color: var(--color-coral);">⚠️ Possible Double Dose</h3>
      <p>${escapeHtml(result.error)}</p>
      <p style="font-size: 0.9em; color: var(--color-text-light); margin-top: 12px;">
        Only override if you're certain the previous dose was incorrectly logged or
        the medication's schedule allows it.
      </p>
      <div style="display: flex; gap: 8px; margin-top: 16px;">
        <button class="btn btn-primary" id="force-dose-btn" style="flex: 1; background: var(--color-coral);">Override &amp; Record</button>
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      </div>
    `);
    document.getElementById('force-dose-btn').addEventListener('click', async () => {
      closeModal();
      await recordDoseFromUI(childId, medId, true);
    });
    return;
  }

  if (!result.success) { showToast(result.error || 'Could not record dose', 'error'); return; }

  // Log into shift if active
  if (state.activeShift) {
    await appendShiftLog(state.currentFamily.id, state.activeShift.id, {
      type: 'medication',
      text: `Recorded dose at ${new Date(result.givenAt).toLocaleTimeString()}`,
      childId, medId, forced: force
    });
  }

  showToast('Dose recorded', 'success');
  renderMedicationsScreen(childId);
}

async function showMedHistory(childId, medId) {
  showLoading();
  const result = await listDoses(state.currentFamily.id, childId, medId, 20);
  hideLoading();
  const doses = result.success ? result.data : [];
  showModal(`
    <h3>Dose History</h3>
    ${doses.length === 0 ? '<p class="text-muted">No doses recorded yet.</p>' : `
      <ul class="dose-history">
        ${doses.map(d => `
          <li>
            <strong>${new Date(d.givenAtMs).toLocaleString()}</strong>
            <small>By ${escapeHtml(d.givenByName || 'Unknown')}${d.forced ? ' (override)' : ''}${d.note ? ` &middot; ${escapeHtml(d.note)}` : ''}</small>
          </li>`).join('')}
      </ul>
    `}
    <button class="btn btn-outline btn-full" onclick="closeModal()" style="margin-top: 12px;">Close</button>
  `);
}

async function removeMedicationConfirm(childId, medId) {
  if (!confirm('Remove this medication from the schedule? Dose history will be preserved.')) return;
  showLoading();
  const result = await deactivateMedication(state.currentFamily.id, childId, medId);
  hideLoading();
  if (!result.success) showToast(result.error, 'error');
  else { showToast('Removed', 'success'); renderMedicationsScreen(childId); }
}

async function checkPendingMedications() {
  if (!state.currentChild) return;
  const result = await getMedicationStatus(state.currentFamily.id, state.currentChild);
  if (!result.success) return;
  const due = result.data.due || [];
  if (!due.length) return;
  // Surface the first due med with a one-time notification per session
  due.forEach(d => {
    const tag = `med-${d.med.id}-${d.scheduledTime}`;
    if (state.pendingMedReminders.includes(tag)) return;
    state.pendingMedReminders.push(tag);
    showLocalNotification(`💊 ${d.med.name} is due`, {
      body: `${d.med.dose || 'Dose'} scheduled at ${d.scheduledTime}`,
      tag,
      requireInteraction: true
    });
  });
}

// ============================================================================
// SITTER BOTTOM NAV
// ============================================================================

function renderSitterBottomNav(active = 'home') {
  return `
    <nav class="bottom-nav">
      <button class="nav-item ${active === 'home' ? 'active' : ''}" id="nav-home">
        <span class="icon">🏠</span><span>Home</span>
      </button>
      <button class="nav-item ${active === 'guide' ? 'active' : ''}" id="nav-guide">
        <span class="icon">📖</span><span>Guide</span>
      </button>
      <button class="nav-item ${active === 'log' ? 'active' : ''}" id="nav-log">
        <span class="icon">📍</span><span>Log</span>
      </button>
      <button class="nav-item ${active === 'meds' ? 'active' : ''}" id="nav-meds">
        <span class="icon">💊</span><span>Meds</span>
      </button>
      <button class="nav-item ${active === 'messages' ? 'active' : ''}" id="nav-messages">
        <span class="icon">💬</span><span>Chat</span>
      </button>
    </nav>
  `;
}

function attachSitterBottomNavHandlers() {
  document.getElementById('nav-home')?.addEventListener('click', renderSitterDashboard);
  document.getElementById('nav-guide')?.addEventListener('click', () => {
    if (state.currentChild) viewChildGuide(state.currentChild);
    else renderSitterDashboard();
  });
  document.getElementById('nav-log')?.addEventListener('click', renderShiftLogScreen);
  document.getElementById('nav-meds')?.addEventListener('click', () => {
    if (state.currentChild) renderMedicationsScreen(state.currentChild);
    else showToast('Select a child first', 'info');
  });
  document.getElementById('nav-messages')?.addEventListener('click', renderMessagesScreen);
}

// ============================================================================
// CONTEXT-AWARE GUIDE WRAPPER
// (Filters guide items by the active shift's contextTags before rendering)
// ============================================================================

/**
 * Returns the guide filtered by the current sitter context, OR the unfiltered
 * guide for parents / when contextOverride is set.
 */
function applyContextFilter(guide) {
  if (state.userData?.role !== 'babysitter') return guide;
  if (state.contextOverride) return guide;
  if (!state.contextTags?.length) return guide;
  return filterGuideByContext(guide, state.contextTags);
}

// ============================================================================
// HELPERS
// ============================================================================

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Make global functions available
window.viewChildGuide = viewChildGuide;
window.renderChildChecklists = renderChildChecklists;
window.handleUpdateChecklistItem = handleUpdateChecklistItem;
window.deleteChecklistConfirm = deleteChecklistConfirm;
window.renderAddChecklistForm = renderAddChecklistForm;
window.saveChecklist = saveChecklist;
window.renderChildPhotos = renderChildPhotos;
window.deletePhotoConfirm = deletePhotoConfirm;
window.renderUploadPhotoForm = renderUploadPhotoForm;
window.uploadPhoto = uploadPhoto;
window.editGuideSection = editGuideSection;
window.saveGuideSection = saveGuideSection;
window.renderParentDashboard = renderParentDashboard;
window.renderSitterDashboard = renderSitterDashboard;
window.renderMessagesScreen = renderMessagesScreen;
window.renderEmergencyContacts = renderEmergencyContacts;
window.renderDictationScreen = renderDictationScreen;
window.copyInviteCode = copyInviteCode;
window.handleLogout = handleLogout;
window.switchProfile = switchProfile;
window.renderProfileSettings = renderProfileSettings;
window.renderAddChildForm = renderAddChildForm;
window.renderEditChildForm = renderEditChildForm;
window.deleteChildConfirm = deleteChildConfirm;
window.clearGuideConfirm = clearGuideConfirm;
window.saveChild = saveChild;
window.closeModal = closeModal;
window.showToast = showToast;
window.getSectionLabel = getSectionLabel;
window.selectCategory = null;

// Shift / context / medication / emergency / settings
window.endShiftFlow = endShiftFlow;
window.renderShiftLogScreen = renderShiftLogScreen;
window.renderMedicationsScreen = renderMedicationsScreen;
window.renderEditCriticalInfoForm = renderEditCriticalInfoForm;
window.renderSitterPermissionsScreen = renderSitterPermissionsScreen;
window.renderShiftHistoryScreen = renderShiftHistoryScreen;
window.renderInviteSitterScreen = renderInviteSitterScreen;
window.switchFamilyOrRole = switchFamilyOrRole;
window.enablePushFromSettings = enablePushFromSettings;
window.recordDoseFromUI = recordDoseFromUI;
window.removeMedicationConfirm = removeMedicationConfirm;
window.showMedHistory = showMedHistory;
window.flagMomentFromUI = flagMomentFromUI;
window.postQuickStatusFromUI = postQuickStatusFromUI;
window.renderEmergencyStack = renderEmergencyStack;
