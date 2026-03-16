const express = require('express');
const router = express.Router();
const axios = require('axios');
const authMiddleware = require('../middleware/auth');

/**
 * Gaana Routes
 * 
 * Gaana has a semi-public API that can be accessed without OAuth for reading public playlists.
 * Similar to JioSaavn, we can scrape/use their internal API endpoints.
 */


const GAANA_API_BASE = 'https://gaana.com/apiv2';

// Check connection status - Gaana doesn't require OAuth for public playlists
router.get('/status', (req, res) => {
    res.json({
        connected: true,
        platform: 'gaana',
        message: 'Gaana public API - no authentication required'
    });
});

// Get playlist by ID/slug
router.get('/playlist/:playlistId', async (req, res) => {
    try {
        const { playlistId } = req.params;

        // Try to fetch from Gaana's internal API
        const response = await axios.get(`${GAANA_API_BASE}/playlist/${playlistId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });

        if (!response.data || response.data.status !== 1) {
            // Try alternative endpoint format
            const altResponse = await axios.get(`https://gaana.com/playlist/${playlistId}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            // Parse HTML for basic info if API fails
            const htmlMatch = altResponse.data.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
            if (htmlMatch) {
                const jsonData = JSON.parse(htmlMatch[1]);
                return res.json({
                    id: playlistId,
                    title: jsonData.name || 'Gaana Playlist',
                    description: jsonData.description || '',
                    image: jsonData.image || '',
                    songCount: jsonData.numTracks || 0,
                    platform: 'gaana'
                });
            }

            throw new Error('Playlist not found');
        }

        const playlist = response.data.playlist || response.data;

        res.json({
            id: playlist.seokey || playlistId,
            title: playlist.title || playlist.name,
            description: playlist.description || '',
            image: playlist.artwork || playlist.atw || '',
            songCount: playlist.count || playlist.tracks?.length || 0,
            songs: playlist.tracks?.map(track => ({
                id: track.seokey || track.track_id,
                title: track.title || track.track_title,
                artist: track.artist || track.artist_detail?.map(a => a.name).join(', ') || 'Unknown',
                album: track.album || track.albumseokey,
                duration: track.duration,
                image: track.artwork || track.atw
            })) || [],
            platform: 'gaana'
        });
    } catch (error) {
        console.error('Gaana playlist fetch error:', error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: 'Failed to fetch Gaana playlist',
                status: error.response?.status || 500,
                details: error.message
            }
        });
    }
});

// Search Gaana
router.get('/search', async (req, res) => {
    try {
        const { q, type = 'all' } = req.query;

        if (!q) {
            return res.status(400).json({
                error: {
                    message: 'Search query is required',
                    status: 400
                }
            });
        }

        const response = await axios.get(`${GAANA_API_BASE}/search`, {
            params: {
                keyword: q,
                type: type
            },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });

        res.json({
            query: q,
            results: response.data
        });
    } catch (error) {
        console.error('Gaana search error:', error.message);
        res.status(500).json({
            error: {
                message: 'Failed to search Gaana',
                status: 500
            }
        });
    }
});

// Get trending playlists
router.get('/trending', async (req, res) => {
    try {
        const response = await axios.get(`${GAANA_API_BASE}/featured-content`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });

        res.json({
            trending: response.data
        });
    } catch (error) {
        console.error('Gaana trending error:', error.message);
        res.status(500).json({
            error: {
                message: 'Failed to fetch trending content',
                status: 500
            }
        });
    }
});

module.exports = router;
