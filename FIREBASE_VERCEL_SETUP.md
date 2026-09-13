# Firebase and Vercel Deployment

The frontend remains the existing static HTML site. Vercel serves those files and routes `/api/*` to `api/index.js`, which uses Firebase Admin SDK and Firestore.

## 1. Create Firebase services

1. Create a Firebase project and enable Firestore in production mode. Firestore can be used without enabling Storage.
2. Create a service account in Firebase project settings and download its JSON key.
3. Deploy `firestore.rules` if client-side Firestore access is ever enabled. The current API uses Admin SDK, so the database is intentionally closed to browsers.

## 2. Migrate existing data

Set these values in a local `.env` file, using the old PostgreSQL connection only for the migration command:

```text
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
EXTERNAL_DATABASE_URL=postgresql://user:password/host/database
```

Then run:

```powershell
npm run migrate:firebase
```

The migration is repeatable because it writes documents using their existing PostgreSQL IDs.

## 3. Configure Vercel

Import the repository into Vercel with the repository root as the project root. Add these environment variables for Production, Preview, and Development:

```text
FIREBASE_SERVICE_ACCOUNT=<the complete service-account JSON on one line>
ADMIN_USERNAME=<admin username>
ADMIN_PASSWORD=<strong admin password>
SESSION_SECRET=<long random value>
```

Deploy with:

```powershell
npx vercel --prod
```

The existing pages continue to call relative `/api` URLs, so no frontend API URL change is needed.

## Email and documents

Firestore replaces the Render database. The current serverless API stores shipments, events, notifications, conversations, and text-only replies in Firestore. Package images and message attachments are disabled until Storage is enabled. Email delivery is intentionally reported as queued until a serverless email provider such as Resend, SendGrid, or Mailgun is configured; Vercel functions must not run the old long-lived IMAP receiver.