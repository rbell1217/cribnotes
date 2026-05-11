/**
 * Text Processor Module
 * Processes both speech-to-text transcripts AND uploaded documents
 * into organized care guide entries.
 *
 * Strategy:
 * 1. Try the AI API endpoint first (if available)
 * 2. Fall back to smart client-side processing
 *    - Documents: rejoin broken lines, detect section headers, map to guide sections
 *    - Dictation: split on topic-boundary keyword detection
 */

const API_ENDPOINT = '/api/organize';

/**
 * Process text into organized, polished guide sections.
 * @param {string} transcript - The raw text to process
 * @param {string} childName - The child's name
 * @param {string} source - 'dictation' or 'document'
 * Returns: { sections: { sectionKey: [...] }, critical?: {...} }
 */
export async function processTranscript(transcript, childName, source = 'dictation') {
  const isDocument = source === 'document';

  // Try AI processing first
  try {
    const result = await processWithAI(transcript, childName, { isDocument });
    if (result && result.sections && Object.keys(result.sections).length > 0) {
      console.log('[CribNotes] AI processing succeeded');
      return result;
    }
  } catch (err) {
    console.log('[CribNotes] AI processing unavailable, using local processing:', err.message);
  }

  // Fall back to client-side processing
  if (isDocument) {
    return processDocumentLocally(transcript, childName);
  }
  return processDictationLocally(transcript, childName);
}

/**
 * Process a checklist dictation into { title, items }.
 * Falls back to a simple line-split when the AI is unavailable.
 */
export async function processChecklistDictation(transcript, childName) {
  try {
    const result = await processWithAI(transcript, childName, { mode: 'checklist' });
    if (result && Array.isArray(result.items) && result.items.length > 0) {
      return { title: result.title || '', items: result.items };
    }
  } catch (err) {
    console.log('[CribNotes] Checklist AI unavailable:', err.message);
  }
  // Local fallback: split on sentence/comma boundaries, imperative-ish trim.
  const items = (transcript || '')
    .split(/[.!?;\n]+|,\s*(?=[A-Z])/g)
    .map(s => s.trim().replace(/^(and|also|then|next|plus)\s+/i, ''))
    .filter(s => s.split(/\s+/).length >= 2)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1));
  return { title: '', items };
}

/**
 * AI-powered processing via serverless function
 */
async function processWithAI(transcript, childName, opts) {
  const body = {
    transcript,
    childName,
    isDocument: !!(opts && opts.isDocument),
  };
  if (opts && opts.mode) body.mode = opts.mode;
  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return await response.json();
}

// ==========================================================================
// DOCUMENT PROCESSING (for uploaded PDFs, Word docs, etc.)
// ==========================================================================

// Map of regex patterns on HEADER text -> guide section key
// Order matters: first match wins
const HEADER_TO_SECTION = [
  { pattern: /emergency|key contacts|contacts at a glance|important contacts|local people/i, section: 'emergencyContacts' },
  { pattern: /meal|snack|food|breakfast|lunch|dinner|eating/i, section: 'meals' },
  { pattern: /nap|bedtime|sleep|bed\s*time|night waking|quiet time|comfort item/i, section: 'napsBedtime' },
  { pattern: /diaper|potty|toilet|bathroom/i, section: 'diapersPotty' },
  { pattern: /safety|important.*read|watch out|in the apartment/i, section: 'safetyTips' },
  { pattern: /tv|music|entertainment|screen|streaming|show|clicker/i, section: 'tvEntertainment' },
  { pattern: /car\b.*seat|car\b.*travel|parking|garage|stroller|out\s*&\s*about/i, section: 'carTravel' },
  { pattern: /activit|toy|play|outdoor|museum|pier|playground|aquarium|things to do/i, section: 'activities' },
  { pattern: /medical|medication|allerg|health|tylenol/i, section: 'medicalInfo' },
  { pattern: /school|daycare|drop.?off|pickup|mount carmel|l&l/i, section: 'locations' },
  { pattern: /location|apartment|home|address|building|amenit|getting to|wifi|front desk/i, section: 'locations' },
  { pattern: /schedul|monday|tuesday|wednesday|thursday|friday|saturday|sunday|checklist|morning|afternoon/i, section: 'dailySchedule' },
];

