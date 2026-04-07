/**
 * byepass Backend Server
 * Handles OAuth flows for Gmail & Outlook, email scanning for bills
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const authRoutes = require('./routes/auth');
const scanRoutes = require('./routes/scan');
const { initFirebase } = require('./services/firebase');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware - CORS Configuration
// Allow both localhost and configured frontend URL
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
        'https://hunihydration.com',
        'https://www.hunihydration.com',
    process.env.FRONTEND_URL,
    process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (file://, mobile apps, curl requests)
        if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Serve static files from public directory
// This allows loading /public/api.js from <script src="http://localhost:3001/public/api.js">
app.use('/public', express.static(path.join(__dirname, 'public')));

// Initialize Firebase Admin
try { initFirebase() } catch(e) { console.log("Firebase not configured - running without it") };

// Validate required environment variables
const requiredEnvVars = ['PORT'];
const optionalButWarnEnvVars = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'FRONTEND_URL'];
for (const v of requiredEnvVars) {
    if (!process.env[v]) {
        console.error(`Missing required env var: ${v}`);
        process.exit(1);
    }
}
for (const v of optionalButWarnEnvVars) {
    if (!process.env[v]) {
        console.warn(`Warning: Missing optional env var: ${v} - some features may not work`);
    }
}

// ===== API ROUTES =====
// All API endpoints are prefixed with /api/ for consistency

// Authentication routes
app.use('/api/auth', authRoutes);

// Scanning routes
app.use('/api/scan', scanRoutes);

// ===== USER DATA PERSISTENCE =====
// Server-side storage so data works across devices / browsers
const fs = require('fs');
const dataDir = path.join(__dirname, '.userdata');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const { verifyAuth } = require('./services/firebase');

// Save user app state
app.post('/api/data/save', verifyAuth, (req, res) => {
    try {
        const filePath = path.join(dataDir, `${req.uid}.json`);
        fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2));
        res.json({ saved: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save: ' + err.message });
    }
});

// Load user app state
app.get('/api/data/load', verifyAuth, (req, res) => {
    try {
        const filePath = path.join(dataDir, `${req.uid}.json`);
        if (!fs.existsSync(filePath)) return res.json({ data: null });
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        res.json({ data });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load: ' + err.message });
    }
});

// Health check endpoint (no authentication required)
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'byepass-backend',
        timestamp: new Date().toISOString()
    });
});

// Root endpoint - info about available routes
app.get('/api', (req, res) => {
    res.json({
        service: 'byepass-backend',
        version: '1.0.0',
        endpoints: {
            auth: {
                google: 'GET /api/auth/google',
                googleCallback: 'GET /api/auth/google/callback',
                microsoft: 'GET /api/auth/microsoft',
                microsoftCallback: 'GET /api/auth/microsoft/callback',
                status: 'GET /api/auth/status',
                disconnect: 'POST /api/auth/disconnect'
            },
            scan: {
                bills: 'POST /api/scan/bills',
                attachments: 'GET /api/scan/attachments/{provider}/{emailId}'
            },
            public: {
                api: 'GET /public/api.js',
                health: 'GET /api/health'
            }
        }
    });
});

// Serve frontend API module for easy inclusion
// Example: <script src="http://localhost:3001/public/api.js"></script>
app.get('/api/client', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'api.js'), {
        'Content-Type': 'application/javascript'
    });
});

// Serve the frontend app
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path,
        method: req.method,
        availableEndpoints: '/api'
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║      Byepass Backend Server            ║
║      Running on port ${PORT}              ║
║      Environment: ${(process.env.NODE_ENV || 'development').padEnd(21)}║
║                                        ║
║  Frontend: ${(process.env.FRONTEND_URL || 'http://localhost:3000').padEnd(23)}║
║  API: http://localhost:${PORT}/api             ║
║  Health: http://localhost:${PORT}/api/health  ║
║  Client: /public/api.js                ║
╚════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
