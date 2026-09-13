const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function firebaseCredentials() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        account.private_key = account.private_key.replace(/\\n/g, '\n');
        return account;
    }
    return {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
}

if (!getApps().length) {
    initializeApp({ credential: cert(firebaseCredentials()) });
}

const db = getFirestore();
const cookieName = 'networld_admin';
const sessionSecret = process.env.SESSION_SECRET || 'change-this-session-secret';

app.use(express.json({ limit: '1mb' }));

function serialize(value) {
    if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
    if (Array.isArray(value)) return value.map(serialize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
    return value;
}

function signSession(username) {
    const payload = Buffer.from(JSON.stringify({ username, expires: Date.now() + 24 * 60 * 60 * 1000 })).toString('base64url');
    const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function sessionUsername(req) {
    const raw = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`));
    if (!raw) return null;
    const token = raw.slice(cookieName.length + 1);
    const [payload, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', sessionSecret).update(payload || '').digest('base64url');
    if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return session.expires > Date.now() ? session.username : null;
    } catch (error) {
        return null;
    }
}

function requireAuth(req, res, next) {
    const username = sessionUsername(req);
    if (!username) return res.status(401).json({ success: false, message: 'Unauthorized' });
    req.username = username;
    next();
}

async function shipmentById(id) {
    const numericId = Number(id);
    const query = await db.collection('shipments').where('id', '==', Number.isNaN(numericId) ? id : numericId).limit(1).get();
    if (!query.empty) return query.docs[0];
    const doc = await db.collection('shipments').doc(String(id)).get();
    return doc.exists ? doc : null;
}

async function shipmentByTracking(trackingNumber) {
    const query = await db.collection('shipments').where('tracking_number', '==', trackingNumber).limit(1).get();
    return query.empty ? null : query.docs[0];
}

function shipmentData(doc) {
    return { ...serialize(doc.data()), id: doc.data().id ?? doc.id };
}

app.get('/api/health', (req, res) => res.json({ status: 'OK', message: 'Firebase API is running', database: 'firestore' }));

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === (process.env.ADMIN_USERNAME || 'admin') && password === (process.env.ADMIN_PASSWORD || 'admin123')) {
        res.setHeader('Set-Cookie', `${cookieName}=${signSession(username)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`);
        return res.json({ success: true, message: 'Login successful' });
    }
    res.status(401).json({ success: false, message: 'Invalid username or password' });
});

app.get('/api/auth/check', (req, res) => {
    const username = sessionUsername(req);
    res.json(username ? { authenticated: true, username } : { authenticated: false });
});

app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ success: true, message: 'Logged out successfully' });
});

app.get('/api/tracking/:trackingNumber', async (req, res) => {
    try {
        const shipment = await shipmentByTracking(req.params.trackingNumber);
        if (!shipment) return res.status(404).json({ success: false, error: 'Tracking number not found' });
        const events = await db.collection('tracking_events').where('shipment_id', '==', shipment.data().id).orderBy('event_date', 'desc').get();
        res.json({ success: true, data: { shipment: shipmentData(shipment), timeline: events.docs.map(doc => serialize({ ...doc.data(), id: doc.data().id ?? doc.id })) } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/shipments', requireAuth, async (req, res) => {
    const snapshot = await db.collection('shipments').orderBy('created_at', 'desc').limit(100).get();
    res.json({ success: true, data: snapshot.docs.map(shipmentData) });
});

app.post('/api/shipments', requireAuth, async (req, res) => {
    try {
        const now = new Date().toISOString();
        const data = { ...req.body, id: Date.now(), created_at: req.body.creation_date && req.body.creation_time ? `${req.body.creation_date}T${req.body.creation_time}:00.000Z` : now, updated_at: now };
        if (await shipmentByTracking(data.tracking_number)) return res.status(409).json({ success: false, error: 'Tracking number already exists' });
        data.invoice_filename = `${data.tracking_number}-invoice.pdf`;
        data.receipt_filename = `${data.tracking_number}-receipt.pdf`;
        data.invoice_path = `/api/documents/invoices/${data.invoice_filename}`;
        data.receipt_path = `/api/documents/receipts/${data.receipt_filename}`;
        await db.collection('shipments').doc(String(data.id)).set(data);
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/tracking-events', async (req, res) => {
    try {
        const data = { ...req.body, id: Date.now(), created_at: new Date().toISOString() };
        const shipment = await shipmentById(data.shipment_id);
        if (!shipment) return res.status(404).json({ success: false, error: 'Shipment not found' });
        await db.collection('tracking_events').doc(String(data.id)).set(data);
        await shipment.ref.update({ status: data.status, current_location: data.location, updated_at: new Date().toISOString() });
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

async function updateShipment(req, res) {
    try {
        const doc = await shipmentById(req.params.id);
        if (!doc) return res.status(404).json({ success: false, message: 'Shipment not found' });
        const oldData = shipmentData(doc);
        const data = { ...req.body, current_location: req.body.current_location || req.body.origin, updated_at: req.body.update_date && req.body.update_time ? `${req.body.update_date}T${req.body.update_time}:00.000Z` : new Date().toISOString() };
        delete data.id;
        await doc.ref.update(data);
        res.json({ success: true, data: { ...oldData, ...data, id: oldData.id }, oldData });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

app.put('/api/shipments/:id', requireAuth, updateShipment);
app.patch('/api/shipments/:id', requireAuth, updateShipment);
app.delete('/api/shipments/:id', requireAuth, async (req, res) => {
    const shipment = await shipmentById(req.params.id);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found' });
    const events = await db.collection('tracking_events').where('shipment_id', '==', shipment.data().id).get();
    const batch = db.batch();
    events.docs.forEach(doc => batch.delete(doc.ref));
    batch.delete(shipment.ref);
    await batch.commit();
    res.json({ success: true, message: 'Shipment deleted successfully' });
});

app.get('/api/statistics', async (req, res) => {
    const snapshot = await db.collection('shipments').get();
    const shipments = snapshot.docs.map(doc => doc.data());
    res.json({ success: true, data: { total: shipments.length, inTransit: shipments.filter(item => item.status === 'in-transit').length, delivered: shipments.filter(item => item.status === 'delivered').length, pending: shipments.filter(item => item.status === 'pending').length } });
});

app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
    res.status(503).json({ success: false, error: 'File uploads are unavailable until Firebase Storage is enabled.' });
});

app.post('/api/contact-message', async (req, res) => {
    const data = { ...req.body, sender_type: 'customer', is_read: false, created_at: new Date().toISOString(), id: Date.now() };
    const shipment = data.tracking_number ? await shipmentByTracking(data.tracking_number) : null;
    data.shipment_id = shipment?.data().id || null;
    await db.collection('conversations').doc(String(data.id)).set(data);
    res.json({ success: true, message: 'Your message has been received. We will respond shortly!' });
});

app.get('/api/conversations', requireAuth, async (req, res) => {
    const snapshot = await db.collection('conversations').orderBy('created_at', 'desc').get();
    res.json(snapshot.docs.map(doc => serialize({ ...doc.data(), id: doc.data().id ?? doc.id })));
});

app.get('/api/conversations/:trackingNumber', requireAuth, async (req, res) => {
    const snapshot = await db.collection('conversations').where('tracking_number', '==', req.params.trackingNumber).get();
    const messages = snapshot.docs.map(doc => serialize({ ...doc.data(), id: doc.data().id ?? doc.id }));
    messages.sort((left, right) => new Date(left.created_at || 0) - new Date(right.created_at || 0));
    res.json(messages);
});

app.post('/api/conversations/:trackingNumber/read', async (req, res) => {
    const snapshot = await db.collection('conversations').where('tracking_number', '==', req.params.trackingNumber).get();
    const batch = db.batch();
    snapshot.docs.filter(doc => doc.data().sender_type !== 'admin').forEach(doc => batch.update(doc.ref, { is_read: true }));
    await batch.commit();
    res.json({ success: true });
});

app.post('/api/conversations/reply', requireAuth, upload.array('attachments', 5), async (req, res) => {
    if ((req.files || []).length > 0) return res.status(503).json({ success: false, error: 'Attachments are unavailable until Firebase Storage is enabled.' });
    const data = { tracking_number: req.body.tracking_number || null, sender_email: req.body.sender_email || null, sender_type: 'admin', message: req.body.message, attachments: [], is_read: true, created_at: new Date().toISOString(), id: Date.now() };
    const shipment = data.tracking_number ? await shipmentByTracking(data.tracking_number) : null;
    data.shipment_id = shipment?.data().id || null;
    await db.collection('conversations').doc(String(data.id)).set(data);
    res.json({ success: true, message: 'Reply saved. Configure an email provider to deliver it.' });
});

app.post('/api/conversations/:id/mark-read', async (req, res) => {
    const doc = await db.collection('conversations').doc(String(req.params.id)).get();
    if (doc.exists) await doc.ref.update({ is_read: true });
    res.json({ success: true });
});

app.get('/api/conversations/unread/count', requireAuth, async (req, res) => {
    const snapshot = await db.collection('conversations').where('is_read', '==', false).get();
    res.json({ count: snapshot.docs.filter(doc => doc.data().sender_type !== 'admin').length });
});

app.get('/api/notifications', requireAuth, async (req, res) => {
    const snapshot = await db.collection('notifications').orderBy('sent_at', 'desc').limit(100).get();
    res.json({ success: true, data: snapshot.docs.map(doc => serialize({ ...doc.data(), id: doc.id })) });
});

app.post('/api/notifications/send', requireAuth, async (req, res) => {
    const data = { ...req.body, status: 'queued', sent_at: new Date().toISOString() };
    const ref = await db.collection('notifications').add(data);
    res.json({ success: true, message: 'Notification saved. Configure an email provider to deliver it.', data: { ...data, id: ref.id }, emailSent: false });
});

app.get('/api/notifications/shipment/:shipmentId', async (req, res) => {
    const snapshot = await db.collection('notifications').where('shipment_id', '==', Number(req.params.shipmentId)).get();
    res.json({ success: true, data: snapshot.docs.map(doc => serialize({ ...doc.data(), id: doc.id })) });
});

app.post('/api/send-arrival-notification', requireAuth, async (req, res) => {
    const data = { ...req.body, status: 'queued', subject: `Payment required - shipment ${req.body.shipment_id}`, sent_at: new Date().toISOString() };
    await db.collection('notifications').add(data);
    res.json({ success: true, message: 'Arrival notification queued. Configure an email provider to deliver it.' });
});

app.get('/api/documents/:type/:filename', async (req, res) => {
    const tracking = req.params.filename.replace(/-(invoice|receipt)\.pdf$/, '');
    const shipment = await shipmentByTracking(tracking);
    if (!shipment) return res.status(404).send('Document not found');
    res.type('html').send(`<h1>Net World Ship ${req.params.type}</h1><p>Tracking number: ${tracking}</p><p>Status: ${shipment.data().status}</p>`);
});

module.exports = app;