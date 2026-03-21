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
  getCareGuide, updateGuideSection, addGuideItem, removeGuideItem,
  createChecklist, getChecklists, updateChecklistItem, deleteChecklist,
  sendMessage, getMessages,
  addPhotoMetadata, getPhotos, deletePhoto,
  searchGuide, getGuideSections, getSectionLabel
} from './database.js';

import {
  isSpeechRecognitionAvailable, categorizeText,
  startDictation, stopDictation, abortDictation
} from './dictation.js';

import { isFirebaseConfigured } from './config.js';

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
  messageUnsubscribe: null
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Check if Firebase is configured
  if (!isFirebaseConfigured()) {
    renderSetupRequired();
    return;
  }

  // Initialize Firebase
  const initialized = initializeFirebase();
  if (!initialized) {
    renderSetupRequired();
    return;
  }

  // Listen for auth state changes
  window.addEventListener('authStateChanged', async (e) => {
    const { user, userData } = e.detail;
    state.currentUser = user;
    state.userData = userData;

    if (user && userData) {
      // Load family data if user has one
      if (userData.familyId) {
        const familyResult = await getFamily(userData.familyId);
        if (familyResult.success) {
          state.currentFamily = familyResult.data;
        }
      }
    }

    // Route to appropriate screen
    await routeApp();
  });

  // Initial route
  await routeApp();
});

// ============================================================================
// ROUTING
// ============================================================================

async function routeApp() {
  if (!state.currentUser) {
    // User not logged in
    state.currentScreen = 'auth-login';
    renderAuthLogin();
  } else if (!state.userData) {
    // User logged in but no profile (shouldn't happen)
    await signOut();
    state.currentScreen = 'auth-login';
    renderAuthLogin();
  } else if (!state.userData.role) {
    // User logged in but no role set
    state.currentScreen = 'auth-role-select';
    renderRoleSelect();
  } else if (!state.currentFamily) {
    // User has role but no family
    if (state.userData.role === 'parent') {
      state.currentScreen = 'parent-onboarding';
      renderParentOnboarding();
    } else {
      state.currentScreen = 'sitter-onboarding';
      renderSitterOnboarding();
    }
  } else {
    // User fully set up with family
    if (state.userData.role === 'parent') {
      state.currentScreen = 'parent-dashboard';
      renderParentDashboard();
    } else {
      state.currentScreen = 'sitter-dashboard';
      renderSitterDashboard();
    }
  }
}

// ============================================================================
// SCREEN RENDERING FUNCTIONS
// ============================================================================

