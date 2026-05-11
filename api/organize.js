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

  const { transcript, childName, isDocument } = req.body;
  if (!transcript) {
    return res.status(400).json({ error: 'No transcript provided' });
  }

  // Use different prompts for documents vs dictation
  const prompt = isDocument
    ? buildDocumentPrompt(transcript, childName)
    : buildDictationPrompt(transcript, childName);

  // Documents need more tokens since they contain more structured content
  const maxTokens = isDocument ? 8192 : 2048;

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
3. Rewrite each item to be clear, concise, and well-structured
4. Preserve all specific details (names, phone numbers, times, food items, medications, etc.) exactly as stated
5. Remove filler words, repetition, and speech artifacts
6. Use third person (e.g., "${childName || 'Child'} goes to bed at 7pm" not "you go to bed at 7pm")
7. Each item should be a complete, standalone instruction or piece of information
8. If the same topic is mentioned multiple times, merge into one comprehensive item

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

Respond in this exact JSON format (no markdown, no code fences):
{"sections":{"sectionKey":["Item 1","Item 2"],"anotherKey":["Item 1"]}}

Raw transcript:
"""
${text}
"""`;
}