/**
 * Process a structured document by:
 * 1. Rejoining broken PDF lines into proper paragraphs
 * 2. Detecting major section headers
 * 3. Mapping each section to a guide category using the HEADER (not content keywords)
 * 4. Extracting clean items from each section
 */
function processDocumentLocally(text, childName) {
  console.log('[CribNotes] Processing document locally, length:', text.length);

  // Step 1: Rejoin broken lines into proper paragraphs
  const cleanedText = rejoinBrokenLines(text);

  // Step 2: Split into major sections by detecting headers
  const docSections = splitIntoSections(cleanedText);
  console.log('[CribNotes] Document sections found:', docSections.length,
    docSections.map(s => `[${s.guideSection}] ${s.header.substring(0, 50)}`));

  // Step 3: Build the guide sections
  const sections = {};
  for (const docSection of docSections) {
    const key = docSection.guideSection;
    if (!sections[key]) sections[key] = [];

    // Extract items from this section's content
    const items = extractItems(docSection.content);
    for (const item of items) {
      if (item.length > 5) {
        sections[key].push(item);
      }
    }
  }

  // Step 4: Deduplicate within each section
  for (const key of Object.keys(sections)) {
    sections[key] = deduplicateItems(sections[key]);
  }

  return { sections };
}

/**
 * Rejoin lines that were broken by PDF extraction.
 * PDF extractors break text at ~80 chars, creating mid-sentence line breaks.
 * This rejoins them into proper paragraphs.
 */
function rejoinBrokenLines(text) {
  const lines = text.split('\n');
  const result = [];
  let current = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty line = paragraph break
    if (!trimmed) {
      if (current) {
        result.push(current.trim());
        current = '';
      }
      result.push('');
      continue;
    }

    // Bullet points always start a new line
    if (/^[•\-\*⁃]\s/.test(trimmed) || /^\(\d+\)\s/.test(trimmed)) {
      if (current) {
        result.push(current.trim());
        current = '';
      }
      current = trimmed;
      continue;
    }

    // If current line is empty, start fresh
    if (!current) {
      current = trimmed;
      continue;
    }

    // Check if previous line ended mid-sentence (no period, question mark, etc.)
    const prevEndsClean = /[.!?:)\]]$/.test(current.trim());
    // Check if this line starts with lowercase (continuation) or is short
    const startsLower = /^[a-z]/.test(trimmed);
    const prevIsShort = current.trim().length < 80;

    if (!prevEndsClean || startsLower) {
      // Join with previous line (continuation)
      current += ' ' + trimmed;
    } else {
      // Previous line was complete, start a new one
      result.push(current.trim());
      current = trimmed;
    }
  }

  if (current) {
    result.push(current.trim());
  }

  return result.join('\n');
}

/**
 * Split text into sections based on detected headers.
 * A "header" is a short line that matches known section patterns,
 * typically preceded by a blank line.
 */
function splitIntoSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let currentHeader = '';
  let currentSection = 'dailySchedule';
  let currentContent = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines
    if (!line) continue;

    // Check if this line is a section header
    const matchedSection = matchHeader(line, lines, i);

    if (matchedSection) {
      // Save previous section if it has content
      if (currentContent.length > 0) {
        sections.push({
          header: currentHeader,
          guideSection: currentSection,
          content: currentContent.join('\n').trim()
        });
      }
      currentHeader = line;
      currentSection = matchedSection;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentContent.length > 0) {
    sections.push({
      header: currentHeader,
      guideSection: currentSection,
      content: currentContent.join('\n').trim()
    });
  }

  return sections.filter(s => s.content.length > 5);
}

/**
 * Check if a line matches a known section header.
 * Returns the guide section key if matched, or null.
 */
function matchHeader(line, allLines, idx) {
  // Headers are relatively short
  if (line.length > 120) return null;

  // Skip bullet points
  if (/^[•\-\*⁃]\s/.test(line)) return null;

  // Check against known header patterns
  for (const { pattern, section } of HEADER_TO_SECTION) {
    if (pattern.test(line)) {
      return section;
    }
  }

  return null;
}

/**
 * Extract individual items from a section's content.
 * Handles bullet points, numbered items, and paragraphs.
 */
