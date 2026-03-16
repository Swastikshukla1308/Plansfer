const express = require('express');
const router = express.Router();
const axios = require('axios');
const authMiddleware = require('../middleware/auth');
const optionalAuthMiddleware = require('../middleware/optionalAuth');

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_URL = 'https://api.spotify.com/v1';
const DEFAULT_FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5001';
const SPOTIFY_REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SPOTIFY_ACCESS_TOKEN_COOKIE = 'spotify_access_token';
const SPOTIFY_REFRESH_TOKEN_COOKIE = 'spotify_refresh_token';
const SPOTIFY_EXPIRES_AT_COOKIE = 'spotify_access_expires_at';
const SPOTIFY_CONNECTED_AT_COOKIE = 'spotify_connected_at';
const SPOTIFY_SCOPES_COOKIE = 'spotify_scopes';

function getSpotifyPlaylistEntryTrack(entry) {
    const track = entry?.item || entry?.track || null;
    if (!track) return null;
    if (track.type && track.type !== 'track') return null;
    return track;
}

function parseSpotifyScopes(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return [...new Set(value.map(scope => String(scope || '').trim()).filter(Boolean))];
    }
    return [...new Set(
        String(value)
            .split(/\s+/)
            .map(scope => scope.trim())
            .filter(Boolean)
    )];
}

