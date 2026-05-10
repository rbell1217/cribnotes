/**
 * Medication Tracker
 *
 * Strict medication scheduling and dosing log. Designed to be safer than a
 * checklist: every administration must be confirmed, the app warns against
 * double-dosing within the medication's cooldown window, and a full history
 * is preserved per child.
 */

import { getFirestore, getCurrentUser } from './auth.js';

const db = () => getFirestore();

const DEFAULT_COOLDOWN_HOURS = 4;

/**
 * Add a medication to a child's schedule.
 * @param {string} familyId
 * @param {string} childId
 * @param {object} med - { name, dose, route, scheduledTimes:[HH:MM], cooldownHours, notes, asNeeded }
 */
export async function addMedication(familyId, childId, med) {
  try {
    const ref = await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('medications').add({
        name: med.name,
        dose: med.dose || '',
        route: med.route || 'oral',
        scheduledTimes: med.scheduledTimes || [],
        cooldownHours: med.cooldownHours || DEFAULT_COOLDOWN_HOURS,
        asNeeded: !!med.asNeeded,
        notes: med.notes || '',
        active: true,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    return { success: true, medId: ref.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function listMedications(familyId, childId) {
  try {
    const snap = await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('medications').where('active', '==', true).get();
    const meds = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return { success: true, data: meds };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function deactivateMedication(familyId, childId, medId) {
  try {
    await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('medications').doc(medId).update({ active: false });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Record a dose. Will REJECT if the last dose was within the cooldown window.
 */
export async function recordDose(familyId, childId, medId, { note = '', force = false } = {}) {
  try {
    const user = getCurrentUser();
    const medRef = db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('medications').doc(medId);
    const medSnap = await medRef.get();
    if (!medSnap.exists) throw new Error('Medication not found');
    const med = medSnap.data();

    // Check cooldown window unless forced
    if (!force) {
      const cooldownHours = med.cooldownHours || DEFAULT_COOLDOWN_HOURS;
      const cutoffMs = Date.now() - cooldownHours * 3600 * 1000;
      const recent = await medRef.collection('doses')
        .where('givenAtMs', '>', cutoffMs)
        .orderBy('givenAtMs', 'desc').limit(1).get();
      if (!recent.empty) {
        const last = recent.docs[0].data();
        return {
          success: false,
          warning: 'cooldown',
          error: `Last dose was less than ${cooldownHours}h ago at ${new Date(last.givenAtMs).toLocaleTimeString()}. Confirm to override.`,
          lastDose: last
        };
      }
    }

    const now = Date.now();
    await medRef.collection('doses').add({
      givenBy: user?.uid || null,
      givenByName: user?.displayName || user?.email || 'Unknown',
      givenAtMs: now,
      givenAt: firebase.firestore.FieldValue.serverTimestamp(),
      dose: med.dose,
      note,
      forced: !!force
    });

    return { success: true, givenAt: now };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function listDoses(familyId, childId, medId, limit = 20) {
  try {
    const snap = await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('medications').doc(medId)
      .collection('doses').orderBy('givenAtMs', 'desc').limit(limit).get();
    return { success: true, data: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Determine which medications are due, soon, or overdue right now.
 * Returns { due:[], soon:[], administeredToday:[] }
 */
export async function getMedicationStatus(familyId, childId) {
  const result = await listMedications(familyId, childId);
  if (!result.success) return result;
  const meds = result.data;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const due = [], soon = [], administeredToday = [];

  for (const med of meds) {
    const dosesSnap = await db().collection('families').doc(familyId)
      .collection('children').doc(childId)
      .collection('medications').doc(med.id)
      .collection('doses').where('givenAtMs', '>=', todayStart.getTime()).get();
    const dosesToday = dosesSnap.docs.map(d => d.data());
    if (dosesToday.length) administeredToday.push({ med, dosesToday });

    if (med.asNeeded) continue;
    (med.scheduledTimes || []).forEach(t => {
      const [hh, mm] = String(t).split(':').map(Number);
      if (Number.isNaN(hh)) return;
      const scheduledMin = hh * 60 + (mm || 0);
      const minsAway = scheduledMin - nowMin;
      const alreadyGiven = dosesToday.some(d =>
        Math.abs((new Date(d.givenAtMs).getHours() * 60 + new Date(d.givenAtMs).getMinutes()) - scheduledMin) < 60
      );
      if (alreadyGiven) return;
      if (minsAway <= 0 && minsAway > -120) due.push({ med, scheduledTime: t, minsLate: -minsAway });
      else if (minsAway > 0 && minsAway <= 60) soon.push({ med, scheduledTime: t, minsAway });
    });
  }

  return { success: true, data: { due, soon, administeredToday } };
}
