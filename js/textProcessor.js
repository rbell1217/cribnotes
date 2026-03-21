/**
 * Text Processor Module
 * Processes both speech-to-text transcripts AND uploaded documents
 * into organized care guide entries.
 *
 * Strategy:
 * 1. Try the AI API endpoint first (if available)
 * 2. Fall back to smart client-side processing
 *    - Documents: split on section headers / paragraph boundaries
 *    - Dictation: split on topic-boundary keyword detection
 */

const API_ENDPOINT = '/api/organize';

/**
 * Process text into organized, polished guide sections.
 * @param {string} transcript - The raw text to process
 * @param {string} childName - The child's name
 * @param {string} source - 'dictation' or 'document'
 * Returns: { sections: { sectionKey: ["polished item", ...], ... } }
 */
export async function processTranscript(transcript, childName, source = 'dictation') {
  const isDocument = source === 'document';

  // Try AI processing first
  try {
    const result = await processWithAI(transcript, childName, isDocument);
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
 * AI-powered processing via serverless function
 */
async function processWithAI(transcript, childName, isDocument) {
  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, childName, isDocument })
  });

  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return await response.json();
}

// ==========================================================================
// DOCUMENT PROCESSING (for uploaded PDFs, Word docs, etc.)
// ==========================================================================

/**
 * Process a structured document by splitting on section headers
 * and categorizing each section by its header text and content.
 */
function processDocumentLocally(text, childName) {
  console.log('[CribNotes] Processing document locally, length:', text.length);

  // Step 1: Split document into sections by detecting headers
  const docSections = splitDocumentBySections(text);
  console.log('[CribNotes] Document sections found:', docSections.map(s => s.header));

  // Step 2: Map each document section to a care guide category
  const sections = {};
  for (const docSection of docSections) {
    const category = categorizeDocumentSection(docSection.header, docSection.content);

    if (!sections[category]) sections[category] = [];

    // Split content into individual items (bullet points, paragraphs, etc.)
    const items = extractDocumentItems(docSection.content);
    for (const item of items) {
      const cleaned = cleanDocumentText(item);
      if (cleaned.length > 5) {
        sections[category].push(cleaned);
      }
    }
  }

  // Step 3: Deduplicate within each section
  for (const key of Object.keys(sections)) {
    sections[key] = mergeSimilarItems(sections[key]);
  }

  return { sections };
}

/**
 * Split document text into sections based on header patterns.
 * Detects blank-line separated headers, title-case lines, and known section names.
 */
