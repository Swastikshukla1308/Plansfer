const express = require('express');
const router = express.Router();
const axios = require('axios');
const authMiddleware = require('../middleware/auth');

const DEEZER_AUTH_URL = 'https://connect.deezer.com/oauth/auth.php';
const DEEZER_TOKEN_URL = 'https://connect.deezer.com/oauth/access_token.php';
const DEEZER_API_URL = 'https://api.deezer.com';

/**
 * Deezer OAuth Flow
 * Note: Deezer uses simplified OAuth 2.0 without refresh tokens
 * Access tokens are long-lived (expires after ~1 hour of inactivity)
 */

// Initiate Deezer OAuth flow
router.get('/auth', authMiddleware, (req, res) => {
    const params = new URLSearchParams({
        app_id: process.env.DEEZER_APP_ID,
        redirect_uri: process.env.DEEZER_REDIRECT_URI,
        perms: 'basic_access,email,manage_library,offline_access',
        state: req.userId.toString()
    });

    res.json({
        authUrl: `${DEEZER_AUTH_URL}?${params.toString()}`
    });
});

// Deezer OAuth callback
router.get('/callback', async (req, res) => {
    const { code, state: userId } = req.query;

    if (!code) {
        return res.redirect(`${process.env.FRONTEND_URL}?error=deezer_auth_failed`);
    }

    try {
        // Exchange code for access token
        const tokenUrl = `${DEEZER_TOKEN_URL}?app_id=${process.env.DEEZER_APP_ID}&secret=${process.env.DEEZER_SECRET_KEY}&code=${code}&output=json`;

        const tokenResponse = await axios.get(tokenUrl);
        const { access_token, expires } = tokenResponse.data;

        if (!access_token) {
            throw new Error('No access token received from Deezer');
        }

        // Save tokens to user
        const UserModel = require('../models/User');
        const user = await UserModel.findById(userId);

        if (user) {
            await user.connectPlatform('deezer', {
                accessToken: access_token,
                expiresAt: expires ? new Date(Date.now() + expires * 1000) : null
            });
        }

        res.redirect(`${process.env.FRONTEND_URL}?deezer_connected=true`);
    } catch (error) {
        console.error('Deezer callback error:', error.response?.data || error.message);
        res.redirect(`${process.env.FRONTEND_URL}?error=deezer_auth_failed`);
    }
});

// Get Deezer user profile
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const deezerTokens = req.user.getPlatformTokens('deezer');
        if (!deezerTokens) {
            return res.status(403).json({
                error: {
                    message: 'Please connect your Deezer account first',
                    status: 403
                }
            });
        }

        const response = await axios.get(`${DEEZER_API_URL}/user/me`, {
            params: { access_token: deezerTokens.accessToken }
        });

        res.json({
            user: {
                id: response.data.id,
                name: response.data.name,
                email: response.data.email,
                picture: response.data.picture_medium || response.data.picture
            }
        });
    } catch (error) {
        console.error('Deezer profile error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: 'Failed to get Deezer profile',
                status: error.response?.status || 500
            }
        });
    }
});

// Get user's Deezer playlists
router.get('/playlists', authMiddleware, async (req, res) => {
    try {
        const deezerTokens = req.user.getPlatformTokens('deezer');
        if (!deezerTokens) {
            return res.status(403).json({
                error: {
                    message: 'Please connect your Deezer account first',
                    status: 403
                }
            });
        }

        const response = await axios.get(`${DEEZER_API_URL}/user/me/playlists`, {
            params: { access_token: deezerTokens.accessToken }
        });

        res.json({
            playlists: response.data.data.map(playlist => ({
                id: playlist.id,
                name: playlist.title,
                description: playlist.description,
                image: playlist.picture_medium || playlist.picture,
                tracks: playlist.nb_tracks,
                public: playlist.public,
                url: playlist.link
            }))
        });
    } catch (error) {
        console.error('Deezer playlists error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: 'Failed to get playlists',
                status: error.response?.status || 500
            }
        });
    }
});

// Get specific playlist details
router.get('/playlist/:playlistId', authMiddleware, async (req, res) => {
    try {
        const { playlistId } = req.params;
        const deezerTokens = req.user.getPlatformTokens('deezer');

        if (!deezerTokens) {
            return res.status(403).json({
                error: {
                    message: 'Please connect your Deezer account first',
                    status: 403
                }
            });
        }

        const response = await axios.get(`${DEEZER_API_URL}/playlist/${playlistId}`, {
            params: { access_token: deezerTokens.accessToken }
        });

        res.json({
            playlist: {
                id: response.data.id,
                name: response.data.title,
                description: response.data.description,
                image: response.data.picture_medium || response.data.picture,
                tracks: response.data.nb_tracks,
                duration: response.data.duration,
                public: response.data.public,
                url: response.data.link,
                creator: response.data.creator?.name
            }
        });
    } catch (error) {
        console.error('Deezer playlist error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: 'Failed to get playlist',
                status: error.response?.status || 500
            }
        });
    }
});