function normalizeTimestamp(value) {
    if (!value) return null;
    const timestamp = value instanceof Date
        ? value.getTime()
        : typeof value === 'number'
            ? value
            : new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeIsoDate(value, fallback = null) {
    const timestamp = normalizeTimestamp(value);
    if (timestamp === null) return fallback;
    return new Date(timestamp).toISOString();
}

function getSpotifyCookieOptions(maxAge) {
    return {
        httpOnly: true,
        sameSite: 'lax',
        maxAge
    };
}

function writeSpotifyCookies(res, tokenInfo) {
    if (!res || typeof res.cookie !== 'function' || !tokenInfo?.accessToken) {
        return;
    }

    const expiresAtMs = normalizeTimestamp(tokenInfo.expiresAt);
    const accessMaxAge = expiresAtMs
        ? Math.max(1000, expiresAtMs - Date.now())
        : 60 * 60 * 1000;
    const connectedAt = normalizeIsoDate(tokenInfo.connectedAt, new Date().toISOString());
    const scopes = parseSpotifyScopes(tokenInfo.scopes).join(' ');

    res.cookie(
        SPOTIFY_ACCESS_TOKEN_COOKIE,
        tokenInfo.accessToken,
        getSpotifyCookieOptions(accessMaxAge)
    );

    if (tokenInfo.refreshToken) {
        res.cookie(
            SPOTIFY_REFRESH_TOKEN_COOKIE,
            tokenInfo.refreshToken,
            getSpotifyCookieOptions(SPOTIFY_REFRESH_COOKIE_MAX_AGE_MS)
        );
    }

    if (expiresAtMs) {
        res.cookie(
            SPOTIFY_EXPIRES_AT_COOKIE,
            String(expiresAtMs),
            getSpotifyCookieOptions(SPOTIFY_REFRESH_COOKIE_MAX_AGE_MS)
        );
    }

    if (connectedAt) {
        res.cookie(
            SPOTIFY_CONNECTED_AT_COOKIE,
            connectedAt,
            getSpotifyCookieOptions(SPOTIFY_REFRESH_COOKIE_MAX_AGE_MS)
        );
    }

    res.cookie(
        SPOTIFY_SCOPES_COOKIE,
        scopes,
        getSpotifyCookieOptions(SPOTIFY_REFRESH_COOKIE_MAX_AGE_MS)
    );
}

function clearSpotifyCookies(res) {
    if (!res || typeof res.clearCookie !== 'function') return;

    const cookieOptions = {
        httpOnly: true,
        sameSite: 'lax'
    };

    res.clearCookie(SPOTIFY_ACCESS_TOKEN_COOKIE, cookieOptions);
    res.clearCookie(SPOTIFY_REFRESH_TOKEN_COOKIE, cookieOptions);
    res.clearCookie(SPOTIFY_EXPIRES_AT_COOKIE, cookieOptions);
    res.clearCookie(SPOTIFY_CONNECTED_AT_COOKIE, cookieOptions);
    res.clearCookie(SPOTIFY_SCOPES_COOKIE, cookieOptions);
}

function syncSpotifyCookies(req, tokenInfo) {
    if (!req?.cookies || !tokenInfo?.accessToken) return;

    const expiresAtMs = normalizeTimestamp(tokenInfo.expiresAt);
    req.cookies[SPOTIFY_ACCESS_TOKEN_COOKIE] = tokenInfo.accessToken;
    if (tokenInfo.refreshToken) {
        req.cookies[SPOTIFY_REFRESH_TOKEN_COOKIE] = tokenInfo.refreshToken;
    }
    if (expiresAtMs) {
        req.cookies[SPOTIFY_EXPIRES_AT_COOKIE] = String(expiresAtMs);
    }
    if (tokenInfo.connectedAt) {
        req.cookies[SPOTIFY_CONNECTED_AT_COOKIE] =
            normalizeIsoDate(tokenInfo.connectedAt, new Date().toISOString());
    }
    req.cookies[SPOTIFY_SCOPES_COOKIE] = parseSpotifyScopes(tokenInfo.scopes).join(' ');
}

function clearSpotifyCookieState(req, res) {
    clearSpotifyCookies(res);
    if (!req?.cookies) return;
    delete req.cookies[SPOTIFY_ACCESS_TOKEN_COOKIE];
    delete req.cookies[SPOTIFY_REFRESH_TOKEN_COOKIE];
    delete req.cookies[SPOTIFY_EXPIRES_AT_COOKIE];
    delete req.cookies[SPOTIFY_CONNECTED_AT_COOKIE];
    delete req.cookies[SPOTIFY_SCOPES_COOKIE];
}

function getCookieSpotifySource(req) {
    if (!req?.cookies) return null;

    const accessToken = req.cookies[SPOTIFY_ACCESS_TOKEN_COOKIE] || null;
    const refreshToken = req.cookies[SPOTIFY_REFRESH_TOKEN_COOKIE] || null;
    if (!accessToken && !refreshToken) return null;

    return {
        source: 'cookie',
        accessToken,
        refreshToken,
        expiresAt: normalizeIsoDate(req.cookies[SPOTIFY_EXPIRES_AT_COOKIE]),
        connectedAt: normalizeIsoDate(req.cookies[SPOTIFY_CONNECTED_AT_COOKIE]),
        scopes: parseSpotifyScopes(req.cookies[SPOTIFY_SCOPES_COOKIE]),
        refreshed: false
    };
}

function getUserSpotifySource(user) {
    if (!user) return null;
    const spotifyData = user.getPlatformTokens('spotify');
    if (!spotifyData?.accessToken && !spotifyData?.refreshToken) return null;

    return {
        source: 'user',
        accessToken: spotifyData.accessToken || null,
        refreshToken: spotifyData.refreshToken || null,
        expiresAt: normalizeIsoDate(spotifyData.expiresAt),
        connectedAt: normalizeIsoDate(spotifyData.connectedAt),
        scopes: parseSpotifyScopes(spotifyData.scopes),
        refreshed: false
    };
}

function isSpotifyAccessTokenExpired(source) {
    const expiresAtMs = normalizeTimestamp(source?.expiresAt);
    if (!expiresAtMs) return false;
    return Date.now() >= expiresAtMs - 60000;
}

function compareSpotifySources(left, right) {
    const rightConnectedAt = normalizeTimestamp(right?.connectedAt) || 0;
    const leftConnectedAt = normalizeTimestamp(left?.connectedAt) || 0;
    if (rightConnectedAt !== leftConnectedAt) {
        return rightConnectedAt - leftConnectedAt;
    }

    const rightHasAccess = right?.accessToken ? 1 : 0;
    const leftHasAccess = left?.accessToken ? 1 : 0;
    if (rightHasAccess !== leftHasAccess) {
        return rightHasAccess - leftHasAccess;
    }

    const rightExpiresAt = normalizeTimestamp(right?.expiresAt) || 0;
    const leftExpiresAt = normalizeTimestamp(left?.expiresAt) || 0;
    if (rightExpiresAt !== leftExpiresAt) {
        return rightExpiresAt - leftExpiresAt;
    }

    if (left?.source === right?.source) {
        return 0;
    }

    return left?.source === 'cookie' ? -1 : 1;
}

function rankSpotifySources(sources) {
    return (sources || [])
        .filter(Boolean)
        .sort(compareSpotifySources);
}

function chooseSpotifySource(sources, options = {}) {
    const rankedSources = rankSpotifySources(sources);
    if (rankedSources.length === 0) return null;

    if (options.forceRefresh) {
        return rankedSources.find(source => source.refreshToken) || null;
    }

    return (
        rankedSources.find(source => source.accessToken && !isSpotifyAccessTokenExpired(source)) ||
        rankedSources.find(source => source.accessToken) ||
        rankedSources.find(source => source.refreshToken) ||
        null
    );
}

async function persistSpotifyTokenInfo(user, req, res, tokenInfo) {
    if (user) {
        await user.connectPlatform('spotify', {
            accessToken: tokenInfo.accessToken,
            refreshToken: tokenInfo.refreshToken,
            expiresAt: tokenInfo.expiresAt,
            connectedAt: tokenInfo.connectedAt,
            scopes: parseSpotifyScopes(tokenInfo.scopes)
        });
    }

    writeSpotifyCookies(res, tokenInfo);
    syncSpotifyCookies(req, tokenInfo);
}

function normalizeFrontendOrigin(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return parsed.origin;
    } catch {
        return null;
    }
}

