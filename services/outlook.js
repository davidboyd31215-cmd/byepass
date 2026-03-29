/**
 * Microsoft Graph API Service (Outlook/Office 365)
 * Handles: OAuth token exchange, email searching, bill extraction
 */
const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');
const { storeTokens, getTokens } = require('./firebase');
const { parseBillFromText } = require('../utils/billParser');

const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com';
const GRAPH_API_URL = 'https://graph.microsoft.com/v1.0';

// Generate the OAuth consent URL for Microsoft
function getAuthUrl() {
    const params = new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID,
        response_type: 'code',
        redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
        scope: 'openid email Mail.Read offline_access',
        response_mode: 'query',
        prompt: 'consent'
    });

    const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
    return `${MICROSOFT_AUTH_URL}/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
}

// Exchange authorization code for tokens
async function exchangeCode(code, uid) {
    const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
    const tokenUrl = `${MICROSOFT_AUTH_URL}/${tenant}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        code: code,
        redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
        grant_type: 'authorization_code',
        scope: 'openid email Mail.Read offline_access'
    });

    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error_description || 'Token exchange failed');
    }

    const tokens = await res.json();

    await storeTokens(uid, 'microsoft', {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in
    });

    // Get user email
    const client = getGraphClient(tokens.access_token);
    const me = await client.api('/me').select('mail,userPrincipalName').get();

    return {
        email: me.mail || me.userPrincipalName,
        provider: 'outlook',
        connected: true
    };
}

// Refresh Microsoft tokens
async function refreshAccessToken(uid) {
    const tokens = await getTokens(uid, 'microsoft');
    if (!tokens?.refreshToken) throw new Error('No refresh token');

    const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
    const tokenUrl = `${MICROSOFT_AUTH_URL}/${tenant}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token',
        scope: 'openid email Mail.Read offline_access'
    });

    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });

    if (!res.ok) throw new Error('Token refresh failed');

    const newTokens = await res.json();
    await storeTokens(uid, 'microsoft', {
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token || tokens.refreshToken,
        expires_in: newTokens.expires_in
    });

    return newTokens.access_token;
}

function getGraphClient(accessToken) {
    return Client.init({
        authProvider: (done) => done(null, accessToken)
    });
}

// Get authenticated Graph client for a user
async function getAuthenticatedClient(uid) {
    let tokens = await getTokens(uid, 'microsoft');
    if (!tokens) throw new Error('Outlook not connected');

    // Check if token is expired
    if (Date.now() >= tokens.expiresAt) {
        const newToken = await refreshAccessToken(uid);
        return getGraphClient(newToken);
    }

    return getGraphClient(tokens.accessToken);
}

// Search Outlook for bill-related emails
async function scanForBills(uid, options = {}) {
    const client = await getAuthenticatedClient(uid);
    const { maxResults = 20, afterDate } = options;

    let filter = "(contains(subject, 'bill') or contains(subject, 'invoice') or contains(subject, 'statement') or contains(subject, 'amount due') or contains(subject, 'payment due'))";

    if (afterDate) {
        filter += ` and receivedDateTime ge ${afterDate}T00:00:00Z`;
    }

    const messages = await client
        .api('/me/messages')
        .filter(filter)
        .top(maxResults)
        .orderby('receivedDateTime desc')
        .select('id,subject,from,receivedDateTime,body,hasAttachments')
        .get();

    if (!messages.value || messages.value.length === 0) {
        return [];
    }

    const bills = [];

    for (const msg of messages.value) {
        try {
            const bill = extractBillFromOutlookEmail(msg);
            if (bill) {
                bill.emailId = msg.id;
                bill.source = 'outlook';
                bills.push(bill);
            }
        } catch (err) {
            console.error(`Error processing Outlook message ${msg.id}:`, err.message);
        }
    }

    return bills;
}

function extractBillFromOutlookEmail(message) {
    const subject = message.subject || '';
    const from = message.from?.emailAddress?.name || message.from?.emailAddress?.address || '';
    const fromEmail = message.from?.emailAddress?.address || '';
    const date = message.receivedDateTime || '';

    let bodyText = '';
    if (message.body?.content) {
        bodyText = message.body.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    }

    const fullText = `${from}\n${subject}\n${bodyText}`;
    const parsed = parseBillFromText(fullText);

    if (!parsed.amount) return null;

    return {
        provider: parsed.provider || from || fromEmail.split('@')[0],
        amount: parsed.amount,
        period: parsed.period || '',
        billDate: date ? new Date(date).toLocaleDateString() : '',
        dueDate: parsed.dueDate || '',
        account: parsed.account || '',
        billType: parsed.billType,
        billTypeLabel: parsed.billTypeLabel,
        emailSubject: subject,
        emailFrom: `${from} <${fromEmail}>`
    };
}

module.exports = { getAuthUrl, exchangeCode, scanForBills };