// Get playlist tracks
router.get('/playlist/:playlistId/tracks', authMiddleware, async (req, res) => {
    try {
        const { playlistId } = req.params;
        const deezerTokens = req.user.getPlatformTokens('deezer');

        if (!deezerTokens) {
            return res.status(403).json({
                error: {
                    message: 'Please connect your Deezer account first',
                    status: 403
                }
            });
        }

        const tracks = [];
        let url = `${DEEZER_API_URL}/playlist/${playlistId}/tracks`;

        // Handle pagination
        while (url) {
            const response = await axios.get(url, {
                params: { access_token: deezerTokens.accessToken, limit: 100 }
            });

            tracks.push(...response.data.data.map(track => ({
                id: track.id,
                name: track.title,
                artist: track.artist?.name,
                album: track.album?.title,
                duration: track.duration * 1000, // Convert to ms
                isrc: track.isrc,
                preview: track.preview
            })));

            url = response.data.next || null;
        }

        res.json({ tracks });
    } catch (error) {
        console.error('Deezer tracks error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: 'Failed to get tracks',
                status: error.response?.status || 500
            }
        });
    }
});

// Create a new playlist
router.post('/playlist', authMiddleware, async (req, res) => {
    try {
        const { name } = req.body;
        const deezerTokens = req.user.getPlatformTokens('deezer');

        if (!deezerTokens) {
            return res.status(403).json({
                error: {
                    message: 'Please connect your Deezer account first',
                    status: 403
                }
            });
        }

        // Get user ID first
        const userResponse = await axios.get(`${DEEZER_API_URL}/user/me`, {
            params: { access_token: deezerTokens.accessToken }
        });

        const userId = userResponse.data.id;

        // Create playlist
        const response = await axios.post(
            `${DEEZER_API_URL}/user/${userId}/playlists`,
            null,
            {
                params: {
                    access_token: deezerTokens.accessToken,
                    title: name || 'Plansfer Playlist'
                }
            }
        );

        res.json({
            playlist: {
                id: response.data.id,
                url: `https://www.deezer.com/playlist/${response.data.id}`
            }
        });
    } catch (error) {
        console.error('Deezer create playlist error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: 'Failed to create playlist',
                status: error.response?.status || 500
            }
        });
    }
});

// Add tracks to playlist
router.post('/playlist/:playlistId/tracks', authMiddleware, async (req, res) => {
    try {
        const { playlistId } = req.params;
        const { trackIds } = req.body;
        const deezerTokens = req.user.getPlatformTokens('deezer');

        if (!deezerTokens) {
            return res.status(403).json({
                error: {
                    message: 'Please connect your Deezer account first',
                    status: 403
                }
            });
        }

        // Deezer accepts comma-separated track IDs
        const response = await axios.post(
            `${DEEZER_API_URL}/playlist/${playlistId}/tracks`,
            null,
            {
                params: {
                    access_token: deezerTokens.accessToken,
                    songs: trackIds.join(',')
                }
            }
        );

        res.json({
            success: true,
            message: 'Tracks added successfully',
            count: trackIds.length
        });
    } catch (error) {
        console.error('Deezer add tracks error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: 'Failed to add tracks',
                status: error.response?.status || 500
            }
        });
    }
});

// Search for tracks (useful for cross-platform matching)
router.get('/search', authMiddleware, async (req, res) => {
    try {
        const { q, limit = 10 } = req.query;
        const deezerTokens = req.user.getPlatformTokens('deezer');

        if (!deezerTokens) {
            return res.status(403).json({
                error: {
                    message: 'Please connect your Deezer account first',
                    status: 403
                }
            });
        }

        const response = await axios.get(`${DEEZER_API_URL}/search/track`, {
            params: {
                access_token: deezerTokens.accessToken,
                q,
                limit
            }
        });

        res.json({
            tracks: response.data.data.map(track => ({
                id: track.id,
                name: track.title,
                artist: track.artist?.name,
                album: track.album?.title,
                duration: track.duration * 1000,
                isrc: track.isrc
            }))
        });
    } catch (error) {
        console.error('Deezer search error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: 'Search failed',
                status: error.response?.status || 500
            }
        });
    }
});

// Check connection status
router.get('/status', authMiddleware, (req, res) => {
    const isConnected = req.user.isPlatformConnected('deezer');
    res.json({
        connected: isConnected,
        platform: 'deezer'
    });
});

// Disconnect Deezer
router.post('/disconnect', authMiddleware, async (req, res) => {
    try {
        await req.user.disconnectPlatform('deezer');
        res.json({
            success: true,
            message: 'Deezer disconnected successfully'
        });
    } catch (error) {
        console.error('Deezer disconnect error:', error);
        res.status(500).json({
            error: {
                message: 'Failed to disconnect Deezer',
                status: 500
            }
        });
    }
});

module.exports = router;
