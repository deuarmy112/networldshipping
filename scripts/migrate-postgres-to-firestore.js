require('dotenv').config();

const { Pool } = require('pg');
const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function credentials() {
    const account = process.env.FIREBASE_SERVICE_ACCOUNT
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY
        };
    account.privateKey = account.privateKey || account.private_key;
    account.privateKey = account.privateKey.replace(/\\n/g, '\n');
    return account;
}

if (!getApps().length) initializeApp({ credential: cert(credentials()) });

const db = getFirestore();
const pool = new Pool({ connectionString: process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function writeRows(collection, rows) {
    for (let index = 0; index < rows.length; index += 400) {
        const batch = db.batch();
        rows.slice(index, index + 400).forEach(row => {
            const data = { ...row };
            Object.keys(data).forEach(key => {
                if (data[key] instanceof Date) data[key] = data[key].toISOString();
            });
            batch.set(db.collection(collection).doc(String(row.id)), data, { merge: true });
        });
        await batch.commit();
    }
}

async function migrate() {
    const client = await pool.connect();
    try {
        const shipments = (await client.query('SELECT * FROM shipments')).rows;
        const events = (await client.query('SELECT * FROM tracking_events')).rows;
        const notifications = (await client.query('SELECT * FROM notifications')).rows;
        const conversations = (await client.query('SELECT * FROM conversations')).rows;
        await writeRows('shipments', shipments);
        await writeRows('tracking_events', events);
        await writeRows('notifications', notifications);
        await writeRows('conversations', conversations);
        console.log(`Migrated ${shipments.length} shipments, ${events.length} events, ${notifications.length} notifications, and ${conversations.length} conversations.`);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch(error => {
    console.error('Firestore migration failed:', error);
    process.exitCode = 1;
});