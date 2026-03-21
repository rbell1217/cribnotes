/**
 * Text Processor Module
 * Cleans up raw speech-to-text transcripts into polished care guide entries.
 *
 * Strategy:
 * 1. Try the AI API endpoint first (if available)
 * 2. Fall back to smart client-side processing
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
  // Step 1: Split into meaningful segments
  const segments = splitIntoSegments(transcript);

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

/**
 * Split transcript into meaningful segments based on topic changes
 */
function splitIntoSegments(text) {
  // First split on sentence-ending punctuation
  let parts = text
    .replace(/([.!?])\s*/g, '$1|||')
    .split('|||')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // For long parts without punctuation, split on topic-change conjunctions
  const result = [];
  const topicChangers = /\b(also|another thing|oh and|and also|by the way|in terms of|as for|regarding|when it comes to|for bedtime|for meals|for dinner|for lunch|for breakfast|at bedtime|at night|in the morning|if there's|in case of|for emergencies)\b/gi;

  parts.forEach(part => {
    if (part.length > 120) {
      const subParts = part.split(topicChangers)
        .map(s => s.trim())
        .filter(s => s.length > 10 && !s.match(/^(also|another thing|oh and|and also|by the way|in terms of|as for|regarding|when it comes to)$/i));

      if (subParts.length > 1) {
        result.push(...subParts);
      } else {
        // Try splitting on simpler conjunctions
        const simpleSplit = part.split(/\b(and then|then|but|plus|next)\b/gi)
          .map(s => s.trim())
          .filter(s => s.length > 15 && !s.match(/^(and then|then|but|plus|next)$/i));

        if (simpleSplit.length > 1) {
          result.push(...simpleSplit);
        } else {
          result.push(part);
        }
      }
    } else if (part.length > 5) {
      result.push(part);
    }
  });

  return result.length > 0 ? result : [text.trim()];
}

/**
 * Categorize text into the best guide section
 */
const CATEGORY_KEYWORDS = {
  emergencyContacts: {
    weight: 2,
    keywords: ['emergency', 'contact', 'phone', 'call', 'doctor', 'hospital', 'poison',
      'police', 'number', 'ambulance', 'pediatrician', '911', 'urgent']
  },
  dailySchedule: {
    weight: 1,
    keywords: ['schedule', 'routine', 'morning', 'afternoon', 'evening', 'o\'clock',
      'a.m', 'p.m', 'am', 'pm', 'usually', 'typically', 'around']
  },
  meals: {
    weight: 1.5,
    keywords: ['meal', 'food', 'eat', 'drink', 'snack', 'lunch', 'breakfast', 'dinner',
      'bottle', 'milk', 'allergic', 'allergy', 'diet', 'picky', 'favorite food',
      'juice', 'water', 'formula', 'hungry', 'feed', 'rice', 'chicken', 'fruit',
      'vegetable', 'cucumber', 'pepper', 'egg', 'cheese', 'yogurt']
  },
  napsBedtime: {
    weight: 1.5,
    keywords: ['nap', 'sleep', 'bedtime', 'bed time', 'goes to bed', 'goes down',
      'sleep sack', 'sleepsack', 'story', 'lullaby', 'blanket', 'stuffed animal',
      'night light', 'white noise', 'sound machine', 'wake', 'sleepy', 'crib',
      'tired', 'pacifier', 'nighttime', 'night time']
  },
  diapersPotty: {
    weight: 1.5,
    keywords: ['diaper', 'potty', 'toilet', 'bathroom', 'wipe', 'cream', 'rash',
      'pull up', 'training', 'pee', 'poop', 'accident', 'soiled', 'wet']
  },
  safetyTips: {
    weight: 1.3,
    keywords: ['safety', 'danger', 'choking', 'hazard', 'supervision', 'careful',
      'watch out', 'never', 'always make sure', 'fighting', 'hitting', 'time out',
      'timeout', 'discipline', 'separate them', 'argument', 'sibling', 'sister',
      'brother', 'calm down', 'tantrum']
  },
  locations: {
    weight: 1,
    keywords: ['location', 'park', 'school', 'library', 'daycare', 'address',
      'playground', 'apartment', 'floor', 'building']
  },
  tvEntertainment: {
    weight: 1,
    keywords: ['tv', 'television', 'movie', 'show', 'screen time', 'tablet', 'ipad',
      'game', 'video', 'cartoon', 'watch', 'youtube', 'netflix', 'disney']
  },
  carTravel: {
    weight: 1,
    keywords: ['car', 'drive', 'car seat', 'booster', 'stroller', 'travel']
  },
  activities: {
    weight: 1,
    keywords: ['play', 'toy', 'fire truck', 'excavator', 'blocks', 'craft', 'outside',
      'bike', 'loves to', 'favorite', 'enjoys', 'likes to', 'active', 'run',
      'dance', 'draw', 'color', 'read', 'book', 'puzzle']
  },
  medicalInfo: {
    weight: 1.5,
    keywords: ['medical', 'medicine', 'medication', 'prescription', 'allergy', 'allergic',
      'asthma', 'inhaler', 'epi pen', 'condition', 'symptoms', 'treatment',
      'vaccine', 'dose']
  }
};

function getBestCategory(text) {
  const lowerText = text.toLowerCase();
  let bestCategory = 'dailySchedule';
  let bestScore = 0;

  for (const [category, config] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const keyword of config.keywords) {
      if (lowerText.includes(keyword)) {
        score += config.weight;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

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

  // Fix "p." or "p.m." artifacts from speech recognition
  cleaned = cleaned
    .replace(/(\d+:\d+)\s*p\.\s*$/i, '$1 PM')
    .replace(/(\d+:\d+)\s*a\.\s*$/i, '$1 AM')
    .replace(/(\d+:\d+)\s*p\.m\./gi, '$1 PM')
    .replace(/(\d+:\d+)\s*a\.m\./gi, '$1 AM')
    .replace(/(\d+)\s*p\.\s*$/i, '$1 PM')
    .replace(/(\d+)\s*a\.\s*$/i, '$1 AM');

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

  // Convert "he/she" at sentence start to child name if available
  if (childName) {
    cleaned = cleaned
      .replace(/^he\b/i, childName)
      .replace(/^she\b/i, childName);
  }

  // Remove leading conjunctions
  cleaned = cleaned.replace(/^(and|but|so|or|also|then|next|plus)\s+/i, '');

  // Capitalize first letter
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

  // Ensure it ends with proper punctuation
  if (cleaned.length > 0 && !cleaned.match(/[.!?]$/)) {
    cleaned += '.';
  }

  // Clean up double spaces and trailing issues
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
        // Keep the longer/more detailed version
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
