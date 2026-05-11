/**
 * Firestore Database Module
 * Handles: families, children, care guides, checklists, messages, photos
 */

import { getFirestore, getCurrentUser } from './auth.js';

const db = () => getFirestore();

/**
 * Family Operations
 */

export async function createFamily(familyName) {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('No user logged in');

    // Generate 6-character invite code
    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    const familyRef = await db().collection('families').add({
      name: familyName,
      inviteCode: inviteCode,
      parentIds: [user.uid],
      sitterIds: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: user.uid
    });

    // Update user profile with family ID
    await db().collection('users').doc(user.uid).update({
      familyId: familyRef.id
    });

    return { success: true, familyId: familyRef.id, inviteCode };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getFamily(familyId) {
  try {
    const doc = await db().collection('families').doc(familyId).get();
    if (!doc.exists) throw new Error('Family not found');
    return { success: true, data: { id: doc.id, ...doc.data() } };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function updateFamily(familyId, updates) {
  try {
    await db().collection('families').doc(familyId).update(updates);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Join family with invite code
 */
export async function joinFamilyWithCode(inviteCode) {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('No user logged in');

    // Find family by invite code
    const query = await db().collection('families').where('inviteCode', '==', inviteCode).get();
    if (query.empty) throw new Error('Invalid invite code');

    const familyDoc = query.docs[0];
    const familyId = familyDoc.id;
    const familyData = familyDoc.data();

    // Determine user role and add to appropriate array
    const userRole = (await db().collection('users').doc(user.uid).get()).data().role;

    if (userRole === 'babysitter') {
      // Add to sitterIds
      await db().collection('families').doc(familyId).update({
        sitterIds: firebase.firestore.FieldValue.arrayUnion(user.uid)
      });
    } else if (userRole === 'parent') {
      // Add to parentIds
      await db().collection('families').doc(familyId).update({
        parentIds: firebase.firestore.FieldValue.arrayUnion(user.uid)
      });
    }

    // Update user's family ID
    await db().collection('users').doc(user.uid).update({
      familyId: familyId
    });

    return { success: true, familyId };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Children Operations
 */

export async function addChild(familyId, name, age, avatar = null, critical = {}) {
  try {
    const childRef = await db().collection('families').doc(familyId)
      .collection('children').add({
        name,
        age,
        avatar,
        // Critical, always-on info pinned to the top of the guide.
        // These fields are surfaced to sitters at all times regardless of context.
        critical: {
          allergies: critical.allergies || [],          // [{ allergen, severity, reaction, treatment }]
          medications: critical.medications || [],       // [{ name, dose, schedule, notes }] -- summary; full schedule lives in /medications subcollection
          insurance: critical.insurance || {},           // { provider, policyNumber, groupNumber, memberName, phone }
          conditions: critical.conditions || [],         // [{ name, notes }]
          bloodType: critical.bloodType || '',
          pediatrician: critical.pediatrician || {},     // { name, phone, address }
          emergencyContacts: critical.emergencyContacts || [] // [{ name, relationship, phone }]
        },
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

    // Initialize empty care guide
    await db().collection('families').doc(familyId)
      .collection('children').doc(childRef.id)
      .collection('careGuide').doc('sections').set({
        emergencyContacts: [],
        dailySchedule: [],
        meals: [],
        napsBedtime: [],
        diapersPotty: [],
        safetyTips: [],
        locations: [],
        tvEntertainment: [],
        carTravel: [],
        activities: [],
        medicalInfo: []
      });

    return { success: true, childId: childRef.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getChildren(familyId) {
  try {
    const snapshot = await db().collection('families').doc(familyId)
      .collection('children').orderBy('createdAt', 'desc').get();

    const children = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return { success: true, data: children };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getChild(familyId, childId) {
  try {
    const doc = await db().collection('families').doc(familyId)
      .collection('children').doc(childId).get();

    if (!doc.exists) throw new Error('Child not found');
    return { success: true, data: { id: doc.id, ...doc.data() } };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function updateChild(familyId, childId, updates) {
  try {
    await db().collection('families').doc(familyId)
      .collection('children').doc(childId).update(updates);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function deleteChild(familyId, childId) {
  try {
    await db().collection('families').doc(familyId)
      .collection('children').doc(childId).delete();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Care Guide Operations
 */

const GUIDE_SECTIONS = [
  'emergencyContacts',
  'dailySchedule',
  'meals',
  'napsBedtime',
  'diapersPotty',
  'safetyTips',
  'locations',
  'tvEntertainment',
  'carTravel',
  'activities',
  'medicalInfo'
];

const SECTION_LABELS = {
  emergencyContacts: 'Emergency Contacts',
  dailySchedule: 'Daily Schedule',
  meals: 'Meals & Snacks',
  napsBedtime: 'Naps & Bedtime',
  diapersPotty: 'Diapers & Potty',
  safetyTips: 'Safety Tips',
  locations: 'Locations',
  tvEntertainment: 'TV & Entertainment',
  carTravel: 'Car & Travel',
  activities: 'Activities',
  medicalInfo: 'Medical Info'
};

export function getGuideSections() {
  return GUIDE_SECTIONS;
}

export function getSectionLabel(sectionKey) {
  return SECTION_LABELS[sectionKey] || sectionKey;
}

export async function getCareGuide(familyId, childId) {
  try {
    const doc = await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('careGuide').doc('sections').get();

    if (!doc.exists) {
      // Initialize if not exists
      const init = {};
      GUIDE_SECTIONS.forEach(section => {
        init[section] = [];
      });
      await db().collection('families').doc(familyId)
        .collection('children').doc(childId)
        .collection('careGuide').doc('sections').set(init);
      return { success: true, data: init };
    }

    return { success: true, data: doc.data() };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function updateGuideSection(familyId, childId, sectionKey, items) {
  try {
    const updateData = {};
    updateData[sectionKey] = items;

    await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('careGuide').doc('sections').update(updateData);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function addGuideItem(familyId, childId, sectionKey, item) {
  try {
    const updateData = {};
    updateData[sectionKey] = firebase.firestore.FieldValue.arrayUnion(item);

    // Use set with merge so it works even if the doc doesn't exist yet
    await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('careGuide').doc('sections').set(updateData, { merge: true });

    return { success: true };
  } catch (error) {
    console.error('[CribNotes] addGuideItem error:', error);
    return { success: false, error: error.message };
  }
}

export async function removeGuideItem(familyId, childId, sectionKey, item) {
  try {
    const updateData = {};
    updateData[sectionKey] = firebase.firestore.FieldValue.arrayRemove(item);

    await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('careGuide').doc('sections').update(updateData);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function clearCareGuide(familyId, childId) {
  try {
    const init = {};
    GUIDE_SECTIONS.forEach(section => {
      init[section] = [];
    });
    await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('careGuide').doc('sections').set(init);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Checklist Operations
 */

export async function createChecklist(familyId, childId, title, items) {
  try {
    const checklistRef = await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('checklists').add({
        title,
        items: items.map(text => ({ text, done: false })),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        completedAt: null
      });

    return { success: true, checklistId: checklistRef.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getChecklists(familyId, childId) {
  try {
    const snapshot = await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('checklists').orderBy('createdAt', 'desc').get();

    const checklists = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return { success: true, data: checklists };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function updateChecklistItem(familyId, childId, checklistId, itemIndex, done) {
  try {
    const doc = await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('checklists').doc(checklistId).get();

    const items = doc.data().items;
    items[itemIndex].done = done;

    // Check if all items are done
    const allDone = items.every(item => item.done);

    await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('checklists').doc(checklistId).update({
        items,
        completedAt: allDone ? firebase.firestore.FieldValue.serverTimestamp() : null
      });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function deleteChecklist(familyId, childId, checklistId) {
  try {
    await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('checklists').doc(checklistId).delete();

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Message Operations (real-time chat)
 */

export async function sendMessage(familyId, text, type = 'text') {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('No user logged in');

    await db().collection('families').doc(familyId)
      .collection('messages').add({
        from: user.uid,
        fromName: user.displayName || user.email,
        text,
        type,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        read: false
      });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getMessages(familyId, onNewMessage) {
  try {
    // Set up real-time listener
    const unsubscribe = db().collection('families').doc(familyId)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .onSnapshot(snapshot => {
        const messages = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        onNewMessage(messages);
      });

    return { success: true, unsubscribe };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Photo Operations
 */

export async function addPhotoMetadata(familyId, childId, photoUrl, caption = '') {
  try {
    await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('photos').add({
        url: photoUrl,
        caption,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        uploadedBy: getCurrentUser().uid
      });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getPhotos(familyId, childId) {
  try {
    const snapshot = await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('photos').orderBy('createdAt', 'desc').get();

    const photos = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return { success: true, data: photos };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function deletePhoto(familyId, childId, photoId) {
  try {
    await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('photos').doc(photoId).delete();

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Critical Info Operations
 * Critical info (allergies, current meds summary, insurance, blood type,
 * pediatrician) is pinned permanently to the top of the guide and is
 * NEVER context-filtered. Sitters always see this regardless of shift.
 */

export async function updateCriticalInfo(familyId, childId, criticalUpdates) {
  try {
    const updates = {};
    Object.entries(criticalUpdates).forEach(([key, value]) => {
      updates[`critical.${key}`] = value;
    });
    await db().collection('families').doc(familyId)
      .collection('children').doc(childId).update(updates);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getCriticalInfo(familyId, childId) {
  try {
    const doc = await db().collection('families').doc(familyId)
      .collection('children').doc(childId).get();
    if (!doc.exists) return { success: false, error: 'Child not found' };
    const data = doc.data();
    return { success: true, data: data.critical || {} };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Quick Status Updates
 * One-tap statuses ("Down for nap", "Just ate", etc.) flow into the active
 * shift's chronological log. This wrapper exists so callers don't need to
 * import shift.js directly.
 */
export async function postQuickStatus(familyId, shiftId, status, extra = {}) {
  try {
    const user = getCurrentUser();
    if (!shiftId) throw new Error('No active shift');
    await db().collection('families').doc(familyId)
      .collection('shifts').doc(shiftId)
      .collection('log').add({
        type: 'status',
        text: status,
        ...extra,
        authorId: user?.uid || null,
        authorName: user?.displayName || user?.email || 'Unknown',
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Sitter Permissions per family
 * Parents can configure what each sitter is allowed to see/do.
 */
export async function setSitterPermissions(familyId, sitterId, permissions) {
  try {
    await db().collection('families').doc(familyId)
      .collection('sitterPermissions').doc(sitterId).set(permissions, { merge: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getSitterPermissions(familyId, sitterId) {
  try {
    const doc = await db().collection('families').doc(familyId)
      .collection('sitterPermissions').doc(sitterId).get();
    if (!doc.exists) {
      // Default permissions: full read, can post log, cannot edit guide
      return { success: true, data: {
        canViewGuide: true,
        canPostLog: true,
        canEditGuide: false,
        canViewPhotos: true,
        canPostPhotos: true,
        canFlagParents: true,
        canViewMessages: true,
        canViewMedications: true
      }};
    }
    return { success: true, data: doc.data() };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Enable Firestore offline persistence. Safe to call once during startup.
 */
export async function enableOfflinePersistence() {
  try {
    const fs = getFirestore();
    if (!fs) return { success: false };
    await fs.enablePersistence({ synchronizeTabs: true });
    return { success: true };
  } catch (error) {
    // failed-precondition: multiple tabs; unimplemented: browser unsupported
    return { success: false, error: error.code || error.message };
  }
}

/**
 * Family search + bidirectional join requests
 * ---------------------------------------------
 * A sitter can search for families by parent email or family name and request
 * to join. The parent sees pending requests and approves or declines.
 *
 * Stored at /joinRequests/{reqId} (top-level so sitters can read their own
 * requests even before they're a member of any family).
 */

export async function searchFamiliesByParentEmail(emailSubstring) {
  try {
    // Find users with role 'parent' whose email matches, then look up their families.
    // Firestore doesn't support substring search natively. We'll fetch a
    // bounded set and filter client-side. For a prototype this is fine.
    const usersSnap = await db().collection('users')
      .where('role', '==', 'parent').limit(50).get();
    const matches = usersSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(u => (u.email || '').toLowerCase().includes(emailSubstring.toLowerCase()) && u.familyId);

    const familyIds = Array.from(new Set(matches.map(m => m.familyId).filter(Boolean)));
    const families = [];
    for (const fid of familyIds) {
      const fdoc = await db().collection('families').doc(fid).get();
      if (fdoc.exists) {
        const fdata = fdoc.data();
        families.push({
          id: fdoc.id,
          name: fdata.name,
          parentNames: matches
            .filter(m => m.familyId === fid)
            .map(m => ({ name: m.name, email: m.email }))
        });
      }
    }
    return { success: true, data: families };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function requestToJoinFamily(familyId, message = '') {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('Not signed in');
    const userDoc = await db().collection('users').doc(user.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // Check if a pending request already exists
    const existing = await db().collection('joinRequests')
      .where('sitterId', '==', user.uid)
      .where('familyId', '==', familyId)
      .where('status', '==', 'pending')
      .limit(1).get();
    if (!existing.empty) {
      return { success: true, alreadyPending: true, requestId: existing.docs[0].id };
    }

    const ref = await db().collection('joinRequests').add({
      sitterId: user.uid,
      sitterName: userData.name || user.displayName || user.email,
      sitterEmail: user.email,
      familyId,
      status: 'pending',
      message,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true, requestId: ref.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function listMyJoinRequests() {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('Not signed in');
    const snap = await db().collection('joinRequests')
      .where('sitterId', '==', user.uid).get();
    const reqs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return { success: true, data: reqs };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function listFamilyJoinRequests(familyId) {
  try {
    const snap = await db().collection('joinRequests')
      .where('familyId', '==', familyId)
      .where('status', '==', 'pending').get();
    const reqs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return { success: true, data: reqs };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function approveJoinRequest(requestId) {
  try {
    const reqDoc = await db().collection('joinRequests').doc(requestId).get();
    if (!reqDoc.exists) throw new Error('Request not found');
    const req = reqDoc.data();

    // Add sitter to family
    await db().collection('families').doc(req.familyId).update({
      sitterIds: firebase.firestore.FieldValue.arrayUnion(req.sitterId)
    });
    // Set the sitter's familyId
    await db().collection('users').doc(req.sitterId).update({
      familyId: req.familyId
    });
    // Mark request approved
    await db().collection('joinRequests').doc(requestId).update({
      status: 'approved',
      resolvedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function declineJoinRequest(requestId) {
  try {
    await db().collection('joinRequests').doc(requestId).update({
      status: 'declined',
      resolvedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Search across care guide
 */
export async function searchGuide(familyId, childId, searchTerm) {
  try {
    const guideResult = await getCareGuide(familyId, childId);
    if (!guideResult.success) return guideResult;

    const guide = guideResult.data;
    const results = [];
    const term = searchTerm.toLowerCase();

    GUIDE_SECTIONS.forEach(sectionKey => {
      const items = guide[sectionKey] || [];
      const matchedItems = items.filter(item => {
        if (typeof item === 'string') {
          return item.toLowerCase().includes(term);
        } else if (typeof item === 'object' && item.text) {
          return item.text.toLowerCase().includes(term);
        }
        return false;
      });

      if (matchedItems.length > 0) {
        results.push({
          section: sectionKey,
          label: getSectionLabel(sectionKey),
          items: matchedItems
        });
      }
    });

    return { success: true, data: results };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
