/**
 * Auth Routes
 * Handles OAuth flows for Gmail and Outlook
 */
const express = require('express');
const router = express.Router();
const gmail = require('../services/gmail');
const outlook = require('../services/outlook');
const { verifyAuth } = require('../services/firebase');

// ===== GOOGLE / GMAIL =====

// GET /api/auth/google — redirect user to Google consent screen
router.get('/google', verifyAuth, (req, res) => {
    const url = gmail.getAuthUrl();
    // Attach user ID to state param so we know who to associate tokens with
    const stateUrl = `${url}&state=${req.uid}`;
    res.json({ authUrl: stateUrl });
});

// GET /api/auth/google/callback — handle OAuth callback from Google
router.get('/google/callback', async (req, res) => {
    const { code, state: uid } = req.query;

    if (!code || !uid) {
        return res.status(400).json({ error: 'Missing code or state' });
    }

    try {
        const result = await gmail.exchangeCode(code, uid);
        // Redirect back to frontend with success
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(`${frontendUrl}?emailConnected=true&provider=gmail&email=${encodeURIComponent(result.email)}`);
    } catch (err) {
        console.error('Google OAuth error:', err);
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(`${frontendUrl}?emailError=${encodeURIComponent(err.message)}`);
    }
});

// ===== MICROSOFT / OUTLOOK =====

// GET /api/auth/microsoft — redirect user to Microsoft consent screen
router.get('/microsoft', verifyAuth, (req, res) => {
    if (!process.env.MICROSOFT_CLIENT_ID) {
        return res.status(503).json({ error: 'Outlook not configured. Add MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET to .env (Azure Portal > App Registrations).' });
    }
    let url = outlook.getAuthUrl();
    url += `&state=${req.uid}`;
    res.json({ authUrl: url });
});

// GET /api/auth/microsoft/callback — handle OAuth callback from Microsoft
router.get('/microsoft/callback', async (req, res) => {
    const { code, state: uid } = req.query;

    if (!code || !uid) {
        return res.status(400).json({ error: 'Missing code or state' });
    }

    try {
        const result = await outlook.exchangeCode(code, uid);
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(`${frontendUrl}?emailConnected=true&provider=outlook&email=${encodeURIComponent(result.email)}`);
    } catch (err) {
        console.error('Microsoft OAuth error:', err);
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(`${frontendUrl}?emailError=${encodeURIComponent(err.message)}`);
    }
});

// GET /api/auth/status — check which providers are connected
router.get('/status', verifyAuth, async (req, res) => {
    const { getTokens } = require('../services/firebase');

    const googleTokens = await getTokens(req.uid, 'google');
    const microsoftTokens = await getTokens(req.uid, 'microsoft');

    res.json({
        google: { connected: !!googleTokens },
        microsoft: { connected: !!microsoftTokens }
    });
});

// POST /api/auth/disconnect — disconnect a provider
router.post('/disconnect', verifyAuth, async (req, res) => {
    const { provider } = req.body;
    try {
        const { storeTokens } = require('../services/firebase');
        // Clear tokens by storing null
        await storeTokens(req.uid, provider, {
            access_token: null,
            refresh_token: null,
            expires_in: 0
        });
        res.json({ disconnected: true, provider });
    } catch (err) {
        console.error('Disconnect error:', err);
        res.status(500).json({ error: 'Failed to disconnect: ' + err.message });
    }
});

module.exports = router;
