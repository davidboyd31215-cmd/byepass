/**
 * Byepass Frontend API Integration Module
 * Provides a clean interface for frontend JavaScript to interact with the byepass backend
 *
 * Usage:
 *   const api = new ByepassAPI();
 *   api.connectGmail().then(() => console.log('Gmail connected'));
 */

class ByepassAPI {
    constructor(baseUrl = (window.location.origin + '/api')) {
        this.baseUrl = baseUrl;
        this.idToken = null;
        this.currentUser = null;
        this.oauthWindow = null;

        // Auto-load token from localStorage on init
        this.loadTokenFromStorage();
    }

    /**
     * Set the Firebase ID token for authenticated requests
     * This should be called after user logs in with Firebase Authentication
     * @param {string} idToken - Firebase ID token from user.getIdToken()
     */
    setIdToken(idToken) {
        this.idToken = idToken;
        localStorage.setItem('byepass_id_token', idToken);
    }

    /**
     * Load token from localStorage if available
     * @private
     */
    loadTokenFromStorage() {
        const saved = localStorage.getItem('byepass_id_token');
        if (saved) {
            this.idToken = saved;
        }
    }

    /**
     * Clear stored token
     */
    clearToken() {
        this.idToken = null;
        localStorage.removeItem('byepass_id_token');
    }