function extractItems(content) {
  const lines = content.split('\n');
  const items = [];
  let currentParagraph = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentParagraph.length > 0) {
        items.push(currentParagraph.join(' ').trim());
        currentParagraph = [];
      }
      continue;
    }

    // Bullet point = standalone item
    if (/^[•\-\*⁃]\s/.test(trimmed)) {
      if (currentParagraph.length > 0) {
        items.push(currentParagraph.join(' ').trim());
        currentParagraph = [];
      }
      const cleaned = trimmed.replace(/^[•\-\*⁃]\s+/, '');
      items.push(cleaned);
    }
    // Numbered item
    else if (/^\d+[\.\)]\s/.test(trimmed)) {
      if (currentParagraph.length > 0) {
        items.push(currentParagraph.join(' ').trim());
        currentParagraph = [];
      }
      const cleaned = trimmed.replace(/^\d+[\.\)]\s+/, '');
      items.push(cleaned);
    }
    // Regular paragraph line
    else {
      currentParagraph.push(trimmed);
    }
  }

  if (currentParagraph.length > 0) {
    items.push(currentParagraph.join(' ').trim());
  }

  // Post-process: split very long items at sentence boundaries
  const finalItems = [];
  for (const item of items) {
    if (item.length > 300) {
      const sentences = item.match(/[^.!?]+[.!?]+/g);
      if (sentences && sentences.length > 1) {
        let chunk = '';
        for (const sentence of sentences) {
          if (chunk.length + sentence.length > 250 && chunk.length > 20) {
            finalItems.push(cleanItemText(chunk));
            chunk = sentence;
          } else {
            chunk += sentence;
          }
        }
        if (chunk.trim()) finalItems.push(cleanItemText(chunk));
      } else {
        finalItems.push(cleanItemText(item));
      }
    } else {
      finalItems.push(cleanItemText(item));
    }
  }

  return finalItems.filter(item => item.length > 5);
}

/**
 * Clean up an item's text without aggressively rewriting.
 */
function cleanItemText(text) {
  let cleaned = text.trim()
    .replace(/\s{2,}/g, ' ');

  // Capitalize first letter
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  // Ensure proper ending
  if (cleaned.length > 0 && !cleaned.match(/[.!?:)\]]$/)) {
    cleaned += '.';
  }

  return cleaned.trim();
}

/**
 * Remove near-duplicate items within a section.
 */
