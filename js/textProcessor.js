/**
 * Text Processor Module
 * Cleans up raw speech-to-text transcripts into polished care guide entries.
 *
 * Strategy:
 * 1. Try the AI API endpoint first (if available)
 * 2. Fall back to smart client-side processing with topic-boundary detection
 */

const API_ENDPOINT = '/api/organize';

/**
 * Process a raw transcript into organized, polished guide sections.
 * Returns: { sections: { sectionKey: ["polished item", ...], ... } }
 */
export async function processTranscript(transcript, childName) {
  // Try AI processing first
  try {
    const result = await processWithAI(transcript, childName);
    if (result && result.sections && Object.keys(result.sections).length > 0) {
      console.log('[CribNotes] AI processing succeeded');
      return result;
    }
  } catch (err) {
    console.log('[CribNotes] AI processing unavailable, using smart cleanup:', err.message);
  }

  // Fall back to client-side smart processing
  return processLocally(transcript, childName);
}

/**
 * AI-powered processing via serverless function
 */
async function processWithAI(transcript, childName) {
  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, childName })
  });

  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return await response.json();
}

/**
 * Smart client-side processing (no API needed)
 */
function processLocally(transcript, childName) {
  // Step 1: Split into topic-based segments using boundary detection
  const segments = splitByTopicBoundary(transcript);
  console.log('[CribNotes] Topic segments:', segments);

  // Step 2: Categorize each segment
  const categorized = {};
  segments.forEach(segment => {
    const category = getBestCategory(segment);
    if (!categorized[category]) categorized[category] = [];
    categorized[category].push(segment);
  });

  // Step 3: Clean up and polish each section
  const sections = {};
  for (const [sectionKey, items] of Object.entries(categorized)) {
    sections[sectionKey] = items.map(item => polishText(item, childName));
  }

  // Step 4: Merge similar/duplicate items within sections
  for (const key of Object.keys(sections)) {
    sections[key] = mergeSimilarItems(sections[key]);
  }

  return { sections };
}

// ==========================================================================
// TOPIC KEYWORDS - used for both categorization and boundary detection
// ==========================================================================

const TOPIC_KEYWORDS = {
  emergencyContacts: [
    'emergency', 'contact', 'phone', 'call', 'doctor', 'hospital',
    'poison', 'police', 'ambulance', 'pediatrician', '911', 'urgent'
  ],
  meals: [
    'meal', 'food', 'eat', 'eats', 'drink', 'drinks', 'snack', 'lunch',
    'breakfast', 'dinner', 'bottle', 'milk', 'allergic', 'allergy',
    'diet', 'picky', 'juice', 'water', 'formula', 'hungry', 'feed',
    'rice', 'chicken', 'fruit', 'vegetable', 'vegetables', 'cucumber',
    'cucumbers', 'pepper', 'peppers', 'egg', 'eggs', 'cheese', 'yogurt',
    'tomato', 'tomatoes', 'cereal', 'pasta', 'bread', 'sandwich'
  ],
  napsBedtime: [
    'nap', 'naps', 'sleep', 'sleeps', 'bedtime', 'bed time', 'goes to bed',
    'goes down', 'sleep sack', 'sleepsack', 'story', 'lullaby', 'blanket',
    'stuffed animal', 'night light', 'white noise', 'sound machine',
    'wake', 'wakes', 'sleepy', 'crib', 'tired', 'pacifier', 'nighttime',
    'night time', 'goes to sleep'
  ],
  diapersPotty: [
    'diaper', 'diapers', 'potty', 'toilet', 'bathroom', 'wipe', 'wipes',
    'cream', 'rash', 'pull up', 'pull-up', 'training', 'pee', 'poop',
    'accident', 'soiled', 'wet'
  ],
  safetyTips: [
    'safety', 'danger', 'choking', 'hazard', 'supervision', 'careful',
    'watch out', 'fighting', 'hitting', 'time out', 'timeout',
    'discipline', 'separate them', 'argument', 'arguments', 'sibling',
    'sister', 'brother', 'calm down', 'calm him', 'calm her', 'tantrum'
  ],
  activities: [
    'play', 'plays', 'toy', 'toys', 'fire truck', 'excavator', 'blocks',
    'craft', 'outside', 'bike', 'loves to', 'enjoys', 'likes to',
    'active', 'run', 'runs', 'dance', 'draw', 'color', 'read',
    'book', 'books', 'puzzle', 'puzzles', 'legos', 'dolls'
  ],
  tvEntertainment: [
    'tv', 'television', 'movie', 'show', 'screen time', 'tablet', 'ipad',
    'game', 'video', 'cartoon', 'watch', 'watches', 'youtube', 'netflix',
    'disney', 'cocomelon', 'paw patrol'
  ],
  medicalInfo: [
    'medical', 'medicine', 'medication', 'prescription', 'allergy',
    'allergic', 'asthma', 'inhaler', 'epi pen', 'epipen', 'condition',
    'symptoms', 'treatment', 'vaccine', 'dose'
  ],
  locations: [
    'location', 'park', 'school', 'library', 'daycare', 'address',
    'playground', 'apartment', 'floor', 'building'
  ],
  carTravel: [
    'car', 'drive', 'car seat', 'booster', 'stroller', 'travel'
  ]
};

