/**
 * Vercel Serverless Function: /api/organize
 * Takes raw text (from dictation or document upload) + child name,
 * returns polished care guide entries organized into sections using Claude AI.
 */

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { transcript, childName, isDocument, mode } = req.body;
  if (!transcript) {
    return res.status(400).json({ error: 'No transcript provided' });
  }

  // Three prompt modes:
  //   - 'checklist'  : flat to-do list (no sections)
  //   - 'document'   : structured doc, preserve wording
  //   - default      : free-form dictation -> sections + critical info
  let prompt;
  let maxTokens;
  if (mode === 'checklist') {
    prompt = buildChecklistPrompt(transcript, childName);
    maxTokens = 1024;
  } else if (isDocument) {
    prompt = buildDocumentPrompt(transcript, childName);
    maxTokens = 8192;
  } else {
    prompt = buildDictationPrompt(transcript, childName);
    maxTokens = 2048;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: prompt
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', errText);
      return res.status(500).json({ error: 'AI processing failed' });
    }

    const data = await response.json();
    const text = data.content[0].text.trim();

    // Parse the JSON response
    let organized;
    try {
      organized = JSON.parse(text);
    } catch (e) {
      // Try extracting JSON from the response if it has extra text
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        organized = JSON.parse(jsonMatch[0]);
      } else {
        console.error('Failed to parse AI response:', text);
        return res.status(500).json({ error: 'Failed to parse AI response' });
      }
    }

    return res.status(200).json(organized);
  } catch (error) {
    console.error('Error calling AI:', error);
    return res.status(500).json({ error: error.message });
  }
}

function buildDocumentPrompt(text, childName) {
  return `You are organizing a structured care guide document into a babysitter app. The document was uploaded as a PDF or Word file and contains care instructions for ${childName ? `a child named ${childName}` : 'children'}.

The document is already well-written. Your job is to:
1. Read the entire document carefully
2. Extract ALL meaningful care information
3. Organize every piece of information into the correct app sections (listed below)
4. PRESERVE the original wording as much as possible - do not aggressively rewrite
5. Keep specific details EXACTLY as stated: names, phone numbers, times, addresses, codes, passwords, etc.
6. Each item should be a complete, useful instruction or piece of information
7. For long procedural content (like directions), keep related steps together as one item
8. Include ALL information - do not skip sections of the document

Sections (use these exact keys):
- emergencyContacts: Phone numbers, who to call, emergency contacts, pediatrician, local people to contact
- dailySchedule: Daily routines, schedules for each day, morning/afternoon/evening timing, checklists
- meals: Food preferences, what they eat/drink, allergies, feeding instructions, meal tips, snack options
- napsBedtime: Sleep schedule, bedtime routine, comfort items, sleep setup, night wakings, nap times
- diapersPotty: Diaper changes, potty training, supplies, bathroom reminders
- safetyTips: Safety warnings, things to watch out for, apartment safety, behavioral guidance
- locations: Addresses, apartment info, school locations, directions, parking, WiFi info, building access
- tvEntertainment: TV shows, streaming apps, music, screen time rules
- carTravel: Car seat info, travel tips, stroller info, parking garage directions
- activities: Activity suggestions, favorite toys, things to do, outings, museums, parks
- medicalInfo: Medications, health conditions, Tylenol dosage

IMPORTANT:
- Include a section ONLY if the document contains relevant information
- For contacts with phone numbers, format them clearly
- For schedules, include the day name and keep time-based items together
- Do NOT skip any content from the document - be comprehensive
- Each array item should be a self-contained piece of information (not too short, not too long)

Respond in this exact JSON format (no markdown, no code fences):
{"sections":{"sectionKey":["Item 1","Item 2"],"anotherKey":["Item 1"]}}

Document text:
"""
${text}
"""`;
}

