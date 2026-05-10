/**
 * Context Engine
 * The defining feature of CribNotes: every note, schedule item, and checklist
 * supports tagging by day-of-week, time-of-day, shift length, and special context.
 *
 * When a sitter starts a shift, this module computes the active context and
 * filters guide items so only relevant notes surface.
 */

// Canonical context vocabularies
export const DAY_TAGS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'weekday', 'weekend'
];

export const TIME_TAGS = [
  'morning',     // 5:00 - 11:59
  'afternoon',   // 12:00 - 16:59
  'evening',     // 17:00 - 20:59
  'night',       // 21:00 - 4:59
  'mealtime',    // overlay
  'naptime',     // overlay
  'bedtime'      // overlay
];

export const SHIFT_TAGS = [
  'short',       // < 4 hours
  'half-day',    // 4-8 hours
  'full-day',    // 8-12 hours
  'overnight',   // crosses 22:00 or > 12 hours
  'multi-day'
];

export const SPECIAL_TAGS = [
  'sick-day',
  'school-day',
  'no-school',
  'holiday',
  'birthday',
  'travel',
  'visitor',
  'special-event'
];

export const ALL_TAG_GROUPS = {
  day: DAY_TAGS,
  time: TIME_TAGS,
  shift: SHIFT_TAGS,
  special: SPECIAL_TAGS
};

/**
 * Compute the active context for a given Date and shift descriptor.
 * Returns a flat tag array, e.g. ['saturday', 'weekend', 'morning', 'short']
 */
export function computeContext(date, shiftType, durationHours, specials = []) {
  const tags = new Set();
  const d = date instanceof Date ? date : new Date(date);
  const dayIndex = d.getDay(); // 0 = Sun
  const dayName = DAY_TAGS[(dayIndex + 6) % 7]; // shift to Mon-first
  tags.add(dayName);
  if (dayIndex === 0 || dayIndex === 6) tags.add('weekend');
  else tags.add('weekday');

  const hour = d.getHours();
  if (hour >= 5 && hour < 12) tags.add('morning');
  else if (hour >= 12 && hour < 17) tags.add('afternoon');
  else if (hour >= 17 && hour < 21) tags.add('evening');
  else tags.add('night');

  if (shiftType) tags.add(shiftType);
  else if (typeof durationHours === 'number') {
    if (durationHours < 4) tags.add('short');
    else if (durationHours < 8) tags.add('half-day');
    else if (durationHours < 12) tags.add('full-day');
    else tags.add('overnight');
  }

  (specials || []).forEach(s => tags.add(s));
  return Array.from(tags);
}

/**
 * Decide whether an item should surface for a given context.
 * - Items with no tags ALWAYS surface (general info).
 * - Items with tags surface only if at least one of their tags is present
 *   in the active context.
 */
export function itemMatchesContext(item, contextTags) {
  if (!item) return false;
  // Plain string items have no tags
  if (typeof item === 'string') return true;
  const tags = item.tags || [];
  if (!tags.length) return true;
  if (!contextTags || !contextTags.length) return true;
  const ctxSet = new Set(contextTags);
  return tags.some(t => ctxSet.has(t));
}

/**
 * Filter every section of a care guide by the active context.
 */
export function filterGuideByContext(guide, contextTags) {
  const filtered = {};
  Object.entries(guide || {}).forEach(([section, items]) => {
    if (!Array.isArray(items)) {
      filtered[section] = items;
      return;
    }
    filtered[section] = items.filter(i => itemMatchesContext(i, contextTags));
  });
  return filtered;
}

/**
 * Heuristically infer context tags from a chunk of free text.
 * Used by the dictation flow so parents can speak naturally and have
 * tags applied automatically.
 */
export function inferTagsFromText(text) {
  const tags = new Set();
  const lower = (text || '').toLowerCase();

  // Day mentions
  DAY_TAGS.forEach(day => {
    if (lower.includes(day)) tags.add(day);
  });

  // Time of day
  if (/\b(morning|breakfast|wake[- ]up)\b/.test(lower)) tags.add('morning');
  if (/\b(afternoon|lunch|after school)\b/.test(lower)) tags.add('afternoon');
  if (/\b(evening|dinner|after dinner)\b/.test(lower)) tags.add('evening');
  if (/\b(night|bed time|bedtime|story|lullaby)\b/.test(lower)) {
    tags.add('evening');
    tags.add('bedtime');
  }
  if (/\b(nap|naptime|nap time|down for a nap)\b/.test(lower)) tags.add('naptime');
  if (/\b(meal|snack|eats|feed)\b/.test(lower)) tags.add('mealtime');

  // Shift length cues
  if (/\bovernight|overnight stay|sleep over\b/.test(lower)) tags.add('overnight');
  if (/\bquick visit|short visit|brief visit\b/.test(lower)) tags.add('short');

  // Specials
  if (/\bsick|fever|cold|flu|throw up\b/.test(lower)) tags.add('sick-day');
  if (/\bschool day|school morning|school pickup|school drop[- ]off\b/.test(lower)) tags.add('school-day');
  if (/\bweekend|saturday|sunday\b/.test(lower)) tags.add('weekend');
  if (/\bholiday|christmas|thanksgiving\b/.test(lower)) tags.add('holiday');
  if (/\btravel|trip|on the road\b/.test(lower)) tags.add('travel');

  return Array.from(tags);
}

export function describeContext(contextTags) {
  if (!contextTags || !contextTags.length) return 'All notes';
  const day = contextTags.find(t => DAY_TAGS.includes(t)) || '';
  const time = contextTags.find(t => TIME_TAGS.includes(t)) || '';
  const shift = contextTags.find(t => SHIFT_TAGS.includes(t)) || '';
  const specials = contextTags.filter(t => SPECIAL_TAGS.includes(t));
  const parts = [day, time, shift].filter(Boolean);
  if (specials.length) parts.push(specials.join(', '));
  return parts.map(p => p.replace(/-/g, ' ')).join(' / ') || 'All notes';
}

export function tagBadgeColor(tag) {
  if (DAY_TAGS.includes(tag)) return 'navy';
  if (TIME_TAGS.includes(tag)) return 'teal';
  if (SHIFT_TAGS.includes(tag)) return 'orange';
  if (SPECIAL_TAGS.includes(tag)) return 'coral';
  return 'navy';
}