function resolveFrontendOrigin(req, preferred) {
    const configuredOrigin =
        normalizeFrontendOrigin(DEFAULT_FRONTEND_URL) || 'http://localhost:5001';
    const requestOrigin = normalizeFrontendOrigin(req?.get?.('origin'));
    const preferredOrigin = normalizeFrontendOrigin(preferred);

    const allowedOrigins = new Set(
        [
            configuredOrigin,
            requestOrigin,
            'http://localhost:5000',
            'http://localhost:5001',
            'http://127.0.0.1:5000',
            'http://127.0.0.1:5001'
        ].filter(Boolean)
    );

    if (preferredOrigin && allowedOrigins.has(preferredOrigin)) {
        return preferredOrigin;
    }

    if (requestOrigin && allowedOrigins.has(requestOrigin)) {
        return requestOrigin;
    }

    return configuredOrigin;
}

function encodeSpotifyState(payload) {
    return `v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function decodeSpotifyState(rawState) {
    if (!rawState || typeof rawState !== 'string') {
        return { userId: 'guest', frontendOrigin: null };
    }

    if (!rawState.startsWith('v1.')) {
        // Backward compatibility with legacy plain-state userId format.
        return { userId: rawState, frontendOrigin: null };
    }

    try {
        const encoded = rawState.slice(3);
        const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        return {
            userId: decoded?.userId || 'guest',
            frontendOrigin: decoded?.frontendOrigin || null
        };
    } catch {
        return { userId: 'guest', frontendOrigin: null };
    }
}

// Initiate Spotify OAuth flow (optional auth — allows connecting without app login)
router.get('/auth', optionalAuthMiddleware, (req, res) => {
    const scopes = [
        'playlist-read-private',
        'playlist-read-collaborative',
        'playlist-modify-public',
        'playlist-modify-private',
        'user-library-read',
        'user-read-private'
    ].join(' ');

    const frontendOrigin = resolveFrontendOrigin(req, req.query?.frontend_origin);
    const statePayload = {
        userId: (req.userId || 'guest').toString(),
        frontendOrigin
    };

    const params = new URLSearchParams({
        client_id: process.env.SPOTIFY_CLIENT_ID,
        response_type: 'code',
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
        scope: scopes,
        state: encodeSpotifyState(statePayload),
        show_dialog: true
    });

    res.json({
        authUrl: `${SPOTIFY_AUTH_URL}?${params.toString()}`
    });
});

// Spotify OAuth callback
router.get('/callback', async (req, res) => {
    const { code, state: rawState, error: spotifyError } = req.query;
    const parsedState = decodeSpotifyState(rawState);
    const userId = parsedState.userId || 'guest';
    const frontendOrigin = resolveFrontendOrigin(req, parsedState.frontendOrigin);

    if (spotifyError || !code) {
        console.error('Spotify auth rejected:', spotifyError || 'no code');
        return res.redirect(`${frontendOrigin}?error=spotify_auth_failed`);
    }

    try {
        // Exchange code for tokens
        const tokenResponse = await axios.post(
            SPOTIFY_TOKEN_URL,
            new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.SPOTIFY_REDIRECT_URI
            }),
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(
                        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
                    ).toString('base64')}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const { access_token, refresh_token, expires_in, scope } = tokenResponse.data;
        const grantedScopes = parseSpotifyScopes(scope);
        const connectedAt = new Date().toISOString();
        const callbackTokenInfo = {
            accessToken: access_token,
            refreshToken: refresh_token,
            expiresAt: new Date(Date.now() + expires_in * 1000).toISOString(),
            connectedAt,
            scopes: grantedScopes,
            source: userId && userId !== 'guest' ? 'user' : 'cookie',
            refreshed: false
        };

        console.info('[Spotify] OAuth callback completed', {
            userId,
            grantedScopes,
            frontendOrigin
        });

        // Try to save tokens to user if they are logged in
        if (userId && userId !== 'guest') {
            try {
                const UserModel = require('../models/User');
                const user = await UserModel.findById(userId);
                if (user) {
                    await persistSpotifyTokenInfo(user, req, res, {
                        ...callbackTokenInfo,
                        source: 'user'
                    });
                } else {
                    writeSpotifyCookies(res, callbackTokenInfo);
                    syncSpotifyCookies(req, callbackTokenInfo);
                }
            } catch (userError) {
                console.error('Failed to save Spotify tokens to user:', userError.message);
                writeSpotifyCookies(res, callbackTokenInfo);
                syncSpotifyCookies(req, callbackTokenInfo);
            }
        } else {
            writeSpotifyCookies(res, callbackTokenInfo);
            syncSpotifyCookies(req, callbackTokenInfo);
        }

        res.redirect(`${frontendOrigin}?spotify_connected=true`);
    } catch (error) {
        console.error('Spotify callback error:', error.response?.data || error.message);
        res.redirect(`${frontendOrigin}?error=spotify_auth_failed`);
    }
});

// Refresh Spotify access token
async function refreshSpotifyToken(refreshToken) {
    try {
        const response = await axios.post(
            SPOTIFY_TOKEN_URL,
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            }),
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(
                        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
                    ).toString('base64')}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        return response.data;
    } catch (error) {
        console.error('Token refresh error:', error.response?.data || error.message);
        throw error;
    }
}

// Get Spotify access token metadata (with deterministic source selection + auto-refresh)
async function getSpotifyAccessToken(user, req, resOrOptions = {}, maybeOptions = {}) {
    const res = resOrOptions && typeof resOrOptions.cookie === 'function'
        ? resOrOptions
        : null;
    const options = res ? maybeOptions : resOrOptions;
    const forceRefresh = !!options?.forceRefresh;
    const spotifySources = rankSpotifySources([
        getCookieSpotifySource(req),
        getUserSpotifySource(user)
    ]);
    const selectedSource = chooseSpotifySource(spotifySources, { forceRefresh });

    if (!selectedSource) {
        throw new Error('Spotify not connected. Please connect your Spotify account first.');
    }

    console.info('[Spotify] Selected token source', {
        forceRefresh,
        source: selectedSource.source,
        connectedAt: selectedSource.connectedAt || 'unknown',
        hasAccessToken: !!selectedSource.accessToken,
        hasRefreshToken: !!selectedSource.refreshToken,
        scopes: selectedSource.scopes
    });

    const baseTokenInfo = {
        accessToken: selectedSource.accessToken,
        refreshToken: selectedSource.refreshToken,
        expiresAt: selectedSource.expiresAt,
        connectedAt: selectedSource.connectedAt,
        scopes: selectedSource.scopes,
        source: selectedSource.source,
        refreshed: false
    };

    const needsRefresh =
        forceRefresh ||
        !selectedSource.accessToken ||
        isSpotifyAccessTokenExpired(selectedSource);

    if (!needsRefresh) {
        return baseTokenInfo;
    }

    if (!selectedSource.refreshToken) {
        if (selectedSource.accessToken && !forceRefresh) {
            return baseTokenInfo;
        }
        throw new Error('Spotify refresh token not found. Please reconnect your Spotify account.');
    }

    console.info('[Spotify] Refreshing token', {
        source: selectedSource.source,
        connectedAt: selectedSource.connectedAt || 'unknown'
    });

    const tokenData = await refreshSpotifyToken(selectedSource.refreshToken);
    const refreshedTokenInfo = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || selectedSource.refreshToken,
        expiresAt: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
        connectedAt: selectedSource.connectedAt || new Date().toISOString(),
        scopes: parseSpotifyScopes(tokenData.scope || selectedSource.scopes),
        source: selectedSource.source,
        refreshed: true
    };

    await persistSpotifyTokenInfo(user, req, res, refreshedTokenInfo);
    return refreshedTokenInfo;
}

// Get playlist details
router.get('/playlist/:playlistId', optionalAuthMiddleware, async (req, res) => {
    try {
        const { playlistId } = req.params;
        const spotifyAuth = await getSpotifyAccessToken(req.user, req, res);
        const accessToken = spotifyAuth.accessToken;

        const response = await axios.get(
            `${SPOTIFY_API_URL}/playlists/${playlistId}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        res.json({
            playlist: {
                id: response.data.id,
                name: response.data.name,
                description: response.data.description,
                image: response.data.images[0]?.url,
                tracks: response.data.items?.total ?? response.data.tracks?.total ?? 0,
                owner: response.data.owner.display_name,
                public: response.data.public
            }
        });
    } catch (error) {
        console.error('Get playlist error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: error.response?.data?.error?.message || 'Failed to fetch playlist',
                status: error.response?.status || 500
            }
        });
    }
});

