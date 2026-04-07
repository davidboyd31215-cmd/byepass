/**
 * Bill Parser Utility
 * Extracts bill information (provider, amount, due date, billing period, etc.)
 * from raw email text or PDF text content.
 */

// Known bill providers and their aliases
const PROVIDER_PATTERNS = [
    { name: 'Dominion Energy', patterns: ['dominion', 'dominion energy', 'dom energy'] },
    { name: 'Duke Energy', patterns: ['duke energy', 'duke-energy'] },
    { name: 'Xfinity', patterns: ['xfinity', 'comcast'] },
    { name: 'Spectrum', patterns: ['spectrum', 'charter'] },
    { name: 'AT&T', patterns: ['at&t', 'att.com', 'att '] },
    { name: 'Verizon', patterns: ['verizon'] },
    { name: 'T-Mobile', patterns: ['t-mobile', 'tmobile'] },
    { name: 'Piedmont Natural Gas', patterns: ['piedmont', 'piedmont natural gas'] },
    { name: 'Washington Gas', patterns: ['washington gas'] },
    { name: 'CVWD', patterns: ['cvwd', 'charlottesville water'] },
    { name: 'Netflix', patterns: ['netflix'] },
    { name: 'Spotify', patterns: ['spotify'] },
    { name: 'Hulu', patterns: ['hulu'] },
    { name: 'Disney+', patterns: ['disney+', 'disney plus', 'disneyplus'] },
    { name: 'HBO Max', patterns: ['hbo', 'hbo max'] },
    { name: 'State Farm', patterns: ['state farm', 'statefarm'] },
    { name: 'Lemonade', patterns: ['lemonade'] },
    { name: 'GEICO', patterns: ['geico'] },
    { name: 'Progressive', patterns: ['progressive'] }
];

// Bill type classification
const BILL_TYPES = [
    { type: 'electric', label: 'Electric', keywords: ['electric', 'energy', 'dominion', 'duke', 'power', 'eversource', 'pge', 'pg&e', 'conedison', 'kwh'] },
    { type: 'water', label: 'Water', keywords: ['water', 'sewer', 'hydro', 'cvwd', 'gallons'] },
    { type: 'gas', label: 'Gas', keywords: ['gas', 'piedmont', 'natural gas', 'propane', 'therms'] },
    { type: 'internet', label: 'Internet', keywords: ['internet', 'xfinity', 'comcast', 'spectrum', 'at&t', 'wifi', 'fiber', 'broadband', 'mbps'] },
    { type: 'rent', label: 'Rent', keywords: ['rent', 'landlord', 'property', 'lease', 'housing', 'apartment'] },
    { type: 'trash', label: 'Trash', keywords: ['trash', 'waste', 'recycling', 'sanitation'] },
    { type: 'streaming', label: 'Streaming', keywords: ['netflix', 'hulu', 'disney', 'hbo', 'spotify', 'apple tv', 'paramount', 'peacock', 'youtube premium'] },
    { type: 'phone', label: 'Phone', keywords: ['phone', 'mobile', 'verizon wireless', 't-mobile', 'sprint', 'cricket', 'mint mobile', 'cellular'] },
    { type: 'insurance', label: 'Insurance', keywords: ['insurance', 'renters', 'lemonade', 'geico', 'allstate', 'progressive', 'state farm', 'premium'] },
    { type: 'groceries', label: 'Groceries', keywords: ['grocery', 'groceries', 'instacart', 'walmart', 'kroger', 'publix', 'costco'] }
];

/**
 * Parse bill information from raw text
 * @param {string} text - Raw email or PDF text
 * @param {Object} options - { householdAddress: string }
 * @returns {Object} Parsed bill data
 */
