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

/**
 * Self-heal helper: discover which family a sitter actually belongs to.
 *
 * This exists because the sitter's user-profile doc can lose track of its
 * familyId in a couple of ways:
 *   1. A parent approves a join request via approveJoinRequest(). That code
 *      adds the sitter to families/{id}.sitterIds AND tries to write
 *      familyId onto users/{sitterId} — but under the recommended Firestore
 *      rules, only the user themselves can write their own profile, so the
 *      user-doc write silently fails. The family side is correct; the user
 *      side is stale.
 *   2. Network glitch during joinFamilyWithCode / acceptFamilyInvite so the
 *      family write succeeds but the user-doc write doesn't.
 *
 * On sitter sign-in we call this; if it finds a family where the sitter is
 * already in sitterIds, we treat that as the source of truth and let the
 * caller persist familyId back onto the user's own doc (which they ARE
 * allowed to write under default rules).
 *
 * Returns { success, familyId } or { success: false, error }.
 */
/**
 * Update the current user's profile fields (name, phone). When a parent
 * updates these, also mirror them onto the family doc under
 * `parentContacts[uid] = { name, phone }` so sitters can read parent contact
 * info under default Firestore rules without needing per-user read access.
 */
export async function updateUserProfile(updates) {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('No user logged in');
    const userRef = db().collection('users').doc(user.uid);
    const clean = {};
    if (typeof updates.name === 'string') clean.name = updates.name;
    if (typeof updates.phone === 'string') clean.phone = updates.phone;
    if (Object.keys(clean).length === 0) return { success: true };
    await userRef.update(clean);
    // Mirror onto the active family doc so the emergency-mode dial can
    // discover parent contact info without per-user reads.
    try {
      const me = await userRef.get();
      const mine = me.exists ? me.data() : {};
      if (mine.familyId && mine.role === 'parent') {
        const famRef = db().collection('families').doc(mine.familyId);
        await famRef.update({
          [`parentContacts.${user.uid}`]: {
            name: clean.name || mine.name || '',
            phone: clean.phone || mine.phone || ''
          }
        });
      }
    } catch (e) {
      console.warn('Could not mirror profile to family doc:', e.message);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function findFamilyForSitter(uid) {
  try {
    if (!uid) throw new Error('No uid');
    // Primary: any family that already lists this sitter in sitterIds
    const snap = await db().collection('families')
      .where('sitterIds', 'array-contains', uid).limit(1).get();
    if (!snap.empty) {
      return { success: true, familyId: snap.docs[0].id };
    }
    // Secondary: a previously-approved join request still pinned to this sitter
    const approved = await db().collection('joinRequests')
      .where('sitterId', '==', uid)
      .where('status', '==', 'approved').limit(1).get();
    if (!approved.empty) {
      return { success: true, familyId: approved.docs[0].data().familyId };
    }
    return { success: false, error: 'No family found for this sitter' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * List EVERY family the current user belongs to (as parent or sitter).
 * Used by the onboarding/switch-role screen so a sitter can pick which
 * family to drop into without re-entering an invite code each session.
 * Returns [{ id, name, role, parentIds, sitterIds, ... }, ...]
 */
export async function listMyFamilies(uid) {
  try {
    const userId = uid || (getCurrentUser() && getCurrentUser().uid);
    if (!userId) throw new Error('No user');
    const [asParent, asSitter] = await Promise.all([
      db().collection('families').where('parentIds', 'array-contains', userId).get(),
      db().collection('families').where('sitterIds', 'array-contains', userId).get(),
    ]);
    const out = [];
    const seen = new Set();
    asParent.forEach(doc => {
      if (seen.has(doc.id)) return;
      seen.add(doc.id);
      out.push({ id: doc.id, role: 'parent', ...doc.data() });
    });
    asSitter.forEach(doc => {
      if (seen.has(doc.id)) return;
      seen.add(doc.id);
      out.push({ id: doc.id, role: 'babysitter', ...doc.data() });
    });
    return { success: true, data: out };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Set the current user's active family. Must be one they already belong to —
 * caller is responsible for verifying. Used when a sitter picks a different
 * family from the onboarding list.
 */
export async function setActiveFamily(familyId) {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('No user logged in');
    await db().collection('users').doc(user.uid).update({ familyId });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Sitter (or parent) removes THEMSELVES from a family. Pulls their uid out
 * of the family's parentIds/sitterIds and clears their active familyId if
 * it was pointing here.
 */
export async function leaveFamily(familyId) {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('No user logged in');
    const famRef = db().collection('families').doc(familyId);
    // Remove from both arrays — we don't know which one they were in, and
    // arrayRemove is a no-op when the value isn't present.
    await famRef.update({
      parentIds: firebase.firestore.FieldValue.arrayRemove(user.uid),
      sitterIds: firebase.firestore.FieldValue.arrayRemove(user.uid),
    });
    // If this was the user's active family, clear it.
    const userSnap = await db().collection('users').doc(user.uid).get();
    if (userSnap.exists && userSnap.data().familyId === familyId) {
      await db().collection('users').doc(user.uid).update({ familyId: null });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Parent-only: remove a sitter from this family. Pulls their uid out of
 * sitterIds. Does NOT touch the sitter's user doc (Firestore rules under the
 * default policy block writing into another user's doc); the sitter's
 * findFamilyForSitter() self-heal will discover they're no longer in any
 * family on their next sign-in.
 */
export async function removeSitterFromFamily(familyId, sitterUid) {
  try {
    if (!sitterUid) throw new Error('No sitter id');
    await db().collection('families').doc(familyId).update({
      sitterIds: firebase.firestore.FieldValue.arrayRemove(sitterUid),
    });
    return { success: true };
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
 * Message Operations (per-recipient threads).
 *
 * Schema (families/{familyId}/messages/{msgId}):
 *   from:       uid of sender
 *   fromName:   display name at send time
 *   to:         uid of recipient (null/undefined = legacy family-wide)
 *   toName:     display name at send time
 *   text:       message body
 *   type:       'text' (future: 'photo', 'flag')
 *   timestamp:  serverTimestamp
 *   readBy:     { [uid]: serverTimestamp }  -- who has read it
 */

/**
 * List the other members of the family (anyone except current user).
 * Returns [{ uid, name, email, role, avatarUrl }] from users collection.
 */
export async function listFamilyMembers(familyId) {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('No user logged in');
    const famDoc = await db().collection('families').doc(familyId).get();
    if (!famDoc.exists) throw new Error('Family not found');
    const fam = famDoc.data();
    const parentIds = Array.isArray(fam.parentIds) ? fam.parentIds : [];
    const sitterIds = Array.isArray(fam.sitterIds) ? fam.sitterIds : [];
    const allIds = Array.from(new Set([...parentIds, ...sitterIds])).filter(id => id !== user.uid);

    if (allIds.length === 0) return { success: true, data: [] };

    // Firestore 'in' supports up to 10 IDs; chunk if needed
    const chunks = [];
    for (let i = 0; i < allIds.length; i += 10) chunks.push(allIds.slice(i, i + 10));
    const results = [];
    for (const chunk of chunks) {
      const snap = await db().collection('users')
        .where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
      snap.forEach(doc => {
        const d = doc.data();
        const role = parentIds.includes(doc.id) ? 'parent' : 'babysitter';
        results.push({
          uid: doc.id,
          name: d.displayName || d.name || d.email || 'Member',
          email: d.email || '',
          role,
          avatarUrl: d.avatarUrl || null
        });
      });
    }
    // Sort: parents first then sitters, then alpha
    results.sort((a, b) => {
      if (a.role !== b.role) return a.role === 'parent' ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    return { success: true, data: results };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Send a direct message from the current user to `toUid` (or family-wide
 * broadcast if toUid is null).
 */
export async function sendMessage(familyId, text, opts = {}) {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('No user logged in');
    const toUid = opts.toUid || null;
    const toName = opts.toName || null;
    const type = opts.type || 'text';

    const payload = {
      from: user.uid,
      fromName: user.displayName || user.email || 'Member',
      to: toUid,
      toName,
      text,
      type,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      readBy: { [user.uid]: firebase.firestore.FieldValue.serverTimestamp() }
    };

    await db().collection('families').doc(familyId)
      .collection('messages').add(payload);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Live listener for the thread between `myUid` and `otherUid` in the given
 * family. Includes legacy family-wide messages (where to is null) so existing
 * data still shows up. Calls `onUpdate(messages)` with messages ordered oldest
 * to newest.
 */
export function listenThread(familyId, myUid, otherUid, onUpdate) {
  const col = db().collection('families').doc(familyId).collection('messages');
  // Two listeners: messages I sent to them, messages they sent to me.
  // Plus legacy broadcasts (to == null).
  const all = new Map();
  const emit = () => {
    const arr = Array.from(all.values()).sort((a, b) => {
      const ta = a.timestamp?.toMillis ? a.timestamp.toMillis() : 0;
      const tb = b.timestamp?.toMillis ? b.timestamp.toMillis() : 0;
      return ta - tb;
    });
    onUpdate(arr);
  };

  const subs = [];
  // Sent: from me to them
  subs.push(col.where('from', '==', myUid).where('to', '==', otherUid)
    .onSnapshot(snap => { snap.forEach(d => all.set(d.id, { id: d.id, ...d.data() })); emit(); }));
  // Received: from them to me
  subs.push(col.where('from', '==', otherUid).where('to', '==', myUid)
    .onSnapshot(snap => { snap.forEach(d => all.set(d.id, { id: d.id, ...d.data() })); emit(); }));

  return () => subs.forEach(unsub => unsub());
}

/**
 * Live listener over ALL messages involving the current user. Calls
 * `onUpdate({ threadsByPartner, totalUnread })` where threadsByPartner is a
 * map keyed by the other party's uid containing { otherUid, otherName,
 * lastMessage, lastTimestamp, lastFrom, unreadCount }.
 */
export function listenInbox(familyId, myUid, onUpdate) {
  const col = db().collection('families').doc(familyId).collection('messages');
  const all = new Map();

  const emit = () => {
    const threads = new Map();
    for (const m of all.values()) {
      const otherUid = m.from === myUid ? m.to : m.from;
      // Skip legacy broadcasts in inbox view (they'll show in a synthetic
      // "Everyone" thread if needed, but for now only show direct).
      if (!otherUid) continue;
      const otherName = m.from === myUid ? (m.toName || 'Member') : (m.fromName || 'Member');

      let t = threads.get(otherUid);
      if (!t) {
        t = { otherUid, otherName, lastMessage: '', lastTimestamp: null, lastFrom: null, unreadCount: 0 };
        threads.set(otherUid, t);
      }
      const ts = m.timestamp?.toMillis ? m.timestamp.toMillis() : 0;
      const cur = t.lastTimestamp?.toMillis ? t.lastTimestamp.toMillis() : 0;
      if (ts >= cur) {
        t.lastMessage = m.text || '';
        t.lastTimestamp = m.timestamp;
        t.lastFrom = m.from;
        // Keep latest name in case display name changed
        if (m.from !== myUid && m.fromName) t.otherName = m.fromName;
      }
      // Unread = sent to me by them AND I haven't acked it
      if (m.from !== myUid && m.from === otherUid) {
        const ackedByMe = m.readBy && m.readBy[myUid];
        if (!ackedByMe) t.unreadCount++;
      }
    }
    const list = Array.from(threads.values())
      .sort((a, b) => {
        const ta = a.lastTimestamp?.toMillis ? a.lastTimestamp.toMillis() : 0;
        const tb = b.lastTimestamp?.toMillis ? b.lastTimestamp.toMillis() : 0;
        return tb - ta;
      });
    const totalUnread = list.reduce((s, t) => s + t.unreadCount, 0);
    onUpdate({ threads: list, totalUnread });
  };

  const subs = [];
  subs.push(col.where('from', '==', myUid)
    .onSnapshot(snap => { snap.forEach(d => all.set(d.id, { id: d.id, ...d.data() })); emit(); }));
  subs.push(col.where('to', '==', myUid)
    .onSnapshot(snap => { snap.forEach(d => all.set(d.id, { id: d.id, ...d.data() })); emit(); }));

  return () => subs.forEach(unsub => unsub());
}

/**
 * Mark every unread message in the thread between me and otherUid as read.
 * Uses a batch write so it counts as one Firestore operation per chunk of 500.
 */
export async function markThreadRead(familyId, myUid, otherUid) {
  try {
    const col = db().collection('families').doc(familyId).collection('messages');
    const snap = await col.where('from', '==', otherUid).where('to', '==', myUid).get();
    const batch = db().batch();
    let count = 0;
    snap.forEach(doc => {
      const data = doc.data();
      if (data.readBy && data.readBy[myUid]) return;
      batch.update(doc.ref, {
        [`readBy.${myUid}`]: firebase.firestore.FieldValue.serverTimestamp()
      });
      count++;
    });
    if (count > 0) await batch.commit();
    return { success: true, count };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Backward-compat: getMessages still works for the old call site, returning
// every message in the family unfiltered. New code uses listenThread/listenInbox.
export async function getMessages(familyId, onNewMessage) {
  try {
    const unsubscribe = db().collection('families').doc(familyId)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .onSnapshot(snapshot => {
        const messages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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
 * Avatar / Profile Photo uploads
 * ---------------------------------------------
 * Uploads to Firebase Storage at:
 *   - /avatars/users/{uid}.{ext}              (user profile photo)
 *   - /avatars/families/{fid}/children/{cid}.{ext}  (child photo)
 * Returns a download URL that we also persist on the user / child Firestore doc
 * so the UI can render the avatar without hitting Storage SDK on every render.
 */

/**
 * Resize an image file to a square avatar (default 256px) on the client and
 * return a base64 data URL. We do this on the client so we can:
 *   - Avoid the Firebase Storage upgrade requirement (Spark-plan friendly).
 *   - Keep avatar payload under Firestore's 1MB-per-doc limit even for
 *     full-res phone photos.
 */
async function resizeImageToDataUrl(file, size = 256, quality = 0.82) {
  if (!file.type.startsWith('image/')) throw new Error('Must be an image');
  if (file.size > 10 * 1024 * 1024) throw new Error('Max 10MB');
  const bitmap = await createImageBitmap(file);
  // Source square crop: take the largest center square of the original
  const srcSize = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - srcSize) / 2;
  const sy = (bitmap.height - srcSize) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, srcSize, srcSize, 0, 0, size, size);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  // Firestore doc limit is 1MB; a 256x256 JPEG at q=0.82 is comfortably <100KB.
  // Guard anyway with a clear error so callers can show a useful message.
  if (dataUrl.length > 900 * 1024) throw new Error('Image too large after resize');
  return dataUrl;
}

export async function uploadUserAvatar(file) {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('Not signed in');
    if (!file) throw new Error('No file');

    const dataUrl = await resizeImageToDataUrl(file);
    await db().collection('users').doc(user.uid).update({ avatar: dataUrl });
    return { success: true, url: dataUrl };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function uploadChildAvatar(familyId, childId, file) {
  try {
    if (!file) throw new Error('No file');
    const dataUrl = await resizeImageToDataUrl(file);
    await db().collection('families').doc(familyId)
      .collection('children').doc(childId).update({ avatar: dataUrl });
    return { success: true, url: dataUrl };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function removeUserAvatar() {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('Not signed in');
    await db().collection('users').doc(user.uid).update({ avatar: null });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function removeChildAvatar(familyId, childId) {
  try {
    await db().collection('families').doc(familyId)
      .collection('children').doc(childId).update({ avatar: null });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
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

    // Add sitter to family — this is the authoritative source of truth.
    await db().collection('families').doc(req.familyId).update({
      sitterIds: firebase.firestore.FieldValue.arrayUnion(req.sitterId)
    });

    // Best-effort: try to set the sitter's familyId on their user doc. Under
    // the recommended Firestore rules a parent cannot write to a sitter's
    // user doc, so this will often throw permission-denied. That's fine —
    // findFamilyForSitter() in the sitter's auth flow will discover the
    // family from sitterIds on next sign-in and backfill it then.
    try {
      await db().collection('users').doc(req.sitterId).update({
        familyId: req.familyId
      });
    } catch (e) {
      console.warn('Could not write familyId onto sitter user doc (expected under default rules); sitter will self-heal on next sign-in:', e.message);
    }

    // Mark request approved — sitter reads this on sign-in as a backup signal.
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
 * Family Invites (parent → sitter direction)
 * ---------------------------------------------
 * The parent searches for a sitter by email and sends them an invite.
 * The sitter sees pending invites on the onboarding screen and can accept.
 *
 * Stored at /familyInvites/{inviteId}.
 */

export async function searchSittersByEmail(emailSubstring) {
  try {
    const snap = await db().collection('users')
      .where('role', '==', 'babysitter').limit(50).get();
    const matches = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(u => (u.email || '').toLowerCase().includes(emailSubstring.toLowerCase()));
    return { success: true, data: matches };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function inviteSitterByEmail(familyId, sitterEmail, sitterId = null, message = '') {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('Not signed in');
    const familyDoc = await db().collection('families').doc(familyId).get();
    const familyData = familyDoc.exists ? familyDoc.data() : {};

    // De-dupe pending invites for the same family + email
    const existing = await db().collection('familyInvites')
      .where('familyId', '==', familyId)
      .where('toSitterEmail', '==', sitterEmail.toLowerCase())
      .where('status', '==', 'pending')
      .limit(1).get();
    if (!existing.empty) {
      return { success: true, alreadyPending: true, inviteId: existing.docs[0].id };
    }

    const ref = await db().collection('familyInvites').add({
      familyId,
      familyName: familyData.name || 'Family',
      fromParentId: user.uid,
      fromParentName: user.displayName || user.email,
      toSitterEmail: sitterEmail.toLowerCase(),
      toSitterId: sitterId || null,
      status: 'pending',
      message,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true, inviteId: ref.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function listMyFamilyInvites() {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('Not signed in');
    // Match by email so invites work even before the user has a Firestore doc
    const snap = await db().collection('familyInvites')
      .where('toSitterEmail', '==', (user.email || '').toLowerCase())
      .where('status', '==', 'pending').get();
    return { success: true, data: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function listFamilyInvitesSent(familyId) {
  try {
    const snap = await db().collection('familyInvites')
      .where('familyId', '==', familyId)
      .where('status', '==', 'pending').get();
    return { success: true, data: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function acceptFamilyInvite(inviteId) {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('Not signed in');
    const inv = await db().collection('familyInvites').doc(inviteId).get();
    if (!inv.exists) throw new Error('Invite not found');
    const invData = inv.data();
    if ((invData.toSitterEmail || '').toLowerCase() !== (user.email || '').toLowerCase()) {
      throw new Error('This invite is for a different email');
    }
    await db().collection('families').doc(invData.familyId).update({
      sitterIds: firebase.firestore.FieldValue.arrayUnion(user.uid)
    });
    await db().collection('users').doc(user.uid).update({
      familyId: invData.familyId,
      role: 'babysitter'
    });
    await db().collection('familyInvites').doc(inviteId).update({
      status: 'accepted',
      toSitterId: user.uid,
      resolvedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true, familyId: invData.familyId };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function declineFamilyInvite(inviteId) {
  try {
    await db().collection('familyInvites').doc(inviteId).update({
      status: 'declined',
      resolvedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function cancelFamilyInvite(inviteId) {
  try {
    await db().collection('familyInvites').doc(inviteId).delete();
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