function deduplicateItems(items) {
  if (items.length <= 1) return items;

  const result = [];
  const seen = new Set();

  for (const item of items) {
    // Normalize for comparison
    const key = item.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 60);
    if (!seen.has(key) && key.length > 3) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

// ==========================================================================
// DICTATION PROCESSING (for speech-to-text)
// ==========================================================================

function processDictationLocally(transcript, childName) {
  // Voice dictation usually arrives without proper punctuation, so we can't
  // rely on sentence boundaries alone. Use transition phrases + topic-shift
  // signals to break the stream into short, atomic chunks.
  const chunks = splitIntoAtomicChunks(transcript);
  console.log('[CribNotes] Dictation chunks:', chunks.length, 'avg words:',
    Math.round(chunks.reduce((s, c) => s + c.split(/\s+/).length, 0) / Math.max(1, chunks.length)));

  const categorized = {};
  chunks.forEach(chunk => {
    const category = getBestCategory(chunk);
    if (!categorized[category]) categorized[category] = [];
    categorized[category].push(chunk);
  });

  const sections = {};
  for (const [sectionKey, items] of Object.entries(categorized)) {
    sections[sectionKey] = items.map(item => polishText(item, childName));
  }

  for (const key of Object.keys(sections)) {
    sections[key] = deduplicateItems(sections[key]);
  }

  return { sections };
}

/**
 * Break dictation into atomic chunks — one short fact each. This is the
 * fallback when no AI processor is available; it's purely string-driven
 * so it works offline and never hallucinates.
 *
 * Strategy:
 *   1. Normalize whitespace + lowercase punctuation noise.
 *   2. Insert virtual splits BEFORE every transition phrase ("and then",
 *      "also", "when he", "for breakfast", etc.) — these reliably mark
 *      where one fact ends and another starts.
 *   3. Also split on actual punctuation: . ! ? ; , – —
 *   4. After splitting, any chunk longer than ~18 words is re-split at
 *      the next pronoun ("he", "she", "they") or at the next preposition
 *      starting a new clause ("for", "at", "in", "during").
 *   5. Discard tiny fragments (<= 3 words) and dedupe.
 */
function splitIntoAtomicChunks(rawText) {
  let text = (rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  // Phrases that signal "a new fact is starting". The leading space avoids
  // splitting inside words like "another". The captured group is preserved
  // so the new chunk still reads naturally.
  const transitionPhrases = [
    'and then', 'and also', 'also', 'then', 'next', 'after that',
    'oh and', 'oh also', 'by the way', "don't forget", 'remember',
    'when she', 'when he', 'when they', "when it's", 'when im',
    'when i\'m', 'when going', 'before bed', 'before nap', 'before school',
    'at bedtime', 'at naptime', 'at night', 'in the morning', 'in the afternoon',
    'in the evening', 'during the day', 'during nap', 'for breakfast',
    'for lunch', 'for dinner', 'for snack', 'for snacks',
    'her favorite', 'his favorite', 'she likes', 'he likes',
    'she loves', 'he loves', 'she doesn\'t', 'he doesn\'t',
    'she won\'t', 'he won\'t', 'she needs', 'he needs',
    'allergic to', 'allergy to', 'do not', 'never give', 'always give',
    'if she', 'if he', 'if they', 'in case'
  ];

  // Build a regex that inserts a marker BEFORE any transition phrase.
  // Use word boundary at the start so we don't match mid-word.
  const transitionRe = new RegExp(
    '\\b(' + transitionPhrases.map(p => p.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('|') + ')\\b',
    'gi'
  );
  text = text.replace(transitionRe, '|||$1');

  // Also break at real punctuation
  text = text.replace(/([.!?;])\s*/g, '$1|||');

  // First pass: chunks by marker
  let chunks = text.split('|||').map(s => s.trim()).filter(s => s.length > 0);

  // Second pass: break overly-long chunks at pronoun or preposition boundaries
  const refined = [];
  for (const chunk of chunks) {
    const words = chunk.split(/\s+/);
    if (words.length <= 18) {
      refined.push(chunk);
      continue;
    }
    refined.push(...subdivideLongChunk(chunk));
  }

  // Drop fragments shorter than 4 words (unlikely to be a useful guide item)
  // and items that are just filler ("um", "okay", "yeah").
  return refined
    .map(s => s.replace(/^[,;:.\s]+/, '').trim())
    .filter(s => s.split(/\s+/).length >= 3)
    .filter(s => !/^(um+|uh+|ok|okay|yeah|so|alright|right)$/i.test(s));
}

function subdivideLongChunk(chunk) {
  // Look for natural sub-break points inside a long chunk: a pronoun starting
  // a new clause, or a preposition that often opens a new topic.
  const breakRe = /\s(he|she|they|her|his|their|for|at|in|on|during|before|after|when|if|while|because|so that)\s/gi;
  const out = [];
  let last = 0;
  let m;
  while ((m = breakRe.exec(chunk)) !== null) {
    const cut = m.index + 1; // skip leading space
    if (cut - last >= 18) { // only break if the running piece is already long enough
      out.push(chunk.slice(last, cut).trim());
      last = cut;
    }
  }
  out.push(chunk.slice(last).trim());
  return out.filter(s => s.split(/\s+/).length >= 3);
}

// ==========================================================================
// TOPIC KEYWORDS - for dictation only
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

const WORD_TO_TOPIC = {};
for (const [topic, words] of Object.entries(TOPIC_KEYWORDS)) {
  for (const word of words) {
    const key = word.toLowerCase();
    if (!WORD_TO_TOPIC[key]) WORD_TO_TOPIC[key] = [];
    WORD_TO_TOPIC[key].push(topic);
  }
}

function splitByTopicBoundary(text) {
  const sentences = text
    .replace(/([.!?])\s*/g, '$1|||')
    .split('|||')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const allSegments = [];
  for (const sentence of sentences) {
    if (sentence.split(/\s+/).length > 12) {
      const subSegments = detectTopicShifts(sentence);
      allSegments.push(...subSegments);
    } else if (sentence.length > 5) {
      allSegments.push(sentence);
    }
  }

  if (sentences.length <= 1 && text.split(/\s+/).length > 12) {
    return detectTopicShifts(text);
  }

  return allSegments.length > 0 ? allSegments : [text.trim()];
}

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
      const confirmed = confirmTopicChange(words, i, topic);
      if (confirmed && (i - lastTopicChangeAt) >= 3) {
        const splitIdx = findNaturalSplitPoint(words, i);
        const segment = words.slice(currentStart, splitIdx).join(' ').trim();
        if (segment.length > 10) segments.push(segment);
        currentStart = splitIdx;
        currentTopic = topic;
        lastTopicChangeAt = i;
      }
    }
  }

  const lastSegment = words.slice(currentStart).join(' ').trim();
  if (lastSegment.length > 10) segments.push(lastSegment);

  return segments.length > 0 ? segments : [text];
}