function buildDictationPrompt(text, childName) {
  return `You are organizing a parent's spoken care guide for their child${childName ? ` named ${childName}` : ''}. The parent dictated this into a speech-to-text system, so it may be rambling, repetitive, or unstructured.

Your job:
1. Extract all meaningful care information from the transcript
2. Organize it into the correct sections (listed below)
3. Rewrite each item to be SCANNABLE at a glance, using a "Label: value" format wherever possible
4. Preserve all specific details (names, phone numbers, times, food items, medications, etc.) exactly as stated
5. Remove filler words, repetition, and speech artifacts
6. If the same topic is mentioned multiple times, merge into one comprehensive item

FORMAT EVERY ITEM AS "LABEL: VALUE" WHEN POSSIBLE. The label should be short (1-3 words), capitalized like a heading, followed by a colon and the value. Examples:
- "Wake up: 10:00 AM" (NOT "${childName || 'Child'} wakes up at 10:00 AM")
- "Bedtime: 8:00 PM"
- "Nap: 1:00 PM, 90 minutes"
- "Pediatrician: Dr. Smith, 401-555-9999"
- "Emergency contact: Aunt Ariel, 401-225-3961"
- "Favorite food: Pasta with butter"
- "Allergy: Peanuts"
- "Medication: Tylenol, 5mL every 4 hours if fever over 101"
- "Comfort item: Brown teddy bear named Mr. Bear"
- "Diaper size: 4"
- "School: Mount Carmel, drop-off 8:30 AM"

Only use a full sentence when the information is genuinely procedural (multi-step instruction) and can't be compressed into a label:value pair. Example: "Bedtime routine: Bath, two books, then white noise machine on dresser."

Sections:
- emergencyContacts: Phone numbers, who to call, emergency procedures
- dailySchedule: Typical daily routine, timing of activities
- meals: Food preferences, allergies, what they eat/drink, feeding instructions
- napsBedtime: Sleep schedule, bedtime routine, sleep aids (blankets, sound machines, etc.)
- diapersPotty: Diaper changes, potty training status, supplies needed
- safetyTips: Things to watch out for, behavioral guidance, discipline approach, sibling dynamics
- locations: Important places (parks, schools, doctor offices)
- tvEntertainment: Screen time rules, favorite shows, allowed apps/games
- carTravel: Car seat info, travel tips
- activities: Favorite toys, games, activities, outdoor play
- medicalInfo: Medications, conditions, allergies, doctor info

IMPORTANT: Only include a section in your response if the transcript contains relevant information for it. Skip sections with no relevant content.

ALSO EXTRACT CRITICAL INFO. If the transcript mentions any of these high-stakes facts, return them in a "critical" object at the top level so they get pinned to the always-visible Critical Info card:
- Allergies: each as {"allergen": "Peanuts", "severity": "severe" | "moderate" | "mild" (if stated), "reaction": "...", "treatment": "Epinephrine, then call 911"} — severity/reaction/treatment optional
- Current medications: each as {"name": "Albuterol inhaler", "dose": "2 puffs", "schedule": "before exercise"} — dose/schedule optional
- Emergency contacts: each as {"name": "Aunt Ariel", "relationship": "Aunt", "phone": "401-225-3961"} — relationship optional
- Pediatrician: {"name": "Dr. Smith", "phone": "..."}
- Blood type: "O+"

Always include the same facts in the relevant guide section AND in the critical block. A peanut allergy should appear in both "meals" (or "medicalInfo") and in critical.allergies. An emergency contact phone number should appear in both "emergencyContacts" and critical.emergencyContacts.

Respond in this exact JSON format (no markdown, no code fences). Omit "critical" if nothing critical was mentioned, and omit any field inside critical that wasn't mentioned:
{"sections":{"sectionKey":["Label: value"]},"critical":{"allergies":[{"allergen":"Peanuts","severity":"severe"}],"medications":[{"name":"...","dose":"..."}],"emergencyContacts":[{"name":"...","phone":"...","relationship":"..."}],"pediatrician":{"name":"...","phone":"..."},"bloodType":"O+"}}

Raw transcript:
"""
${text}
"""`;
}

function buildChecklistPrompt(text, childName) {
  return `You are turning a parent's spoken description of a list into a clean, actionable checklist for a babysitter${childName ? ` taking care of ${childName}` : ''}.

The parent dictated this aloud, so it may include filler words, repetition, and rambling. Your job:
1. Suggest a short title for the list (3-5 words, Title Case). Examples: "Morning Routine", "Park Bag", "Bedtime Steps"
2. Extract each distinct action item as a short, scannable instruction
3. Each item should be ONE action — split compound sentences into multiple items
4. Use imperative voice ("Pack sunscreen", not "Make sure you pack sunscreen")
5. Preserve specific details (amounts, times, locations, names)
6. Order items in the natural sequence the parent described (or chronological for routines)
7. Aim for 3-15 items; if the parent gave fewer that's fine

Respond in this exact JSON format (no markdown, no code fences):
{"title":"Morning Routine","items":["Pack sunscreen","Bring two bottles of water","Drop off at park by 10 AM"]}

Raw transcript:
"""
${text}
"""`;
}