function splitDocumentBySections(text) {
  const lines = text.split('\n');
  const sections = [];
  let currentHeader = 'General';
  let currentContent = [];

  // Patterns that indicate a section header
  const headerPatterns = [
    /^(key contacts|contacts at a glance|emergency|important contacts)/i,
    /^(locations?|home|apartment|getting to)/i,
    /^(daily schedul|schedule|saturday|sunday|monday|tuesday|wednesday|thursday|friday)/i,
    /^(meals?\s*&?\s*snacks?|breakfast|lunch|dinner|food|snack options|meal tips)/i,
    /^(naps?\s*&?\s*bedtime|sleep|bedtime|nap time)/i,
    /^(diapers?\s*&?\s*potty|toilet|diaper|potty training)/i,
    /^(safety\s*tips?|important|watch out|car\s*&?\s*car seats?)/i,
    /^(tv\s*&?\s*music|tv\s*&?\s*entertainment|screen time|streaming|tv shows)/i,
    /^(car\s*&?\s*travel|car seat|parking|driving)/i,
    /^(activit|toys?|play|outdoor|things to do)/i,
    /^(medical|medication|allerg|health|doctor)/i,
    /^(school|daycare|pickup|drop.?off)/i,
    /^(morning checklist|afternoon pickup|returning from)/i,
    /^(12th floor|amenities|parking garage)/i,
    /^(comfort items|night wakings|quiet time)/i,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check if this line looks like a header
    const isHeader = isDocumentHeader(line, lines, i, headerPatterns);

    if (isHeader && currentContent.length > 0) {
      // Save previous section
      sections.push({
        header: currentHeader,
        content: currentContent.join('\n').trim()
      });
      currentHeader = line;
      currentContent = [];
    } else if (isHeader && currentContent.length === 0) {
      currentHeader = line;
    } else {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentContent.length > 0) {
    sections.push({
      header: currentHeader,
      content: currentContent.join('\n').trim()
    });
  }

  return sections.filter(s => s.content.length > 5);
}

/**
 * Determine if a line is a section header based on multiple signals.
 */
function isDocumentHeader(line, allLines, idx, headerPatterns) {
  // Skip very long lines (headers are short)
  if (line.length > 100) return false;

  // Skip lines that look like bullet points
  if (/^[•\-\*\d]/.test(line) && line.length > 5) return false;

  // Check if it matches known header patterns
  for (const pattern of headerPatterns) {
    if (pattern.test(line)) return true;
  }

  // Check if line is followed by a blank line and is relatively short (title-like)
  const nextLine = idx + 1 < allLines.length ? allLines[idx + 1]?.trim() : '';
  const prevLine = idx > 0 ? allLines[idx - 1]?.trim() : '';

  // Short line preceded by blank line and followed by content
  if (line.length < 60 && !prevLine && nextLine && !line.includes('|') && !/\d{3}/.test(line)) {
    // Check if it looks title-case or bolded (no lowercase start, no punctuation end)
    if (!line.match(/[.!?,;:]$/) && /^[A-Z]/.test(line)) {
      return true;
    }
  }

  return false;
}

/**
 * Map a document section header + content to a care guide category.
 */
function categorizeDocumentSection(header, content) {
  const h = header.toLowerCase();
  const c = content.toLowerCase();
  const combined = h + ' ' + c.substring(0, 300);

  // Check header first (most reliable signal)
  const headerMap = [
    { pattern: /contact|phone|emergency|pediatrician|poison|911/, category: 'emergencyContacts' },
    { pattern: /meal|snack|food|breakfast|lunch|dinner|eat/, category: 'meals' },
    { pattern: /nap|bedtime|sleep|bed time|night waking|quiet time|comfort item/, category: 'napsBedtime' },
    { pattern: /diaper|potty|toilet|bathroom|wipe/, category: 'diapersPotty' },
    { pattern: /safety|important.*read|watch out|car\s*&\s*car seat|car seat/, category: 'safetyTips' },
    { pattern: /tv|music|entertainment|screen|streaming|show|movie/, category: 'tvEntertainment' },
    { pattern: /car|travel|parking|garage|driving|stroller/, category: 'carTravel' },
    { pattern: /activit|toy|play|outdoor|museum|pier|playground|aquarium/, category: 'activities' },
    { pattern: /medical|medication|allerg|health|tylenol/, category: 'medicalInfo' },
    { pattern: /location|apartment|home|address|building|amenit/, category: 'locations' },
    { pattern: /school|daycare|drop.off|pickup|mount carmel|l&l/, category: 'locations' },
    { pattern: /schedul|monday|tuesday|wednesday|thursday|friday|saturday|sunday|checklist/, category: 'dailySchedule' },
  ];

  for (const { pattern, category } of headerMap) {
    if (pattern.test(h)) return category;
  }

  // Fall back to content analysis
  for (const { pattern, category } of headerMap) {
    if (pattern.test(combined)) return category;
  }

  return 'dailySchedule';
}

/**
 * Extract individual items from a document section's content.
 * Handles bullet points, numbered lists, and paragraphs.
 */
function extractDocumentItems(content) {
  const items = [];
  const lines = content.split('\n');
  let currentParagraph = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Blank line = end of paragraph
      if (currentParagraph.length > 0) {
        items.push(currentParagraph.join(' '));
        currentParagraph = [];
      }
      continue;
    }

    // Bullet point or numbered item - standalone item
    if (/^[•\-\*]\s/.test(trimmed) || /^\d+[\.\)]\s/.test(trimmed)) {
      if (currentParagraph.length > 0) {
        items.push(currentParagraph.join(' '));
        currentParagraph = [];
      }
      // Clean the bullet marker
      const cleaned = trimmed.replace(/^[•\-\*]\s+/, '').replace(/^\d+[\.\)]\s+/, '');
      items.push(cleaned);
    }
    // Sub-bullet (indented with special markers)
    else if (/^[⁃]\s/.test(trimmed) || /^\(\d+\)\s/.test(trimmed)) {
      const cleaned = trimmed.replace(/^[⁃]\s+/, '').replace(/^\(\d+\)\s+/, '');
      // Append to previous item if exists
      if (items.length > 0) {
        items[items.length - 1] += ' - ' + cleaned;
      } else {
        items.push(cleaned);
      }
    }
    // Regular line - accumulate into paragraph
    else {
      currentParagraph.push(trimmed);
    }
  }

  // Don't forget the last paragraph
  if (currentParagraph.length > 0) {
    items.push(currentParagraph.join(' '));
  }

  // Split very long items (>250 chars) at sentence boundaries
  const finalItems = [];
  for (const item of items) {
    if (item.length > 250) {
      const sentences = item.match(/[^.!?]+[.!?]+/g) || [item];
      // Group sentences into chunks of ~200 chars
      let chunk = '';
      for (const sentence of sentences) {
        if (chunk.length + sentence.length > 200 && chunk.length > 0) {
          finalItems.push(chunk.trim());
          chunk = sentence;
        } else {
          chunk += sentence;
        }
      }
      if (chunk.trim()) finalItems.push(chunk.trim());
    } else {
      finalItems.push(item);
    }
  }

  return finalItems.filter(item => item.length > 5);
}