// Build a flat lookup: word -> topic
const WORD_TO_TOPIC = {};
for (const [topic, words] of Object.entries(TOPIC_KEYWORDS)) {
  for (const word of words) {
    // For multi-word phrases, index by the last word (most specific)
    const key = word.toLowerCase();
    if (!WORD_TO_TOPIC[key]) WORD_TO_TOPIC[key] = [];
    WORD_TO_TOPIC[key].push(topic);
  }
}

/**
 * Split text by detecting topic boundaries using a sliding window.
 * Scans word-by-word and splits when the dominant topic changes.
 */
function splitByTopicBoundary(text) {
  // First do basic sentence splitting on punctuation
  const sentences = text
    .replace(/([.!?])\s*/g, '$1|||')
    .split('|||')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // For each sentence, try topic-boundary splitting if it's long enough
  const allSegments = [];
  for (const sentence of sentences) {
    if (sentence.split(/\s+/).length > 12) {
      // Long enough to potentially contain multiple topics
      const subSegments = detectTopicShifts(sentence);
      allSegments.push(...subSegments);
    } else if (sentence.length > 5) {
      allSegments.push(sentence);
    }
  }

  // If the whole transcript had no punctuation, we got one big sentence
  // Try topic splitting on the whole thing
  if (sentences.length <= 1 && text.split(/\s+/).length > 12) {
    return detectTopicShifts(text);
  }

  return allSegments.length > 0 ? allSegments : [text.trim()];
}

/**
 * Detect topic shifts within a continuous string of text.
 * Returns an array of segments, each covering one topic.
 */
function detectTopicShifts(text) {
  const words = text.split(/\s+/);
  if (words.length < 6) return [text];

  const segments = [];
  let currentStart = 0;
  let currentTopic = null;
  let lastTopicChangeAt = 0;

  for (let i = 0; i < words.length; i++) {
    const topic = getWordTopic(words, i);
    if (!topic) continue;

    if (currentTopic === null) {
      currentTopic = topic;
      lastTopicChangeAt = i;
    } else if (topic !== currentTopic) {
      // Look ahead to confirm this is a real topic change (not just a stray keyword)
      const confirmed = confirmTopicChange(words, i, topic);
      if (confirmed && (i - lastTopicChangeAt) >= 3) {
        // Find a good split point: look back for natural break words
        const splitIdx = findNaturalSplitPoint(words, i);

        const segment = words.slice(currentStart, splitIdx).join(' ').trim();
        if (segment.length > 10) {
          segments.push(segment);
        }
        currentStart = splitIdx;
        currentTopic = topic;
        lastTopicChangeAt = i;
      }
    }
  }

  // Add the last segment
  const lastSegment = words.slice(currentStart).join(' ').trim();
  if (lastSegment.length > 10) {
    segments.push(lastSegment);
  }

  return segments.length > 0 ? segments : [text];
}

/**
 * Check if word at position matches a topic keyword.
 * Also checks 2-word and 3-word phrases.
 */
function getWordTopic(words, idx) {
  const w = words[idx].toLowerCase().replace(/[^a-z0-9]/g, '');

  // Check 3-word phrases
  if (idx + 2 < words.length) {
    const phrase3 = [w, words[idx+1], words[idx+2]].join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, '');
    if (WORD_TO_TOPIC[phrase3]) return WORD_TO_TOPIC[phrase3][0];
  }

  // Check 2-word phrases
  if (idx + 1 < words.length) {
    const phrase2 = [w, words[idx+1]].join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, '');
    if (WORD_TO_TOPIC[phrase2]) return WORD_TO_TOPIC[phrase2][0];
  }

  // Check single word (skip very common words that appear in multiple topics)
  const skipWords = new Set(['his', 'her', 'the', 'a', 'an', 'is', 'at', 'to', 'and', 'or', 'for', 'in', 'on', 'it']);
  if (skipWords.has(w)) return null;

  if (WORD_TO_TOPIC[w]) return WORD_TO_TOPIC[w][0];
  return null;
}

/**
 * Look ahead a few words to confirm a topic change is real,
 * not just a stray keyword.
 */
