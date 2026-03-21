# CribNotes Quick Start Guide

Get CribNotes running in 10 minutes.

## Step 1: Clone or Download (1 minute)

```bash
# If cloning from GitHub
git clone <your-repo-url>
cd cribnotes-app

# If downloading manually, extract the folder
```

## Step 2: Set Up Firebase (5 minutes)

1. **Create Firebase Project**
   - Go to https://console.firebase.google.com
   - Click "Create a project"
   - Enter any name (e.g., "CribNotes")
   - Select free Spark plan
   - Create project

2. **Get Your Credentials**
   - In Firebase console, click "Project Settings" (gear icon)
   - Scroll to "Your apps" section
   - Click "Web app" (</> icon) if not created
   - Copy the `firebaseConfig` object

3. **Update config.js**
   ```bash
   # Open js/config.js
   # Replace the firebaseConfig values with your credentials
   ```

4. **Enable Authentication**
   - In Firebase console, go to Authentication
   - Click "Get started" → "Sign-in method"
   - Enable "Email/Password"
   - Enable "Google" (follow OAuth consent screen setup)

5. **Create Firestore Database**
   - Go to Firestore Database
   - Click "Create database"
   - Start in **Test mode** (for development)
   - Create

## Step 3: Run Locally (2 minutes)

**Option A: Python (Mac/Linux/Windows)**
```bash
cd cribnotes-app
python3 -m http.server 3000
# Visit http://localhost:3000
```

**Option B: Node.js**
```bash
npx http-server -p 3000
# Visit http://localhost:3000
```

**Option C: VS Code Live Server**
- Install "Live Server" extension
- Right-click `index.html` → "Open with Live Server"

## Step 4: Test the App (2 minutes)

1. **Create Test Account**
   - Click "Sign up"
   - Enter email and password
   - Select "Parent" role
   - Create family "Test Family"

2. **Add a Child**
   - Click "+ Add Child"
   - Enter name "Test Child"
   - Enter age "3"
   - Click "Add"

3. **Create Care Guide**
   - Click child card
   - Select "Emergency Contacts" tab
   - Click pencil icon
   - Add "Mom: 555-1234"
   - Click "Save"

4. **Try Voice Dictation**
   - Go back to dashboard
   - Click "Dictate Guide"
   - Click large microphone button
   - Say: "Schedule is 9am breakfast, 12pm lunch, 3pm snack"
   - Click "Save to Guide"

5. **Test as Babysitter**
   - Open new private/incognito window
   - Create new account
   - Select "Babysitter" role
   - In first window, copy the invite code from Settings
   - In second window, paste code and join family
   - See child's care guide

## Troubleshooting

**Firebase not connecting?**
- Check js/config.js has correct credentials
- Verify Firebase project exists in console
- Check browser console (F12) for errors

**Speech recognition not working?**
- Not available in Firefox desktop (fallback to text)
- Requires HTTPS in production
- Works on iOS Safari 14.5+

**Firestore permission error?**
- Check you're in Test mode
- Refresh the page
- Check browser console

## Next Steps

1. **Deploy to Vercel** (optional)
   ```bash
   npm install -g vercel
   vercel
   ```

2. **Switch to Production**
   - Set up Firestore security rules (see README.md)
   - Use environment variables for Firebase config
   - Enable HTTPS

3. **Add Features**
   - Customize color scheme
   - Add more care guide sections
   - Integrate photo uploads to Firebase Storage
   - Add notifications

## Need Help?

- **Setup issues**: See README.md "Troubleshooting" section
- **Firebase questions**: https://firebase.google.com/docs
- **Vercel deployment**: https://vercel.com/docs
- **Code questions**: Check comments in js/app.js

## Quick Links

- 🚀 [Deploy to Vercel](https://vercel.com/import)
- 🔥 [Firebase Console](https://console.firebase.google.com)
- 📚 [Firebase Docs](https://firebase.google.com/docs)
- 🎨 [Customize Colors](css/styles.css) - Search for `:root`

---

**That's it!** You now have a fully functional CribNotes instance.

Go create care guides and invite babysitters! 🎉
