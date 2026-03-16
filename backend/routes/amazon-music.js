const express = require('express');
const router = express.Router();
const axios = require('axios');
const authMiddleware = require('../middleware/auth');

/**
 * Amazon Music Routes
 * 
 * Note: Amazon Music doesn't have a public API for playlist management.
 * Integration options:
 * 1. Use web scraping (not recommended - ToS violation)
 * 2. Use Amazon Music SDK (requires Amazon developer account)
 * 3. Use third-party APIs that aggregate music data
 * 
 * For now, this provides a placeholder structure for when proper integration is set up.
 */

// Check connection status
router.get('/status', authMiddleware, (req, res) => {
    const isConnected = req.user.isPlatformConnected('amazon-music');
    res.json({
        connected: isConnected,
        platform: 'amazon-music',
        message: 'Amazon Music integration requires Amazon Developer credentials'
    });
});

// Get Amazon Music authorization URL
router.get('/auth', authMiddleware, (req, res) => {
    // Amazon Login with Amazon OAuth endpoint
    // Requires: Amazon Developer account and Security Profile setup
    const clientId = process.env.AMAZON_CLIENT_ID;

    if (!clientId || clientId === 'placeholder') {
        return res.status(501).json({
            error: {
                message: 'Amazon Music integration not yet configured. Please add AMAZON_CLIENT_ID to .env',
                status: 501
            }
        });
    }

    const params = new URLSearchParams({
        client_id: clientId,
        scope: 'amazon_music:access profile',
        response_type: 'code',
        redirect_uri: process.env.AMAZON_REDIRECT_URI || 'http://localhost:5001/api/amazon-music/callback'
    });

    res.json({
        authUrl: `https://www.amazon.com/ap/oa?${params.toString()}`
    });
});

// OAuth callback
router.get('/callback', async (req, res) => {
    const { code } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5001';

    if (!code) {
        return res.redirect(`${frontendUrl}?error=amazon_music_auth_failed`);
    }

    try {
        // Exchange code for tokens
        const tokenResponse = await axios.post(
            'https://api.amazon.com/auth/o2/token',
            new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                client_id: process.env.AMAZON_CLIENT_ID,
                client_secret: process.env.AMAZON_CLIENT_SECRET,
                redirect_uri: process.env.AMAZON_REDIRECT_URI
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const { access_token, refresh_token, expires_in } = tokenResponse.data;

        // Store tokens (would need to get user ID from session/state)
        // For now, redirect with success
        res.redirect(`${frontendUrl}?amazon_music_connected=true`);
    } catch (error) {
        console.error('Amazon Music callback error:', error.response?.data || error.message);
        res.redirect(`${frontendUrl}?error=amazon_music_auth_failed`);
    }
});

// Get playlist (placeholder - requires proper API access)
router.get('/playlist/:playlistId', authMiddleware, async (req, res) => {
    res.status(501).json({
        error: {
            message: 'Amazon Music playlist fetching requires Amazon Developer API access',
            status: 501,
            hint: 'Configure AMAZON_CLIENT_ID and AMAZON_CLIENT_SECRET in .env'
        }
    });
});

// Search Amazon Music catalog (placeholder)
router.get('/search', async (req, res) => {
    res.status(501).json({
        error: {
            message: 'Amazon Music search requires Amazon Developer API access',
            status: 501
        }
    });
});

module.exports = router;