/**
 * Clean document text without aggressively rewriting it
 * (unlike dictation, documents are already well-written)
 */
function cleanDocumentText(text) {
  let cleaned = text.trim();

  // Remove excess whitespace
  cleaned = cleaned.replace(/\s{2,}/g, ' ');

  // Capitalize first letter
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  // Remove trailing whitespace, ensure ends with punctuation if needed
  cleaned = cleaned.trim();
  if (cleaned.length > 0 && !cleaned.match(/[.!?:)]$/)) {
    cleaned += '.';
  }

  return cleaned;
}

// ==========================================================================
// DICTATION PROCESSING (for speech-to-text)
// ==========================================================================

/**
 * Process spoken dictation using topic-boundary detection.
 */
function processDictationLocally(transcript, childName) {
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
// TOPIC KEYWORDS - used for dictation categorization and boundary detection
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
    const key = word.toLowerCase();
    if (!WORD_TO_TOPIC[key]) WORD_TO_TOPIC[key] = [];
    WORD_TO_TOPIC[key].push(topic);
  }
}

/**
 * Split text by detecting topic boundaries using a sliding window.
 */
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
        if (segment.length > 10) {
          segments.push(segment);
        }
        currentStart = splitIdx;
        currentTopic = topic;
        lastTopicChangeAt = i;
      }
    }
  }

  const lastSegment = words.slice(currentStart).join(' ').trim();
  if (lastSegment.length > 10) {
    segments.push(lastSegment);
  }

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

/**
 * Categorize text into the best guide section (for dictation)
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

  if (bestScore === 0) bestCategory = 'dailySchedule';
  return bestCategory;
}

/**
 * Polish a raw speech-to-text segment into clean text
 */
function polishText(text, childName) {
  let cleaned = text.trim();

  cleaned = cleaned
    .replace(/\b(um|uh|like|you know|basically|so yeah|I mean)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  cleaned = cleaned
    .replace(/(\d+:\d+)\s*p\.m?\s/gi, '$1 PM ')
    .replace(/(\d+:\d+)\s*a\.m?\s/gi, '$1 AM ')
    .replace(/(\d+:\d+)\s*p\.m?\.?\s*$/i, '$1 PM')
    .replace(/(\d+:\d+)\s*a\.m?\.?\s*$/i, '$1 AM')
    .replace(/(\d+)\s*p\.m?\s/gi, '$1 PM ')
    .replace(/(\d+)\s*a\.m?\s/gi, '$1 AM ')
    .replace(/(\d+)\s*p\.m?\.?\s*$/i, '$1 PM')
    .replace(/(\d+)\s*a\.m?\.?\s*$/i, '$1 AM');

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

  if (childName) {
    cleaned = cleaned
      .replace(/^he\b/i, childName)
      .replace(/^she\b/i, childName);
  }

  cleaned = cleaned.replace(/^(and|but|so|or|also|then|next|plus)\s+/i, '');

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  if (cleaned.length > 0 && !cleaned.match(/[.!?]$/)) {
    cleaned += '.';
  }

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
