# MOODCHAT — GitHub + Netlify package

This repository is ready to import into Netlify.

## Included

- `public/index.html` — MOODCHAT app
- `public/manifest.json` — installable PWA manifest
- `public/firebase-messaging-sw.js` — background/closed-app notifications
- `public/icon-*.png` and `badge-96.png` — PWA and notification icons
- `netlify/functions/send-notification.js` — secure FCM HTTP v1 sender
- `netlify.toml` — publish directory, Functions directory, and service-worker headers

## Upload to GitHub

Upload **all files and folders from this repository** without changing the structure:

```text
moodchat-netlify-github/
├── public/
│   ├── index.html
│   ├── manifest.json
│   ├── firebase-messaging-sw.js
│   └── icons...
├── netlify/
│   └── functions/
│       └── send-notification.js
├── netlify.toml
├── package.json
└── .gitignore
```

## Connect GitHub to Netlify

1. In Netlify choose **Add new project → Import an existing project**.
2. Select GitHub and choose this repository.
3. Netlify reads `netlify.toml` automatically:
   - Build command: none
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
4. Deploy the site.

## Required private environment variable

The app files contain no Firebase private key. Create one Firebase service-account JSON file:

1. Firebase Console → project `moodchat-f13a0`.
2. Project settings → **Service accounts**.
3. Choose **Generate new private key** and download the JSON.
4. Netlify → Site configuration → **Environment variables**.
5. Add:

```text
Key: FIREBASE_SERVICE_ACCOUNT_JSON
Value: paste the complete contents of the downloaded JSON file
```

6. Trigger a new Netlify deploy.

Never upload that JSON file to GitHub. The `.gitignore` is configured to ignore common service-account filenames.

### Optional base64 method

If Netlify does not accept the raw JSON conveniently, base64-encode it and add:

```text
FIREBASE_SERVICE_ACCOUNT_BASE64
```

The Function accepts either variable; only one is required.

## iPhone test

1. Open the Netlify HTTPS URL in Safari.
2. Share → **Add to Home Screen**.
3. Open MOODCHAT from its Home Screen icon.
4. Log in and open Settings → Notifications.
5. Tap Allow.
6. Use a second account/device to send a message.
7. Close MOODCHAT and test the notification.

## Important

- Firebase Cloud Functions are not used.
- The Netlify Function verifies the sender's Supabase session.
- It confirms that sender and recipients belong to the Firestore chat.
- Firebase private credentials stay in Netlify environment variables.
