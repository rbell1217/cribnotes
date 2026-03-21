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

export async function addChild(familyId, name, age, avatar = null) {
  try {
    const childRef = await db().collection('families').doc(familyId)
      .collection('children').add({
        name,
        age,
        avatar,
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
