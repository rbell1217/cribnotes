/**
 * Speech-to-Text and Auto-Categorization Module
 * Uses Web Speech API for real-time transcription
 * Categorizes text into care guide sections using keyword matching
 */

// Web Speech API support
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
}

export function isSpeechRecognitionAvailable() {
  return recognition !== null;
}

// Keyword mappings for auto-categorization
const CATEGORY_KEYWORDS = {
  emergencyContacts: [
    'emergency', 'contact', 'phone', 'call', 'doctor', 'hospital', 'poison',
    'police', 'number', 'ambulance', 'pediatrician', 'parent', 'relative'
  ],
  dailySchedule: [
    'schedule', 'time', 'morning', 'afternoon', 'evening', 'wake', 'bed time',
    'bedtime', 'nap time', 'naptime', 'lunch', 'breakfast', 'dinner', 'snack'
  ],
  meals: [
    'meal', 'food', 'eat', 'drink', 'snack', 'lunch', 'breakfast', 'dinner',
    'bottle', 'milk', 'allergic', 'allergy', 'diet', 'vegetarian', 'picky',
    'favorite', 'juice', 'water', 'formula'
  ],
  napsBedtime: [
    'nap', 'sleep', 'bedtime', 'bedtime routine', 'story', 'lullaby', 'blanket',
    'stuffed animal', 'night light', 'white noise', 'wake', 'sleepy'
  ],
  diapersPotty: [
    'diaper', 'potty', 'toilet', 'bathroom', 'wipe', 'cream', 'rash', 'pull up',
    'training', 'pee', 'poop', 'accident'
  ],
  safetyTips: [
    'safety', 'danger', 'choking', 'hazard', 'poison', 'medication', 'lock',
    'supervision', 'swimming', 'water', 'heat', 'sun', 'allergy', 'warning',
    'never', 'always', 'careful', 'watch'
  ],
  locations: [
    'location', 'place', 'park', 'school', 'library', 'daycare', 'address',
    'near', 'close', 'distance', 'directions', 'route', 'where'
  ],
  tvEntertainment: [
    'tv', 'television', 'movie', 'show', 'screen time', 'app', 'tablet', 'ipad',
    'game', 'video', 'cartoon', 'watch', 'music', 'song', 'play', 'toy',
    'activities', 'play time'
  ],
  carTravel: [
    'car', 'drive', 'travel', 'trip', 'seat belt', 'car seat', 'booster',
    'highway', 'motion sickness', 'stop', 'rest', 'bathroom break', 'gas'
  ],
  activities: [
    'activity', 'play', 'game', 'craft', 'outside', 'park', 'swim', 'bike',
    'sport', 'build', 'draw', 'read', 'music', 'dance', 'favorite', 'toy',
    'exercise', 'fun'
  ],
  medicalInfo: [
    'medical', 'medicine', 'medication', 'prescription', 'allergy', 'allergic',
    'asthma', 'inhaler', 'epi pen', 'emergency', 'condition', 'disease',
    'symptoms', 'treatment', 'doctor', 'hospital', 'vaccine'
  ]
};

/**
 * Categorize text into guide sections based on keywords
 * Returns array of matching categories with confidence scores
 */
export function categorizeText(text) {
  const lowerText = text.toLowerCase();
  const words = lowerText.split(/\s+/);
  const scores = {};

  // Initialize all categories
  Object.keys(CATEGORY_KEYWORDS).forEach(cat => {
    scores[cat] = 0;
  });

  // Score each category based on keyword matches
  Object.entries(CATEGORY_KEYWORDS).forEach(([category, keywords]) => {
    keywords.forEach(keyword => {
      // Check for exact word matches and phrase matches
      if (lowerText.includes(keyword)) {
        scores[category] += 1;
      }
    });
  });

  // Sort by score and return non-zero matches
  const results = Object.entries(scores)
    .filter(([_, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([category, score]) => ({
      category,
      score,
      confidence: Math.min(score / 5, 1) // Normalize to 0-1
    }));

  return results;
}

/**
 * Start speech recognition
 * Returns callbacks for handling transcript updates
 */
export function startDictation() {
  if (!recognition) {
    return {
      success: false,
      error: 'Speech recognition not supported on this browser'
    };
  }

  let finalTranscript = '';
  let interimTranscript = '';
  let isListening = true;

  // Create promise-based interface
  return new Promise((resolve, reject) => {
    recognition.onerror = (event) => {
      isListening = false;
      reject(new Error(`Speech recognition error: ${event.error}`));
    };

    recognition.onend = () => {
      isListening = false;
      resolve({
        success: true,
        transcript: finalTranscript,
        categories: categorizeText(finalTranscript)
      });
    };

    recognition.onresult = (event) => {
      interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;

        if (event.results[i].isFinal) {
          finalTranscript += transcript + ' ';
        } else {
          interimTranscript += transcript;
        }
      }

      // Dispatch event with live updates
      window.dispatchEvent(new CustomEvent('dictationUpdate', {
        detail: {
          final: finalTranscript,
          interim: interimTranscript,
          isListening,
          categories: categorizeText(finalTranscript + interimTranscript)
        }
      }));
    };

    try {
      recognition.start();
    } catch (error) {
      // Already started
    }
  });
}

/**
 * Stop speech recognition
 */
export function stopDictation() {
  if (recognition && recognition) {
    try {
      recognition.stop();
    } catch (error) {
      console.error('Error stopping recognition:', error);
    }
  }
}

/**
 * Abort speech recognition
 */
export function abortDictation() {
  if (recognition) {
    try {
      recognition.abort();
    } catch (error) {
      console.error('Error aborting recognition:', error);
    }
  }
}

/**
 * Get browser's speech recognition support info
 */
export function getSpeechRecognitionInfo() {
  return {
    available: isSpeechRecognitionAvailable(),
    browserSupport: {
      chrome: true,
      firefox: false,
      safari: true,
      edge: true
    }
  };
}