function parseBillFromText(text, options = {}) {
    if (!text || typeof text !== 'string') {
        return { amount: null, dueDate: null, provider: null, account: null, billType: null };
    }
    const lowerText = text.toLowerCase();

    const result = {
        provider: null,
        amount: null,
        dueDate: null,
        period: null,
        account: null,
        billType: 'other',
        billTypeLabel: 'Other',
        addressMatch: false,
        addressMismatch: false,
        serviceAddress: null
    };

    // 1. Extract provider name
    for (const p of PROVIDER_PATTERNS) {
        if (p.patterns.some(pat => lowerText.includes(pat))) {
            result.provider = p.name;
            break;
        }
    }

    // 2. Extract dollar amount (look for the most prominent one)
    const amountPatterns = [
        /(?:amount\s*due|total\s*due|balance\s*due|total\s*amount|amount\s*owed|please\s*pay)[:\s]*\$?([\d,]+\.?\d{0,2})/i,
        /(?:total|balance|due|owe|pay)[:\s]*\$?([\d,]+\.?\d{0,2})/i,
        /(?:total|balance|payment\s*amount|you\s*owe)[:\s]*\$?([\d,]+\.?\d{0,2})/i,
        /\$([\d,]+\.\d{2})/
    ];

    for (const pattern of amountPatterns) {
        const match = text.match(pattern);
        if (match) {
            const amount = parseFloat(match[1].replace(/,/g, ''));
            if (amount > 0 && amount < 50000) {
                result.amount = amount;
                break;
            }
        }
    }

    // 3. Extract due date
    const dueDatePatterns = [
        /(?:due\s*(?:date|by|on)?)[:\s]*(\w+\s+\d{1,2},?\s*\d{4})/i,
        /(?:due\s*(?:date|by|on)?)[:\s]*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
        /(?:pay\s*by|payment\s*due)[:\s]*(\w+\s+\d{1,2},?\s*\d{4})/i
    ];

    for (const pattern of dueDatePatterns) {
        const match = text.match(pattern);
        if (match) {
            try {
                const parsed = new Date(match[1]);
                if (!isNaN(parsed.getTime())) {
                    result.dueDate = parsed.toISOString().split('T')[0];
                    break;
                }
            } catch(e) {}
        }
    }

    // 4. Extract billing period
    const periodPatterns = [
        /(?:billing\s*period|service\s*period|for\s*period)[:\s]*([\w\s,]+\d{4})\s*(?:to|-|through)\s*([\w\s,]+\d{4})/i,
        /(\w+\s+\d{1,2})\s*(?:to|-|through)\s*(\w+\s+\d{1,2},?\s*\d{4})/i,
        /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:to|-|through)\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i
    ];

    for (const pattern of periodPatterns) {
        const match = text.match(pattern);
        if (match) {
            result.period = `${match[1].trim()} - ${match[2].trim()}`;
            break;
        }
    }

    // 5. Extract account number
    const accountPatterns = [
        /(?:account\s*(?:number|#|no\.?))[:\s]*([\d][\d\-\s]{3,19}[\d])/i,
        /(?:acct\.?\s*(?:#|no\.?))[:\s]*([\d][\d\-\s]{3,19}[\d])/i
    ];

    for (const pattern of accountPatterns) {
        const match = text.match(pattern);
        if (match) {
            result.account = match[1].trim();
            break;
        }
    }

    // 6. Classify bill type
    for (const bt of BILL_TYPES) {
        if (bt.keywords.some(k => lowerText.includes(k))) {
            result.billType = bt.type;
            result.billTypeLabel = bt.label;
            break;
        }
    }

    // 7. Check service address match
    if (options.householdAddress) {
        const addrLower = options.householdAddress.toLowerCase();
        const addrParts = addrLower.split(/[\s,]+/).filter(p => p.length > 2);
        const addressPatterns = [
            /(?:service\s*address|property\s*address|location)[:\s]*([^\n]+)/i,
            /(\d+\s+\w+\s+(?:st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|ct|court|way|pl|place)[.\s,]*[^\n]*)/i
        ];

        for (const pattern of addressPatterns) {
            const match = text.match(pattern);
            if (match) {
                result.serviceAddress = match[1].trim();
                const foundAddr = result.serviceAddress.toLowerCase();
                const matchCount = addrParts.filter(p => foundAddr.includes(p)).length;
                if (matchCount >= 2) {
                    result.addressMatch = true;
                } else {
                    result.addressMismatch = true;
                }
                break;
            }
        }
    }

    return result;
}

module.exports = { parseBillFromText, BILL_TYPES, PROVIDER_PATTERNS };