    /**
     * Get authorization headers for API requests
     * @private
     * @returns {Object} Headers object with Bearer token
     */
    getAuthHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.idToken}`
        };
    }

    /**
     * Make an authenticated API request
     * @private
     * @param {string} method - HTTP method (GET, POST, etc.)
     * @param {string} endpoint - API endpoint path (without base URL)
     * @param {Object} data - Request body data (optional)
     * @returns {Promise<Object>} Response JSON
     * @throws {Error} If request fails or token is missing
     */
    async makeRequest(method, endpoint, data = null) {
        const url = `${this.baseUrl}${endpoint}`;
        const headers = { 'Content-Type': 'application/json' };
        // Only attach Bearer token if we have one (skip in dev mode)
        if (this.idToken) {
            headers['Authorization'] = `Bearer ${this.idToken}`;
        }
        const options = {
            method,
            headers
        };

        if (data) {
            options.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, options);

            if (!response.ok) {
                let errorMessage = `API Error: ${response.status}`;
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.error || errorData.message || errorMessage;
                } catch {
                    // If response isn't JSON, use status text
                    errorMessage = response.statusText;
                }
                throw new Error(errorMessage);
            }

            return await response.json();
        } catch (error) {
            console.error(`${method} ${endpoint} failed:`, error);
            throw error;
        }
    }

    /**
     * Open OAuth popup window and handle redirect
     * @private
     * @param {string} provider - 'gmail' or 'outlook'
     * @returns {Promise<Object>} Connection result with email and provider
     */
    async openOAuthPopup(provider) {
        return new Promise((resolve, reject) => {
            // Get the OAuth URL from backend
            const endpoint = provider === 'gmail' ? '/auth/google' : '/auth/microsoft';

            this.makeRequest('GET', endpoint)
                .then((result) => {
                    const authUrl = result.authUrl;

                    // Open popup window
                    const width = 500;
                    const height = 600;
                    const left = window.screenX + (window.outerWidth - width) / 2;
                    const top = window.screenY + (window.outerHeight - height) / 2;

                    this.oauthWindow = window.open(
                        authUrl,
                        `${provider}_auth`,
                        `width=${width},height=${height},left=${left},top=${top}`
                    );

                    if (!this.oauthWindow) {
                        reject(new Error('Popup blocked. Please allow popups for this site.'));
                        return;
                    }

                    // Listen for callback from backend redirect
                    const checkWindow = setInterval(() => {
                        try {
                            // Check if popup was closed
                            if (this.oauthWindow.closed) {
                                clearInterval(checkWindow);
                                reject(new Error('Authentication window closed'));
                                return;
                            }

                            // Check for redirect URL with email parameter
                            if (this.oauthWindow.location.href.includes('emailConnected=true')) {
                                const url = new URL(this.oauthWindow.location.href);
                                const email = url.searchParams.get('email');
                                const returnedProvider = url.searchParams.get('provider');

                                clearInterval(checkWindow);
                                this.oauthWindow.close();

                                resolve({
                                    connected: true,
                                    provider: returnedProvider,
                                    email: email
                                });
                            }

                            // Check for error redirect
                            if (this.oauthWindow.location.href.includes('emailError=')) {
                                const url = new URL(this.oauthWindow.location.href);
                                const errorMsg = url.searchParams.get('emailError');

                                clearInterval(checkWindow);
                                this.oauthWindow.close();

                                reject(new Error(decodeURIComponent(errorMsg)));
                            }
                        } catch (e) {
                            // Cross-origin errors are expected before OAuth completes
                            // Continue polling silently
                        }
                    }, 500);

                    // Timeout after 10 minutes
                    setTimeout(() => {
                        if (this.oauthWindow && !this.oauthWindow.closed) {
                            clearInterval(checkWindow);
                            this.oauthWindow.close();
                            reject(new Error('Authentication timeout'));
                        }
                    }, 600000);
                })
                .catch(reject);
        });
    }

    /**
     * Connect Gmail account
     * Opens OAuth popup for user to authorize Gmail access
     * @returns {Promise<Object>} {connected: true, email: string, provider: 'gmail'}
     * @throws {Error} If authentication fails or is cancelled
     */
    async connectGmail() {
        try {
            const result = await this.openOAuthPopup('gmail');
            this.showToast(`Gmail connected: ${result.email}`, 'success');
            return result;
        } catch (error) {
            this.showToast(`Failed to connect Gmail: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Connect Outlook account
     * Opens OAuth popup for user to authorize Outlook/Office 365 access
     * @returns {Promise<Object>} {connected: true, email: string, provider: 'outlook'}
     * @throws {Error} If authentication fails or is cancelled
     */
    async connectOutlook() {
        try {
            const result = await this.openOAuthPopup('outlook');
            this.showToast(`Outlook connected: ${result.email}`, 'success');
            return result;
        } catch (error) {
            this.showToast(`Failed to connect Outlook: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Disconnect an email provider
     * @param {string} provider - 'gmail' or 'outlook'
     * @returns {Promise<Object>} {disconnected: true, provider: string}
     * @throws {Error} If disconnection fails
     */
    async disconnectEmail(provider) {
        try {
            const result = await this.makeRequest('POST', '/auth/disconnect', { provider });
            this.showToast(`${provider} disconnected`, 'success');
            return result;
        } catch (error) {
            this.showToast(`Failed to disconnect ${provider}: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Get authentication status for all providers
     * @returns {Promise<Object>} {google: {connected: boolean}, microsoft: {connected: boolean}}
     * @throws {Error} If request fails
     */
    async getAuthStatus() {
        try {
            return await this.makeRequest('GET', '/auth/status');
        } catch (error) {
            console.error('Failed to get auth status:', error);
            throw error;
        }
    }

    /**
     * Trigger server-side bill scanning for all connected email accounts
     * @param {Object} options - Scan options (optional)
     * @param {string} options.afterDate - Only scan emails after this date (YYYY-MM-DD format)
     * @param {number} options.maxResults - Maximum number of emails to scan per provider (default: 20)
     * @returns {Promise<Object>} {bills: Array, scanned: Object, count: number, scannedAt: string}
     * @throws {Error} If scan fails
     */
    async scanBills(options = {}) {
        try {
            this.showToast('Scanning emails for bills...', 'info');

            const response = await this.makeRequest('POST', '/scan/bills', {
                afterDate: options.afterDate || null,
                maxResults: options.maxResults || 20
            });

            const count = response.count || 0;
            this.showToast(`Found ${count} bills`, 'success');

            return response;
        } catch (error) {
            this.showToast(`Scan failed: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Get cached scan results
     * Note: This returns the results from the last scan request
     * In a full implementation, you might store these in localStorage
     * @returns {Promise<Object>} Scan results with bills
     * @throws {Error} If no results are cached
     */
    async getScanResults() {
        try {
            const cached = localStorage.getItem('byepass_scan_results');
            if (!cached) {
                throw new Error('No scan results cached. Run scanBills() first.');
            }
            return JSON.parse(cached);
        } catch (error) {
            console.error('Failed to get scan results:', error);
            throw error;
        }
    }

    /**
     * Get PDF attachments from a specific email
     * Currently only supported for Gmail
     * @param {string} provider - 'gmail' or 'outlook'
     * @param {string} emailId - Email message ID
     * @returns {Promise<Object>} {attachments: Array} - Array of attachment objects with filename, mimeType, and data
     * @throws {Error} If request fails or provider not supported
     */
    async getAttachments(provider, emailId) {
        try {
            return await this.makeRequest('GET', `/scan/attachments/${provider}/${emailId}`);
        } catch (error) {
            console.error(`Failed to get attachments for ${provider}/${emailId}:`, error);
            throw error;
        }
    }

    /**
     * Check backend health/connectivity
     * @returns {Promise<Object>} {status: 'ok', service: string}
     * @throws {Error} If backend is unreachable
     */
    async healthCheck() {
        try {
            const response = await fetch(`${this.baseUrl}/health`);
            if (!response.ok) {
                throw new Error(`Health check failed: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error('Health check failed:', error);
            throw error;
        }
    }

    /**
     * Display a toast notification to the user
     * If no toast handler is configured, logs to console instead
     * @private
     * @param {string} message - Message to display
     * @param {string} type - 'success', 'error', 'info', or 'warning'
     */
    showToast(message, type = 'info') {
        // Check if window has a custom toast handler
        if (window.byepassShowToast && typeof window.byepassShowToast === 'function') {
            window.byepassShowToast(message, type);
        } else {
            // Fallback: log to console
            const prefix = type.toUpperCase();
            console.log(`[${prefix}] ${message}`);
        }
    }

    /**
     * Register a custom toast notification handler
     * The handler will be called with (message, type) arguments
     * @param {Function} handler - Function to handle toast notifications
     * @example
     * api.setToastHandler((msg, type) => {
     *   // custom toast implementation
     *   alert(`${type}: ${msg}`);
     * });
     */
    setToastHandler(handler) {
        window.byepassShowToast = handler;
    }
}

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ByepassAPI;
}