// Get playlist tracks
router.get('/playlist/:playlistId/tracks', optionalAuthMiddleware, async (req, res) => {
    try {
        const { playlistId } = req.params;
        const spotifyAuth = await getSpotifyAccessToken(req.user, req, res);
        const accessToken = spotifyAuth.accessToken;

        const tracks = [];
        let offset = 0;
        const limit = 100;
        let hasMore = true;

        while (hasMore) {
            const response = await axios.get(
                `${SPOTIFY_API_URL}/playlists/${playlistId}/items`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    },
                    params: { offset, limit }
                }
            );

            const items = response.data.items
                .map(item => getSpotifyPlaylistEntryTrack(item))
                .filter(Boolean)
                .map(track => ({
                    name: track.name,
                    artist: track.artists.map(a => a.name).join(', '),
                    album: track.album?.name || '',
                    duration: track.duration_ms,
                    isrc: track.external_ids?.isrc,
                    spotifyUri: track.uri
                }));

            tracks.push(...items);

            hasMore = response.data.next !== null;
            offset += limit;
        }

        res.json({ tracks });
    } catch (error) {
        console.error('Get tracks error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: error.response?.data?.error?.message || 'Failed to fetch tracks',
                status: error.response?.status || 500
            }
        });
    }
});

// Create playlist
router.post('/playlist', optionalAuthMiddleware, async (req, res) => {
    try {
        const { name, description, isPublic = false } = req.body;
        const spotifyAuth = await getSpotifyAccessToken(req.user, req, res);
        const accessToken = spotifyAuth.accessToken;

        // Create playlist
        const response = await axios.post(
            `${SPOTIFY_API_URL}/me/playlists`,
            {
                name,
                description: description || 'Created with MusiKtransfer',
                public: isPublic
            },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            playlist: {
                id: response.data.id,
                name: response.data.name,
                url: response.data.external_urls.spotify
            }
        });
    } catch (error) {
        console.error('Create playlist error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: error.response?.data?.error?.message || 'Failed to create playlist',
                status: error.response?.status || 500
            }
        });
    }
});