function getWordTopic(words, idx) {
  const w = words[idx].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (idx + 2 < words.length) {
    const phrase3 = [w, words[idx+1], words[idx+2]].join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, '');
    if (WORD_TO_TOPIC[phrase3]) return WORD_TO_TOPIC[phrase3][0];
  }
  if (idx + 1 < words.length) {
    const phrase2 = [w, words[idx+1]].join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, '');
    if (WORD_TO_TOPIC[phrase2]) return WORD_TO_TOPIC[phrase2][0];
  }
  const skipWords = new Set(['his', 'her', 'the', 'a', 'an', 'is', 'at', 'to', 'and', 'or', 'for', 'in', 'on', 'it']);
  if (skipWords.has(w)) return null;
  if (WORD_TO_TOPIC[w]) return WORD_TO_TOPIC[w][0];
  return null;
}

function confirmTopicChange(words, startIdx, newTopic) {
  let matches = 0;
  const lookAhead = Math.min(8, words.length - startIdx);
  for (let i = startIdx; i < startIdx + lookAhead; i++) {
    const topic = getWordTopic(words, i);
    if (topic === newTopic) matches++;
  }
  return matches >= 1;
}

function findNaturalSplitPoint(words, idx) {
  const breakWords = /^(his|her|the|for|at|and|also|then|next|about|regarding|when|if)$/i;
  for (let i = idx; i >= Math.max(0, idx - 3); i--) {
    if (breakWords.test(words[i])) return i;
  }
  return idx;
}

function getBestCategory(text) {
  const lowerText = text.toLowerCase();
  let bestCategory = 'dailySchedule';
  let bestScore = 0;
  const weights = {
    emergencyContacts: 2, meals: 1.5, napsBedtime: 1.5, diapersPotty: 1.5,
    medicalInfo: 1.5, safetyTips: 1.3, activities: 1, tvEntertainment: 1,
    locations: 1, carTravel: 1, dailySchedule: 0.8
  };
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) score += (weights[topic] || 1);
    }
    if (score > bestScore) { bestScore = score; bestCategory = topic; }
  }
  if (bestScore === 0) bestCategory = 'dailySchedule';
  return bestCategory;
}

function polishText(text, childName) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/\b(um|uh|like|you know|basically|so yeah|I mean)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  cleaned = cleaned
    .replace(/(\d+:\d+)\s*p\.m?\s/gi, '$1 PM ').replace(/(\d+:\d+)\s*a\.m?\s/gi, '$1 AM ')
    .replace(/(\d+:\d+)\s*p\.m?\.?\s*$/i, '$1 PM').replace(/(\d+:\d+)\s*a\.m?\.?\s*$/i, '$1 AM')
    .replace(/(\d+)\s*p\.m?\s/gi, '$1 PM ').replace(/(\d+)\s*a\.m?\s/gi, '$1 AM ')
    .replace(/(\d+)\s*p\.m?\.?\s*$/i, '$1 PM').replace(/(\d+)\s*a\.m?\.?\s*$/i, '$1 AM');
  if (childName) {
    cleaned = cleaned
      .replace(/\byou go to\b/gi, `${childName} goes to`).replace(/\byou can\b/gi, `${childName} can`)
      .replace(/\byou like\b/gi, `${childName} likes`).replace(/\byou love\b/gi, `${childName} loves`)
      .replace(/\byou need\b/gi, `${childName} needs`).replace(/\byou have\b/gi, `${childName} has`)
      .replace(/\byour\b/gi, `${childName}'s`);
    cleaned = cleaned.replace(/^he\b/i, childName).replace(/^she\b/i, childName);
  }
  cleaned = cleaned.replace(/^(and|but|so|or|also|then|next|plus)\s+/i, '');
  if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (cleaned.length > 0 && !cleaned.match(/[.!?]$/)) cleaned += '.';
  return cleaned.replace(/\s{2,}/g, ' ').trim();
}
