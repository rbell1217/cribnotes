# CribNotes - Babysitter Care Guide Platform

A production-ready, mobile-first web application for managing and sharing childcare guides between parents and babysitters. Built with vanilla JavaScript, Firebase, and designed for deployment to Vercel.

## Features

- **Authentication**: Email/password signup, Google Sign-In, password reset
- **Two Roles**: Parent and Babysitter modes with different capabilities
- **Care Guides**: Create and manage detailed care guides organized into 11 sections:
  - Emergency Contacts
  - Daily Schedule
  - Meals & Snacks
  - Naps & Bedtime
  - Diapers & Potty
  - Safety Tips
  - Locations
  - TV & Entertainment
  - Car & Travel
  - Activities
  - Medical Info

- **Voice Dictation**: Speech-to-text with automatic categorization of care guide items
- **Checklists**: Create interactive checklists for routines (morning, bedtime, etc.)
- **Photos**: Share and organize photos of children
- **Messaging**: Real-time chat between parents and babysitters
- **Search**: Full-text search across care guides
- **Invite System**: Parents generate invite codes for babysitters to join families
- **Responsive Design**: Mobile-first, works on all devices

## Tech Stack

- **Frontend**: Vanilla JavaScript (ES6+), HTML5, CSS3
- **Backend**: Firebase (Authentication, Firestore Database, Storage)
- **Hosting**: Vercel
- **No Build Step**: Deployed as static site with CDN-loaded Firebase SDK

## Project Structure

```
cribnotes-app/
├── index.html           # Single page app entry point
├── css/
│   └── styles.css      # All styling (responsive design)
├── js/
│   ├── app.js          # Main app logic, routing, UI rendering
│   ├── auth.js         # Firebase authentication module
│   ├── database.js     # Firestore CRUD operations
│   ├── dictation.js    # Speech-to-text and categorization
│   └── config.js       # Firebase configuration
├── vercel.json         # Vercel deployment configuration
├── package.json        # Metadata (no npm dependencies)
├── .gitignore          # Git ignore rules
└── README.md           # This file
```

## Getting Started

### Prerequisites

- A Firebase project (free tier is sufficient)
- Vercel account (optional, for deployment)
- Modern web browser with ES6 support

### 1. Set Up Firebase

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create a new project or use an existing one
3. In Project Settings, create a new web app
4. Copy the Firebase configuration object

### 2. Configure CribNotes

1. Update `js/config.js` with your Firebase credentials:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

### 3. Enable Firebase Services

In Firebase Console:

#### Authentication
- Go to Authentication → Sign-in method
- Enable "Email/Password"
- Enable "Google" (set up OAuth consent screen)

#### Firestore Database
- Create a Firestore database in test mode (for development)
- For production, update security rules:

```firestore
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Users can read/write their own profile
    match /users/{userId} {
      allow read, write: if request.auth.uid == userId;
    }

    // Families accessible to members
    match /families/{familyId} {
      allow read: if request.auth.uid in resource.data.parentIds ||
                     request.auth.uid in resource.data.sitterIds;
      allow write: if request.auth.uid in resource.data.parentIds;

      // Children and subcollections accessible to family members
      match /{document=**} {
        allow read: if request.auth.uid in get(/databases/$(database)/documents/families/$(familyId)).data.parentIds ||
                       request.auth.uid in get(/databases/$(database)/documents/families/$(familyId)).data.sitterIds;
        allow write: if request.auth.uid in get(/databases/$(database)/documents/families/$(familyId)).data.parentIds;
      }
    }
  }
}
```

#### Storage (Optional)
- Enable Cloud Storage for file uploads
- Update rules to allow authenticated users to upload

### 4. Run Locally

```bash
# Simple HTTP server
python3 -m http.server 3000

# Or with Node.js
npx http-server -p 3000

# Open http://localhost:3000 in your browser
```

### 5. Deploy to Vercel

#### Option A: Via Vercel CLI

```bash
npm install -g vercel
vercel
```

#### Option B: Via GitHub Integration

1. Push your code to GitHub
2. Connect repository to Vercel
3. Add environment variables in Vercel project settings:
   - `FIREBASE_API_KEY`
   - `FIREBASE_AUTH_DOMAIN`
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_STORAGE_BUCKET`
   - `FIREBASE_MESSAGING_SENDER_ID`
   - `FIREBASE_APP_ID`

4. Deploy runs automatically on push

#### Option C: Drag & Drop

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Drag and drop the `cribnotes-app` folder
3. Add environment variables when prompted

## Architecture

### Authentication Flow

1. User signs up or logs in
2. Auth state listener triggers in `auth.js`
3. User profile is created/loaded from Firestore
4. `app.js` routes to role selection or family setup
5. Parent creates family or sitter joins with invite code
6. User redirected to appropriate dashboard

### Data Model

```
families/
  {familyId}/
    name: string
    inviteCode: string
    parentIds: [uid]
    sitterIds: [uid]
    createdAt: timestamp
    children/
      {childId}/
        name, age, avatar
        careGuide/
          sections: { emergencyContacts: [], ... }
        checklists/
          {checklistId}/ { title, items: [{text, done}] }
        photos/
          {photoId}/ { url, caption, createdAt }
    messages/
      {msgId}/ { from, text, timestamp }