// Add tracks to playlist
router.post('/playlist/:playlistId/tracks', optionalAuthMiddleware, async (req, res) => {
    try {
        const { playlistId } = req.params;
        const { trackUris } = req.body;
        const spotifyAuth = await getSpotifyAccessToken(req.user, req, res);
        const accessToken = spotifyAuth.accessToken;

        if (!Array.isArray(trackUris) || trackUris.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'trackUris must be a non-empty array',
                    status: 400
                }
            });
        }

        const seen = new Set();
        const uniqueTrackUris = [];
        let skippedDuplicates = 0;
        for (const uri of trackUris) {
            if (typeof uri !== 'string' || !uri.trim()) continue;
            const key = uri.trim();
            if (seen.has(key)) {
                skippedDuplicates++;
                continue;
            }
            seen.add(key);
            uniqueTrackUris.push(key);
        }

        // Spotify allows max 100 tracks per request
        const batchSize = 100;
        const batches = [];

        for (let i = 0; i < uniqueTrackUris.length; i += batchSize) {
            batches.push(uniqueTrackUris.slice(i, i + batchSize));
        }

        for (const batch of batches) {
            await axios.post(
                `${SPOTIFY_API_URL}/playlists/${playlistId}/items`,
                { uris: batch },
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
        }

        res.json({
            message: 'Tracks added successfully',
            count: uniqueTrackUris.length,
            skippedDuplicates
        });
    } catch (error) {
        console.error('Add tracks error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: error.response?.data?.error?.message || 'Failed to add tracks',
                status: error.response?.status || 500
            }
        });
    }
});

// Check connection status
router.get('/status', authMiddleware, (req, res) => {
    const isConnected = req.user.isPlatformConnected('spotify');
    res.json({
        connected: isConnected,
        platform: 'spotify'
    });
});

router.post('/disconnect', authMiddleware, async (req, res) => {
    try {
        await req.user.disconnectPlatform('spotify');
        clearSpotifyCookieState(req, res);
        res.json({
            message: 'Spotify disconnected successfully'
        });
    } catch (error) {
        console.error('Spotify disconnect error:', error);
        res.status(500).json({
            error: {
                message: 'Failed to disconnect Spotify',
                status: 500
            }
        });
    }
});

module.exports = router;
module.exports.getSpotifyAccessToken = getSpotifyAccessToken;
