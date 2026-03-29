/**
 * Gmail API Service
 * Handles: OAuth token exchange, email searching, bill extraction
 */
const { google } = require('googleapis');
const { storeTokens, getTokens } = require('./firebase');
const { parseBillFromText } = require('../utils/billParser');

function createOAuth2Client() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
}

// Generate the OAuth consent URL for Gmail
function getAuthUrl() {
    const client = createOAuth2Client();
    return client.generateAuthUrl({
        access_type: 'offline',     // Get refresh token
        prompt: 'consent',          // Force consent to always get refresh token
        scope: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/userinfo.email'
        ]
    });
}

// Exchange authorization code for tokens
async function exchangeCode(code, uid) {
    const client = createOAuth2Client();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Store tokens securely
    await storeTokens(uid, 'google', tokens);

    // Get the user's Gmail address
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });

    return {
        email: profile.data.emailAddress,
        provider: 'gmail',
        connected: true
    };
}

// Get an authenticated Gmail client for a user
async function getGmailClient(uid) {
    const tokens = await getTokens(uid, 'google');
    if (!tokens) throw new Error('Gmail not connected');

    const client = createOAuth2Client();
    client.setCredentials({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expiry_date: tokens.expiresAt
    });

    // Handle token refresh
    client.on('tokens', async (newTokens) => {
        await storeTokens(uid, 'google', {
            ...newTokens,
            refresh_token: newTokens.refresh_token || tokens.refreshToken
        });
    });

    return google.gmail({ version: 'v1', auth: client });
}

// Search Gmail for bill-related emails
async function scanForBills(uid, options = {}) {
    const gmail = await getGmailClient(uid);
    const { maxResults = 20, afterDate, householdAddress } = options;

    // Build search query for common bill senders
    const billKeywords = [
        'subject:(bill OR invoice OR statement OR "amount due" OR "payment due")',
        '-category:promotions',
        '-category:social'
    ];

    if (afterDate) {
        billKeywords.push(`after:${afterDate}`);
    }

    const query = billKeywords.join(' ');

    // Search for messages
    const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults
    });

    if (!listRes.data.messages || listRes.data.messages.length === 0) {
        return [];
    }

    // Fetch each message and extract bill info
    const bills = [];

    for (const msg of listRes.data.messages) {
        try {
            const fullMsg = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'full'
            });

            const bill = extractBillFromEmail(fullMsg.data, { householdAddress });
            if (bill) {
                bill.emailId = msg.id;
                bill.source = 'gmail';
                bills.push(bill);
            }
        } catch (err) {
            console.error(`Error processing message ${msg.id}:`, err.message);
        }
    }

    return bills;
}

// Extract bill information from a Gmail message
function extractBillFromEmail(message, options = {}) {
    const headers = message.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const from = headers.find(h => h.name === 'From')?.value || '';
    const date = headers.find(h => h.name === 'Date')?.value || '';

    // Get email body text
    let bodyText = '';
    if (message.payload.body?.data) {
        bodyText = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    } else if (message.payload.parts) {
        for (const part of message.payload.parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
                bodyText += Buffer.from(part.body.data, 'base64').toString('utf-8');
            } else if (part.mimeType === 'text/html' && part.body?.data && !bodyText) {
                // Strip HTML tags as fallback
                const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
                bodyText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
            }
        }
    }

    // Combine subject + from + body for parsing
    const fullText = `${from}\n${subject}\n${bodyText}`;
    const parsed = parseBillFromText(fullText, { householdAddress: options.householdAddress });

    if (!parsed.amount) return null; // Skip if no amount detected

    return {
        provider: parsed.provider || extractProviderFromEmail(from),
        amount: parsed.amount,
        period: parsed.period || '',
        billDate: date ? new Date(date).toLocaleDateString() : '',
        dueDate: parsed.dueDate || '',
        account: parsed.account || '',
        billType: parsed.billType,
        billTypeLabel: parsed.billTypeLabel,
        addressMatch: parsed.addressMatch,
        addressMismatch: parsed.addressMismatch || false,
        serviceAddress: parsed.serviceAddress,
        emailSubject: subject,
        emailFrom: from
    };
}

// Extract provider name from email sender
function extractProviderFromEmail(from) {
    // "Duke Energy <noreply@duke-energy.com>" → "Duke Energy"
    const nameMatch = from.match(/^"?([^"<]+)"?\s*</);
    if (nameMatch) return nameMatch[1].trim();

    // Fallback: extract domain
    const domainMatch = from.match(/@([\w.-]+)/);
    if (domainMatch) {
        return domainMatch[1].replace(/\.(com|net|org)$/, '').replace(/-/g, ' ');
    }

    return 'Unknown Provider';
}

// Check for PDF attachments and extract text
async function getAttachments(uid, messageId) {
    const gmail = await getGmailClient(uid);

    const msg = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full'
    });

    const attachments = [];
    const parts = msg.data.payload.parts || [];

    for (const part of parts) {
        if (part.filename && part.body?.attachmentId) {
            const attachment = await gmail.users.messages.attachments.get({
                userId: 'me',
                messageId: messageId,
                id: part.body.attachmentId
            });

            attachments.push({
                filename: part.filename,
                mimeType: part.mimeType,
                data: attachment.data.data // base64 encoded
            });
        }
    }

    return attachments;
}

module.exports = { getAuthUrl, exchangeCode, scanForBills, getAttachments };