users/
  {uid}/
    email, name, role, familyId
    createdAt: timestamp
```

### Real-Time Features

- Messages use Firestore real-time listeners for instant chat
- Checklist updates reflect immediately
- Care guide edits visible to all family members

## Usage

### For Parents

1. **Sign up** with email or Google
2. **Select "Parent" role**
3. **Create a family** with a name
4. **Add children** with name and age
5. **Create care guides** using:
   - Manual text entry
   - Voice dictation with auto-categorization
6. **Create checklists** for routines
7. **Share invite code** with babysitters
8. **Upload photos** and send messages

### For Babysitters

1. **Sign up** with email or Google
2. **Select "Babysitter" role**
3. **Enter family invite code** to join
4. **View care guides** (read-only)
5. **Mark checklists** as complete
6. **View photos** and message parents
7. **Access emergency contacts** from guide

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+ (iOS 14.5+)
- Mobile browsers (iOS Safari, Chrome Mobile)

## Speech Recognition

Voice dictation uses the Web Speech API. Browser support:
- ✅ Chrome
- ✅ Edge
- ✅ Safari (iOS 14.5+)
- ⚠️ Firefox (experimental)

Fallback to manual typing if not supported.

## Customization

### Colors

Update CSS variables in `css/styles.css`:

```css
:root {
  --color-navy: #2C3E6B;      /* Primary color */
  --color-teal: #2A9D8F;      /* Accent */
  --color-coral: #E76F51;     /* Action buttons */
  --color-orange: #F4A261;    /* Hover states */
  --color-cream: #FFF8F0;     /* Light background */
}
```

### Care Guide Sections

Modify `GUIDE_SECTIONS` array in `js/database.js`:

```javascript
const GUIDE_SECTIONS = [
  'emergencyContacts',
  'customSection',
  // ... add your own
];

const SECTION_LABELS = {
  customSection: 'Custom Section Label',
  // ...
};
```

### Dictation Keywords

Update `CATEGORY_KEYWORDS` in `js/dictation.js` to improve voice categorization.

## Performance Optimizations

- ✅ No dependencies - minimal bundle size
- ✅ CDN-loaded Firebase SDK
- ✅ Lazy loading of child data
- ✅ Real-time listeners only active when needed
- ✅ CSS-only animations (no JavaScript overhead)
- ✅ Mobile-optimized layouts

## Security Considerations

- Never commit `js/config.js` with real credentials
- Use environment variables for production
- Firebase security rules enforce family-based access
- Firestore in test mode for development only
- Enable HTTPS for production (Vercel default)
- User authentication required for all features

## Troubleshooting

### Firebase not initializing
- Check that `js/config.js` has valid credentials
- Verify Firebase project has Authentication and Firestore enabled
- Check browser console for error messages

### Speech recognition not working
- Not supported in Firefox on desktop (use fallback text input)
- Requires HTTPS on production sites
- iOS requires Safari 14.5+

### Firestore permission errors
- Check security rules match your setup
- Verify user is logged in
- Confirm user is in correct family parentIds or sitterIds array

### Images not loading in production
- Use absolute URLs for image uploads
- Or implement Firebase Storage integration

## Future Enhancements

- [ ] Firebase Storage integration for photos
- [ ] Push notifications
- [ ] Offline mode with service workers
- [ ] Photo filters and editing
- [ ] Calendar/schedule view
- [ ] Video support
- [ ] Dark mode
- [ ] Multilingual support
- [ ] Video call integration
- [ ] Recurring checklists

## Contributing

This is a complete production template. Customize it for your needs:

1. Fork or clone the repository
2. Update Firebase credentials in `js/config.js`
3. Deploy to Vercel
4. Add your own features as needed

## License

MIT License - Feel free to use for personal or commercial projects.

## Support

For issues with:
- **CribNotes**: Check this README and code comments
- **Firebase**: See [Firebase Documentation](https://firebase.google.com/docs)
- **Vercel**: See [Vercel Docs](https://vercel.com/docs)

## Version History

- **1.0.0** - Initial release
  - Authentication (Email, Google Sign-In)
  - Care guides with 11 sections
  - Voice dictation with auto-categorization
  - Checklists and photos
  - Real-time messaging
  - Family invite system
  - Mobile-responsive design