function renderSetupRequired() {
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="setup-container">
      <div class="setup-card">
        <h1>CribNotes Setup Required</h1>
        <p>Firebase is not yet configured. To get started:</p>
        <ol>
          <li>Go to <a href="https://console.firebase.google.com" target="_blank">Firebase Console</a></li>
          <li>Create a new project or use existing</li>
          <li>Enable Authentication (Email/Password and Google)</li>
          <li>Create a Firestore database</li>
          <li>Copy your project config from Project Settings</li>
          <li>Update <code>js/config.js</code> with your credentials</li>
          <li>Refresh this page</li>
        </ol>
        <p>See README.md for detailed instructions.</p>
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
  document.getElementById('go-to-signup').addEventListener('click', (e) => {
    e.preventDefault();
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

        <div class="auth-footer">
          <p>Already have an account? <a href="#" id="go-to-login">Sign in</a></p>
        </div>
      </div>
    </div>
  `;

  document.getElementById('signup-form').addEventListener('submit', handleSignup);
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

// ============================================================================
// ROLE SELECTION
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
    }
  });

  document.getElementById('select-sitter').addEventListener('click', async () => {
    showLoading();
    const result = await setUserRole('babysitter');
    if (!result.success) {
      showToast(result.error, 'error');
      hideLoading();
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
      // Route will be triggered by auth state change
    }
  });
}

// ============================================================================
// SITTER ONBOARDING
// ============================================================================

function renderSitterOnboarding() {
  const root = document.getElementById('app-root');
  root.innerHTML = `
    <div class="container container-small">
      <div class="card">
        <h1>Join a Family</h1>
        <p>Enter the invite code from the parent to join their family</p>

        <form id="invite-form" class="form">
          <div class="form-group">
            <label for="invite-code">Invite Code</label>
            <input type="text" id="invite-code" placeholder="e.g., ABC123" maxlength="6"
              style="text-transform: uppercase; letter-spacing: 0.15em; font-size: 1.2em; text-align: center;"
              required>
          </div>
          <button type="submit" class="btn btn-primary btn-full">Join Family</button>
        </form>

        <div class="divider"></div>

        <button id="logout-btn" class="btn btn-outline btn-full">Sign Out</button>
      </div>
    </div>
  `;

  document.getElementById('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('invite-code').value.toUpperCase();

    showLoading();
    const result = await joinFamilyWithCode(code);
    if (!result.success) {
      showToast(result.error || 'Invalid invite code', 'error');
      hideLoading();
    } else {
      showToast('Joined family!', 'success');
      state.currentFamily = { id: result.familyId };
    }
  });

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
            <h2>Welcome, ${state.userData.name}!</h2>
            <p>${state.currentFamily.name}</p>
          </div>

          <div class="quick-actions">
            <button class="action-btn action-btn-primary" id="dictate-btn">
              <span class="icon">🎤</span>
              <span>Dictate Guide</span>
            </button>
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
  document.getElementById('dictate-btn')?.addEventListener('click', async () => {
    if (children.length === 0) {
      showToast('Please add a child first', 'info');
      return;
    }
    await renderDictationScreen(children[0].id);
  });

  document.getElementById('messages-btn')?.addEventListener('click', () => {
    renderMessagesScreen();
  });

  document.getElementById('settings-btn')?.addEventListener('click', () => {
    renderParentSettings();
  });

  document.getElementById('add-child-btn')?.addEventListener('click', () => {
    renderAddChildForm();
  });

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

  // Load children for the family
  const childrenResult = await getChildren(state.currentFamily.id);
  const children = childrenResult.success ? childrenResult.data : [];

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
            <h2>Welcome, ${state.userData.name}!</h2>
            <p>${state.currentFamily.name}</p>
          </div>

          <div class="quick-actions">
            <button class="action-btn" id="messages-btn">
              <span class="icon">💬</span>
              <span>Chat</span>
            </button>
            <button class="action-btn" id="emergency-btn">
              <span class="icon">🚨</span>
              <span>Emergency</span>
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
                    <h4>${child.name}</h4>
                    <p>Age ${child.age}</p>
                    <button class="btn btn-small btn-primary" onclick="viewChildGuide('${child.id}')">View Care Guide</button>
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

  document.getElementById('emergency-btn')?.addEventListener('click', () => {
    renderEmergencyContacts();
  });

  document.getElementById('search-input')?.addEventListener('input', async (e) => {
    if (e.target.value.length < 2) return;
    await renderSearchResults(e.target.value);
  });

  document.getElementById('menu-btn')?.addEventListener('click', () => {
    renderSitterSettings();
  });

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const screen = btn.dataset.screen;
      if (screen === 'home') renderSitterDashboard();
      else if (screen === 'messages') renderMessagesScreen();
      else if (screen === 'photos') renderPhotosScreen();
    });
  });

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
  const guide = guideResult.success ? guideResult.data : {};

  const isParent = state.userData.role === 'parent';
  const root = document.getElementById('app-root');

  root.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-icon" id="back-btn">←</button>
        <h1 class="header-title">${child.name}'s Guide</h1>
        <button class="btn-icon" id="more-btn">⋯</button>
      </header>

      <main class="app-content">
        <div class="container">
          <div class="tabs">
            ${getGuideSections().map(section => `
              <button class="tab-btn" data-section="${section}">
                ${getSectionLabel(section)}
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
                    <p class="text-muted">No information added yet</p>
                  ` : `
                    <ul>
                      ${(guide[sectionKey] || []).map(item => `
                        <li>${typeof item === 'string' ? item : item.text || item}</li>
                      `).join('')}
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
      document.querySelector(`[data-section="${btn.dataset.section}"]`).style.display = 'block';
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

  document.getElementById('more-btn')?.addEventListener('click', () => {
    renderChildMenu(childId);
  });
}

function renderChildMenu(childId) {
  const isParent = state.userData.role === 'parent';
  showModal(`
    <h3>Options</h3>
    ${isParent ? `
      <button class="btn btn-full" onclick="renderEditChildForm('${childId}')">Edit Child</button>
      <button class="btn btn-full" onclick="deleteChildConfirm('${childId}')">Delete Child</button>
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

async function editGuideSection(sectionKey) {
  const child = await getChild(state.currentFamily.id, state.currentChild);
  const guide = await getCareGuide(state.currentFamily.id, state.currentChild);

  const items = (guide.data ? guide.data[sectionKey] : []) || [];
  const itemsText = items.map(item => typeof item === 'string' ? item : item.text).join('\n');

  showModal(`
    <h3>Edit ${getSectionLabel(sectionKey)}</h3>
    <textarea id="edit-items" rows="8" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">${itemsText}</textarea>
    <p style="font-size: 0.9em; color: #666; margin-top: 8px;">One item per line</p>
    <div style="display: flex; gap: 8px; margin-top: 16px;">
      <button class="btn btn-primary" onclick="saveGuideSection('${sectionKey}')">Save</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function saveGuideSection(sectionKey) {
  const text = document.getElementById('edit-items')?.value || '';
  const items = text.split('\n').map(s => s.trim()).filter(s => s.length > 0);

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
        <h1 class="header-title">Dictate Guide</h1>
      </header>

      <main class="app-content dictation-screen">
        <div class="container">
          <div class="dictation-card">
            <div id="recording-status" class="recording-status hidden">
              <div class="pulse-dot"></div>
              <span>Listening...</span>
            </div>

            <button id="mic-btn" class="mic-button">
              <span class="mic-icon">🎤</span>
              <span>Start Recording</span>
            </button>

            <div id="transcript-display" class="transcript-display">
              <p id="final-text" class="final-text"></p>
              <p id="interim-text" class="interim-text"></p>
            </div>

            <div id="categories" class="categories hidden">
              <h4>Suggested Categories:</h4>
              <div id="category-list"></div>
            </div>

            <div id="actions" class="actions hidden">
              <button class="btn btn-primary" id="save-btn">Save to Guide</button>
              <button class="btn btn-outline" id="retake-btn">Retake</button>
            </div>
          </div>
        </div>
      </main>
    </div>
  `;

  let isRecording = false;
  let finalTranscript = '';
  let selectedCategory = null;

  const micBtn = document.getElementById('mic-btn');
  const recordingStatus = document.getElementById('recording-status');
  const finalText = document.getElementById('final-text');
  const interimText = document.getElementById('interim-text');
  const categoriesDiv = document.getElementById('categories');
  const categoryList = document.getElementById('category-list');
  const actionsDiv = document.getElementById('actions');

  // Mic button listener
  micBtn.addEventListener('click', async () => {
    if (!isRecording) {
      isRecording = true;
      micBtn.classList.add('recording');
      recordingStatus.classList.remove('hidden');
      finalText.textContent = '';
      interimText.textContent = '';

      try {
        const result = await startDictation();
        if (result.success) {
          finalTranscript = result.transcript;
          isRecording = false;
          micBtn.classList.remove('recording');
          recordingStatus.classList.add('hidden');

          if (finalTranscript.length > 0) {
            finalText.textContent = finalTranscript;

            // Show categories
            const cats = categorizeText(finalTranscript);
            if (cats.length > 0) {
              categoryList.innerHTML = cats.map((cat, idx) => `
                <div class="category-option" onclick="selectCategory('${cat.category}', this)">
                  <input type="radio" name="category" value="${cat.category}"
                    ${idx === 0 ? 'checked' : ''}>
                  <label>${getSectionLabel(cat.category)}</label>
                  <span class="confidence">${Math.round(cat.confidence * 100)}%</span>
                </div>
              `).join('');
              selectedCategory = cats[0].category;

              categoriesDiv.classList.remove('hidden');
              actionsDiv.classList.remove('hidden');
            }
          }
        }
      } catch (error) {
        isRecording = false;
        micBtn.classList.remove('recording');
        recordingStatus.classList.add('hidden');
        showToast(error.message, 'error');
      }
    }
  });

  // Transcript updates
  window.addEventListener('dictationUpdate', (e) => {
    if (e.detail.interim) {
      interimText.textContent = '...'. + e.detail.interim;
    }
  });

  // Category selection
  window.selectCategory = function(category, element) {
    selectedCategory = category;
    document.querySelectorAll('.category-option input').forEach(r => r.checked = false);
    element.querySelector('input').checked = true;
  };

  // Save
  document.getElementById('save-btn')?.addEventListener('click', async () => {
    if (!finalTranscript || !selectedCategory) {
      showToast('Nothing to save', 'error');
      return;
    }

    showLoading();

    const result = await addGuideItem(
      state.currentFamily.id,
      childId,
      selectedCategory,
      finalTranscript
    );

    if (!result.success) {
      showToast(result.error, 'error');
      hideLoading();
    } else {
      showToast('Saved to ' + getSectionLabel(selectedCategory), 'success');
      setTimeout(() => viewChildGuide(childId), 1500);
    }
  });

  // Retake
  document.getElementById('retake-btn')?.addEventListener('click', () => {
    renderDictationScreen(childId);
  });

  // Back
  document.getElementById('back-btn')?.addEventListener('click', () => {
    stopDictation();
    renderParentDashboard();
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
                            onchange="updateChecklistItem('${childId}', '${checklist.id}', ${idx}, this.checked)">
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

async function updateChecklistItem(childId, checklistId, itemIndex, done) {
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
    <button class="btn btn-full" onclick="renderProfileSettings()">Profile</button>
    <button class="btn btn-outline btn-full" onclick="handleLogout()">Sign Out</button>
  `);
}

function renderSitterSettings() {
  showModal(`
    <h3>Settings</h3>
    <button class="btn btn-full" onclick="renderProfileSettings()">Profile</button>
    <button class="btn btn-outline btn-full" onclick="handleLogout()">Sign Out</button>
  `);
}

function renderProfileSettings() {
  showModal(`
    <h3>Profile</h3>
    <p><strong>Name:</strong> ${state.userData.name}</p>
    <p><strong>Email:</strong> ${state.userData.email}</p>
    <p><strong>Role:</strong> ${state.userData.role === 'parent' ? 'Parent/Guardian' : 'Babysitter'}</p>
  `);
}

function copyInviteCode() {
  const code = state.currentFamily.inviteCode;
  navigator.clipboard.writeText(code).then(() => {
    showToast('Copied!', 'success');
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

// Make global functions available
window.viewChildGuide = viewChildGuide;
window.renderChildChecklists = renderChildChecklists;
window.updateChecklistItem = updateChecklistItem;
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
window.renderProfileSettings = renderProfileSettings;
window.closeModal = closeModal;
window.showToast = showToast;
window.getSectionLabel = getSectionLabel;
window.selectCategory = null;
