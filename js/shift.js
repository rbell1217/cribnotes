/**
 * Shift Management Module
 * Tracks active sitter shifts in Firestore. A shift carries the date, start/end
 * time, type (short/half-day/full-day/overnight), special contexts, and a
 * chronological log of activities.
 *
 * The active shift is what drives the context engine: every screen the sitter
 * sees is filtered to match the running shift's context tags.
 */

import { getFirestore, getCurrentUser } from './auth.js';
import { computeContext } from './context.js';

const db = () => getFirestore();

const SHIFT_TYPES = {
  'short':     { label: 'Short visit',  hours: 2,  description: 'Under 4 hours' },
  'half-day':  { label: 'Half day',     hours: 6,  description: '4-8 hours' },
  'full-day':  { label: 'Full day',     hours: 10, description: '8-12 hours' },
  'overnight': { label: 'Overnight',    hours: 14, description: 'Includes nighttime' },
  'multi-day': { label: 'Multi-day',    hours: 24, description: 'More than one day' }
};

export function getShiftTypes() {
  return SHIFT_TYPES;
}

/**
 * Start a shift. Stores the shift in /families/{fid}/shifts/{sid}
 * and writes a pointer to the active shift on the family doc so all
 * sitters can see what's running and any in-flight handoff notes.
 */
