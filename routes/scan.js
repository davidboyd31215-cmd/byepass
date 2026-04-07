/**
 * Scan Routes
 * Handles email scanning for bills across connected providers
 */
const express = require('express');
const router = express.Router();
const gmail = require('../services/gmail');
const { verifyAuth, getTokens } = require('../services/firebase');

// POST /api/scan/bills — scan all connected email accounts for bills
router.post('/bills', verifyAuth, async (req, res) => {
    const { afterDate, maxResults = 20, householdAddress } = req.body;

    try {
        const allBills = [];
        const scannedProviders = {};

        // Check Gmail
        const googleTokens = await getTokens(req.uid, 'google');
        if (googleTokens) {
            try {
                const gmailBills = await gmail.scanForBills(req.uid, {
                    maxResults,
                    afterDate,
                    householdAddress
                });
                allBills.push(...gmailBills);
                scannedProviders.gmail = { count: gmailBills.length, status: 'ok' };
            } catch (err) {
                console.error('Gmail scan error:', err.message);
                scannedProviders.gmail = { count: 0, status: 'error', error: err.message };
            }
        }

        // Check Outlook
        const microsoftTokens = await getTokens(req.uid, 'microsoft');
        if (microsoftTokens) {
            try {
                const outlook = require('../services/outlook');
                const outlookBills = await outlook.scanForBills(req.uid, {
                    maxResults,
                    afterDate
                });
                allBills.push(...outlookBills);
                scannedProviders.outlook = { count: outlookBills.length, status: 'ok' };
            } catch (err) {
                console.error('Outlook scan error:', err.message);
                scannedProviders.outlook = { count: 0, status: 'error', error: err.message };
            }
        }

        const response = {
            bills: allBills,
            count: allBills.length,
            scanned: scannedProviders,
            scannedAt: new Date().toISOString()
        };

        // Add warning if no providers are connected
        if (!googleTokens && !microsoftTokens) {
            response.warning = 'No email providers connected';
        }

        res.json(response);
    } catch (err) {
        console.error('Scan failed:', err);
        res.status(500).json({ error: 'Bill scan failed: ' + err.message });
    }
});

// GET /api/scan/attachments/:provider/:emailId — get attachments from an email
router.get('/attachments/:provider/:emailId', verifyAuth, async (req, res) => {
    const { provider, emailId } = req.params;

    try {
        if (provider === 'gmail') {
            const attachments = await gmail.getAttachments(req.uid, emailId);
            res.json({ attachments });
        } else {
            res.status(400).json({ error: `Attachments not supported for provider: ${provider}` });
        }
    } catch (err) {
        console.error('Attachment fetch error:', err);
        res.status(500).json({ error: 'Failed to fetch attachments: ' + err.message });
    }
});

module.exports = router;