function confirmTopicChange(words, startIdx, newTopic) {
  let matches = 0;
  const lookAhead = Math.min(8, words.length - startIdx);

  for (let i = startIdx; i < startIdx + lookAhead; i++) {
    const topic = getWordTopic(words, i);
    if (topic === newTopic) matches++;
  }

  // At least 1 keyword match in the look-ahead confirms the shift
  return matches >= 1;
}

/**
 * Find a natural split point near the given index.
 * Looks back for pronouns, conjunctions, or possessives.
 */
function findNaturalSplitPoint(words, idx) {
  // Look back up to 3 words for a natural break
  const breakWords = /^(his|her|the|for|at|and|also|then|next|about|regarding|when|if)$/i;
  for (let i = idx; i >= Math.max(0, idx - 3); i--) {
    if (breakWords.test(words[i])) {
      return i;
    }
  }
  return idx;
}

/**
 * Categorize text into the best guide section
 */
function getBestCategory(text) {
  const lowerText = text.toLowerCase();
  let bestCategory = 'dailySchedule';
  let bestScore = 0;

  const weights = {
    emergencyContacts: 2,
    meals: 1.5,
    napsBedtime: 1.5,
    diapersPotty: 1.5,
    medicalInfo: 1.5,
    safetyTips: 1.3,
    activities: 1,
    tvEntertainment: 1,
    locations: 1,
    carTravel: 1,
    dailySchedule: 0.8
  };

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        score += (weights[topic] || 1);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = topic;
    }
  }

  // If no strong match, default to dailySchedule
  if (bestScore === 0) bestCategory = 'dailySchedule';

  return bestCategory;
}

/**
 * Polish a raw speech-to-text segment into clean text
 */
function polishText(text, childName) {
  let cleaned = text.trim();

  // Remove common speech artifacts
  cleaned = cleaned
    .replace(/\b(um|uh|like|you know|basically|so yeah|I mean)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Fix "p." or "p.m." artifacts from speech recognition (anywhere in text, not just end)
  cleaned = cleaned
    .replace(/(\d+:\d+)\s*p\.m?\s/gi, '$1 PM ')
    .replace(/(\d+:\d+)\s*a\.m?\s/gi, '$1 AM ')
    .replace(/(\d+:\d+)\s*p\.m?\.?\s*$/i, '$1 PM')
    .replace(/(\d+:\d+)\s*a\.m?\.?\s*$/i, '$1 AM')
    .replace(/(\d+)\s*p\.m?\s/gi, '$1 PM ')
    .replace(/(\d+)\s*a\.m?\s/gi, '$1 AM ')
    .replace(/(\d+)\s*p\.m?\.?\s*$/i, '$1 PM')
    .replace(/(\d+)\s*a\.m?\.?\s*$/i, '$1 AM');

  // Convert "you" references to child's name or third person
  if (childName) {
    cleaned = cleaned
      .replace(/\byou go to\b/gi, `${childName} goes to`)
      .replace(/\byou can\b/gi, `${childName} can`)
      .replace(/\byou like\b/gi, `${childName} likes`)
      .replace(/\byou love\b/gi, `${childName} loves`)
      .replace(/\byou need\b/gi, `${childName} needs`)
      .replace(/\byou have\b/gi, `${childName} has`)
      .replace(/\byour\b/gi, `${childName}'s`);
  }

  // Convert "he/she" at start to child name
  if (childName) {
    cleaned = cleaned
      .replace(/^he\b/i, childName)
      .replace(/^she\b/i, childName);
  }

  // Remove leading conjunctions/filler
  cleaned = cleaned.replace(/^(and|but|so|or|also|then|next|plus)\s+/i, '');

  // Capitalize first letter
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  // Ensure ends with punctuation
  if (cleaned.length > 0 && !cleaned.match(/[.!?]$/)) {
    cleaned += '.';
  }

  // Clean up double spaces
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  return cleaned;
}

/**
 * Merge items that are very similar (>60% word overlap)
 */
function mergeSimilarItems(items) {
  if (items.length <= 1) return items;

  const merged = [];
  const used = new Set();

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;

    let bestItem = items[i];
    const wordsI = new Set(items[i].toLowerCase().split(/\s+/));

    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;

      const wordsJ = new Set(items[j].toLowerCase().split(/\s+/));
      const intersection = new Set([...wordsI].filter(w => wordsJ.has(w)));
      const similarity = intersection.size / Math.min(wordsI.size, wordsJ.size);

      if (similarity > 0.6) {
        if (items[j].length > bestItem.length) {
          bestItem = items[j];
        }
        used.add(j);
      }
    }

    merged.push(bestItem);
    used.add(i);
  }

  return merged;
}
