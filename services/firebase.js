/**
 * Firebase Admin SDK Service
 * Handles: initialization, auth verification, token storage
 *
 * Dev mode: When Firebase credentials aren't configured,
 * uses in-memory storage so the app still works for development.
 */

const fs = require('fs');
const fspath = require('path');

let admin = null;
let db = null;
let devMode = false;

// File-backed token store for dev mode (no Firebase)
const TOKEN_FILE = fspath.join(__dirname, '..', '.token-store.json');
let memoryTokenStore = {};

// Load tokens from disk on startup
try {
    if (fs.existsSync(TOKEN_FILE)) {
        memoryTokenStore = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
    }
} catch (e) { /* ignore */ }

function persistTokens() {
    try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(memoryTokenStore, null, 2)); } catch (e) { /* ignore */ }
}

function initFirebase() {
    // Check if Firebase credentials are configured
    if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
        console.log('Firebase credentials not configured — running in dev mode (in-memory token storage)');
        devMode = true;
        return;
    }

    try {
        admin = require('firebase-admin');

        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
                })
            });
        }

        db = admin.firestore();
        console.log('Firebase Admin initialized');
    } catch (err) {
        console.warn('Firebase init failed, falling back to dev mode:', err.message);
        devMode = true;
    }
}

function getDb() {
    if (devMode) throw new Error('Firebase not available in dev mode');
    return db;
}

/**
 * Store OAuth tokens for a user + provider
 * In dev mode: stores in memory
 * In prod mode: stores in Firestore
 */
async function storeTokens(uid, provider, tokens) {
    const tokenData = {
        accessToken: tokens.access_token || tokens.accessToken,
        refreshToken: tokens.refresh_token || tokens.refreshToken,
        expiresAt: tokens.expiry_date || (Date.now() + (tokens.expires_in || 3600) * 1000),
        updatedAt: Date.now()
    };

    if (devMode) {
        if (!memoryTokenStore[uid]) memoryTokenStore[uid] = {};
        memoryTokenStore[uid][provider] = tokenData;
        persistTokens();
        console.log(`[DEV] Stored ${provider} tokens for uid: ${uid}`);
        return;
    }

    await db.collection('user_tokens').doc(uid).set({
        [provider]: tokenData
    }, { merge: true });
}

/**
 * Retrieve OAuth tokens for a user + provider
 * Returns null if not found
 */
async function getTokens(uid, provider) {
    if (devMode) {
        const tokens = memoryTokenStore[uid]?.[provider] || null;
        return tokens;
    }

    const doc = await db.collection('user_tokens').doc(uid).get();
    if (!doc.exists) return null;
    return doc.data()[provider] || null;
}

/**
 * Middleware: verify Firebase ID token from Authorization header
 * In dev mode: accepts any token and uses it as the uid
 */
function verifyAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        // In dev mode, generate a default uid
        if (devMode) {
            req.uid = 'dev-user-' + (req.ip || 'local').replace(/[^a-zA-Z0-9]/g, '');
            return next();
        }
        return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.split('Bearer ')[1];

    if (devMode) {
        // In dev mode, use token value as uid (or a hash of it)
        req.uid = token.length > 20 ? token.substring(0, 20) : (token || 'dev-user');
        return next();
    }

    // Verify Firebase ID token
    admin.auth().verifyIdToken(token)
        .then(decoded => {
            req.uid = decoded.uid;
            next();
        })
        .catch(err => {
            console.error('Token verification failed:', err.message);
            res.status(401).json({ error: 'Invalid token' });
        });
}

module.exports = { initFirebase, getDb, storeTokens, getTokens, verifyAuth };