export async function startShift(familyId, { startTime, shiftType, specials = [], note = '' }) {
  try {
    const user = getCurrentUser();
    if (!user) throw new Error('No user logged in');

    const start = startTime instanceof Date ? startTime : new Date(startTime);
    const expectedHours = SHIFT_TYPES[shiftType]?.hours || 4;
    const contextTags = computeContext(start, shiftType, expectedHours, specials);

    const shiftRef = await db().collection('families').doc(familyId)
      .collection('shifts').add({
        sitterId: user.uid,
        sitterName: user.displayName || user.email,
        startTime: firebase.firestore.Timestamp.fromDate(start),
        endTime: null,
        shiftType,
        specials,
        contextTags,
        startNote: note || '',
        endNote: '',
        active: true,
        summary: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

    // Record on the family doc for handoff awareness
    await db().collection('families').doc(familyId).update({
      activeShiftId: shiftRef.id,
      activeShiftSitterId: user.uid,
      activeShiftStartedAt: firebase.firestore.Timestamp.fromDate(start)
    });

    return { success: true, shiftId: shiftRef.id, contextTags };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * End a shift. Stores end time + handoff note, marks inactive,
 * and clears the family-level active pointer.
 */
export async function endShift(familyId, shiftId, { endNote = '', summary = null } = {}) {
  try {
    const ref = db().collection('families').doc(familyId)
      .collection('shifts').doc(shiftId);
    await ref.update({
      endTime: firebase.firestore.FieldValue.serverTimestamp(),
      endNote,
      summary,
      active: false
    });

    await db().collection('families').doc(familyId).update({
      activeShiftId: null,
      activeShiftSitterId: null,
      activeShiftStartedAt: null
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getActiveShift(familyId) {
  try {
    const family = await db().collection('families').doc(familyId).get();
    if (!family.exists) return { success: true, data: null };
    const data = family.data();
    if (!data.activeShiftId) return { success: true, data: null };
    const shift = await db().collection('families').doc(familyId)
      .collection('shifts').doc(data.activeShiftId).get();
    if (!shift.exists) return { success: true, data: null };
    return { success: true, data: { id: shift.id, ...shift.data() } };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getShift(familyId, shiftId) {
  try {
    const shift = await db().collection('families').doc(familyId)
      .collection('shifts').doc(shiftId).get();
    if (!shift.exists) return { success: false, error: 'Shift not found' };
    return { success: true, data: { id: shift.id, ...shift.data() } };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function listShifts(familyId, limit = 20) {
  try {
    const snapshot = await db().collection('families').doc(familyId)
      .collection('shifts').orderBy('createdAt', 'desc').limit(limit).get();
    const shifts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    return { success: true, data: shifts };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Append a chronological event to the shift log. Events include:
 *   - status:    one-tap quick status updates ("Down for nap")
 *   - meal:      meal/feeding entries
 *   - nap:       nap entries
 *   - diaper:    diaper changes
 *   - photo:     photo shares
 *   - note:      free-text notes
 *   - medication: medication administration
 *   - flag:      flagged moment (triggers a push to parents)
 */
export async function appendShiftLog(familyId, shiftId, entry) {
  try {
    const user = getCurrentUser();
    const ref = await db().collection('families').doc(familyId)
      .collection('shifts').doc(shiftId)
      .collection('log').add({
        ...entry,
        authorId: user?.uid || null,
        authorName: user?.displayName || user?.email || 'Unknown',
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });

    // Mirror flagged entries up to families/{fid}/flagged so parents can
    // be notified even if they aren't subscribed to that shift's log.
    if (entry.type === 'flag' || entry.flagged) {
      await db().collection('families').doc(familyId)
        .collection('flagged').add({
          shiftId,
          logEntryId: ref.id,
          ...entry,
          authorId: user?.uid || null,
          authorName: user?.displayName || user?.email || 'Unknown',
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
          acknowledged: false
        });
    }

    return { success: true, entryId: ref.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export function subscribeShiftLog(familyId, shiftId, onUpdate) {
  return db().collection('families').doc(familyId)
    .collection('shifts').doc(shiftId)
    .collection('log').orderBy('timestamp', 'asc')
    .onSnapshot(snap => {
      const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      onUpdate(entries);
    });
}

export async function getShiftLog(familyId, shiftId) {
  try {
    const snap = await db().collection('families').doc(familyId)
      .collection('shifts').doc(shiftId)
      .collection('log').orderBy('timestamp', 'asc').get();
    const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return { success: true, data: entries };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Aggregate a shift's log into a digestible summary for the parent.
 * Returns counts of meals, naps, diapers, photos, flagged moments, plus
 * total hours and a chronological list of notable events.
 */
export function summarizeShift(shift, logEntries) {
  const startMs = shift.startTime?.toMillis?.() || (shift.startTime instanceof Date ? shift.startTime.getTime() : Date.now());
  const endMs = shift.endTime?.toMillis?.() || Date.now();
  const totalMinutes = Math.max(0, Math.round((endMs - startMs) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const counts = { status: 0, meal: 0, nap: 0, diaper: 0, photo: 0, note: 0, medication: 0, flag: 0 };
  const napsTotalMinutes = []; // pairs of {start,end}
  let napStart = null;

  const flagged = [];
  const notable = [];

  (logEntries || []).forEach(entry => {
    counts[entry.type] = (counts[entry.type] || 0) + 1;
    if (entry.flagged) flagged.push(entry);
    if (entry.type === 'flag') flagged.push(entry);
    if (entry.type === 'medication') notable.push(entry);
    if (entry.type === 'nap') {
      const ts = entry.timestamp?.toMillis?.() || 0;
      if (entry.subtype === 'start') napStart = ts;
      else if (entry.subtype === 'end' && napStart) {
        napsTotalMinutes.push((ts - napStart) / 60000);
        napStart = null;
      }
    }
  });

  return {
    totalMinutes,
    hoursLabel: `${hours}h ${minutes}m`,
    counts,
    napMinutes: Math.round(napsTotalMinutes.reduce((s, n) => s + n, 0)),
    flagged,
    notable,
    startedAt: new Date(startMs),
    endedAt: new Date(endMs)
  };
}

/**
 * Subscribe to family-wide flagged entries for parent push.
 */
export function subscribeFlagged(familyId, onUpdate) {
  return db().collection('families').doc(familyId)
    .collection('flagged').orderBy('timestamp', 'desc').limit(20)
    .onSnapshot(snap => {
      const flagged = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      onUpdate(flagged);
    });
}

export async function acknowledgeFlag(familyId, flagId) {
  try {
    await db().collection('families').doc(familyId)
      .collection('flagged').doc(flagId).update({
        acknowledged: true,
        acknowledgedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
