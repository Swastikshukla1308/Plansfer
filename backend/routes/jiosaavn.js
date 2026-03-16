const express = require('express');
const router = express.Router();

// JioSaavn API Base URL (unofficial, uses internal endpoints)
const JIOSAAVN_API_BASE = 'https://www.jiosaavn.com/api.php';

/**
 * Helper function to make JioSaavn API requests
 */
async function jiosaavnRequest(params) {
    const url = new URL(JIOSAAVN_API_BASE);
    Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
    });

    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8'
        }
    });

    if (!response.ok) {
        throw new Error(`JioSaavn API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Helper to decode HTML entities and clean text
 */
function decodeText(text) {
    if (!text) return '';
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

/**
 * Helper to format song data
 */
function formatSong(song) {
    return {
        id: song.id || song.perma_url?.split('/').pop(),
        title: decodeText(song.song || song.title),
        artist: decodeText(song.primary_artists || song.more_info?.artistMap?.primary_artists?.map(a => a.name).join(', ') || 'Unknown Artist'),
        album: decodeText(song.album || song.more_info?.album),
        duration: parseInt(song.duration) || 0,
        image: song.image?.replace('150x150', '500x500') || song.image,
        url: song.perma_url || song.url,
        year: song.year || song.more_info?.year,
        language: song.language || song.more_info?.language,
        playCount: song.play_count || song.more_info?.play_count,
        hasLyrics: song.has_lyrics === 'true' || song.more_info?.has_lyrics === 'true'
    };
}

/**
 * Helper to format playlist data
 */
function formatPlaylist(playlist) {
    return {
        id: playlist.listid || playlist.id,
        title: decodeText(playlist.listname || playlist.title),
        description: decodeText(playlist.description || playlist.list_desc || ''),
        image: playlist.image?.replace('150x150', '500x500') || playlist.image,
        url: playlist.perma_url,
        songCount: parseInt(playlist.list_count) || playlist.songs?.length || 0,
        followerCount: parseInt(playlist.follower_count) || 0,
        fanCount: parseInt(playlist.fan_count) || 0
    };
}

// ============================================
// ROUTES
// ============================================

/**
 * @route   GET /api/jiosaavn/status
 * @desc    Check JioSaavn API availability
 */
router.get('/status', async (req, res) => {
    try {
        // Quick search to verify API is working
        await jiosaavnRequest({
            __call: 'autocomplete.get',
            _format: 'json',
            _marker: '0',
            cc: 'in',
            includeMetaTags: '1',
            query: 'test'
        });

        res.json({
            connected: true,
            platform: 'jiosaavn',
            message: 'JioSaavn API is available',
            note: 'No authentication required for JioSaavn'
        });
    } catch (error) {
        console.error('JioSaavn status check failed:', error);
        res.json({
            connected: false,
            platform: 'jiosaavn',
            message: 'JioSaavn API is currently unavailable',
            error: error.message
        });
    }
});

/**
 * @route   GET /api/jiosaavn/search
 * @desc    Search for songs, albums, playlists, artists
 * @query   q - Search query
 * @query   type - Type of search (songs, albums, playlists, artists, all)
 * @query   limit - Number of results (default: 20)
 */
router.get('/search', async (req, res) => {
    try {
        const { q, type = 'all', limit = 20 } = req.query;

        if (!q) {
            return res.status(400).json({
                error: { message: 'Search query (q) is required', status: 400 }
            });
        }

        const data = await jiosaavnRequest({
            __call: 'autocomplete.get',
            _format: 'json',
            _marker: '0',
            cc: 'in',
            includeMetaTags: '1',
            query: q
        });

        const results = {
            query: q,
            songs: [],
            albums: [],
            playlists: [],
            artists: []
        };

        // Parse songs
        if (data.songs?.data && (type === 'all' || type === 'songs')) {
            results.songs = data.songs.data.slice(0, limit).map(formatSong);
        }

        // Parse albums
        if (data.albums?.data && (type === 'all' || type === 'albums')) {
            results.albums = data.albums.data.slice(0, limit).map(album => ({
                id: album.id,
                title: decodeText(album.title),
                artist: decodeText(album.music || album.more_info?.music),
                image: album.image?.replace('150x150', '500x500'),
                url: album.perma_url,
                year: album.year || album.more_info?.year,
                language: album.more_info?.language
            }));
        }

        // Parse playlists
        if (data.playlists?.data && (type === 'all' || type === 'playlists')) {
            results.playlists = data.playlists.data.slice(0, limit).map(formatPlaylist);
        }

        // Parse artists
        if (data.artists?.data && (type === 'all' || type === 'artists')) {
            results.artists = data.artists.data.slice(0, limit).map(artist => ({
                id: artist.id,
                name: decodeText(artist.title),
                image: artist.image?.replace('150x150', '500x500'),
                url: artist.perma_url,
                role: artist.role
            }));
        }

        res.json(results);
    } catch (error) {
        console.error('JioSaavn search error:', error);
        res.status(500).json({
            error: { message: 'Failed to search JioSaavn', status: 500 }
        });
    }
});

/**
 * @route   GET /api/jiosaavn/search/songs
 * @desc    Search specifically for songs with pagination
 * @query   q - Search query
 * @query   page - Page number (default: 1)
 * @query   limit - Results per page (default: 20)
 */
router.get('/search/songs', async (req, res) => {
    try {
        const { q, page = 1, limit = 20 } = req.query;

        if (!q) {
            return res.status(400).json({
                error: { message: 'Search query (q) is required', status: 400 }
            });
        }

        const data = await jiosaavnRequest({
            __call: 'search.getResults',
            _format: 'json',
            _marker: '0',
            cc: 'in',
            n: limit,
            p: page,
            q: q
        });

        const songs = (data.results || []).map(formatSong);

        res.json({
            query: q,
            page: parseInt(page),
            limit: parseInt(limit),
            total: data.total || songs.length,
            songs
        });
    } catch (error) {
        console.error('JioSaavn song search error:', error);
        res.status(500).json({
            error: { message: 'Failed to search songs', status: 500 }
        });
    }
});

/**
 * @route   GET /api/jiosaavn/song/:id
 * @desc    Get song details by ID
 */
router.get('/song/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const data = await jiosaavnRequest({
            __call: 'song.getDetails',
            _format: 'json',
            _marker: '0',
            cc: 'in',
            pids: id
        });

        if (!data.songs || data.songs.length === 0) {
            return res.status(404).json({
                error: { message: 'Song not found', status: 404 }
            });
        }

        res.json(formatSong(data.songs[0]));
    } catch (error) {
        console.error('JioSaavn get song error:', error);
        res.status(500).json({
            error: { message: 'Failed to get song details', status: 500 }
        });
    }
});

/**
 * @route   GET /api/jiosaavn/album/:id
 * @desc    Get album details with tracks
 */
router.get('/album/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const data = await jiosaavnRequest({
            __call: 'content.getAlbumDetails',
            _format: 'json',
            _marker: '0',
            cc: 'in',
            albumid: id
        });

        if (!data || data.error) {
            return res.status(404).json({
                error: { message: 'Album not found', status: 404 }
            });
        }

        res.json({
            id: data.id || data.albumid,
            title: decodeText(data.title || data.name),
            artist: decodeText(data.primary_artists),
            image: data.image?.replace('150x150', '500x500'),
            url: data.perma_url,
            year: data.year,
            releaseDate: data.release_date,
            language: data.language,
            songCount: data.list_count || data.songs?.length || 0,
            songs: (data.songs || data.list || []).map(formatSong)
        });
    } catch (error) {
        console.error('JioSaavn get album error:', error);
        res.status(500).json({
            error: { message: 'Failed to get album details', status: 500 }
        });
    }
});

/**
 * @route   GET /api/jiosaavn/playlist/:id
 * @desc    Get playlist details with tracks
 */
router.get('/playlist/:id', async (req, res) => {
    try {
        const { id } = req.params;
        let data;

        // Check if the ID is numeric (direct listid) or a token (from URL)
        const isNumeric = /^\d+$/.test(id);

        if (isNumeric) {
            // Use playlist.getDetails for numeric IDs
            data = await jiosaavnRequest({
                __call: 'playlist.getDetails',
                _format: 'json',
                _marker: '0',
                cc: 'in',
                listid: id
            });
        } else {
            // Use webapi.get with token for URL-based tokens
            data = await jiosaavnRequest({
                __call: 'webapi.get',
                _format: 'json',
                _marker: '0',
                cc: 'in',
                token: id,
                type: 'playlist'
            });
        }

        if (!data || data.error || (!data.listname && !data.title)) {
            return res.status(404).json({
                error: { message: 'Playlist not found', status: 404 }
            });
        }

        res.json({
            id: data.listid || data.id,
            title: decodeText(data.listname || data.title),
            description: decodeText(data.list_desc || data.description || ''),
            image: data.image?.replace('150x150', '500x500'),
            url: data.perma_url,
            owner: decodeText(data.username || data.firstname),
            songCount: parseInt(data.list_count) || data.songs?.length || 0,
            followerCount: parseInt(data.follower_count) || 0,
            fanCount: parseInt(data.fan_count) || 0,
            songs: (data.songs || data.list || []).map(formatSong)
        });
    } catch (error) {
        console.error('JioSaavn get playlist error:', error);
        res.status(500).json({
            error: { message: 'Failed to get playlist details', status: 500 }
        });
    }
});

/**
 * @route   GET /api/jiosaavn/artist/:id
 * @desc    Get artist details with top songs
 */
router.get('/artist/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const data = await jiosaavnRequest({
            __call: 'artist.getArtistPageDetails',
            _format: 'json',
            _marker: '0',
            cc: 'in',
            artistId: id
        });

        if (!data || data.error) {
            return res.status(404).json({
                error: { message: 'Artist not found', status: 404 }
            });
        }

        res.json({
            id: data.artistId || data.id,
            name: decodeText(data.name),
            image: data.image?.replace('150x150', '500x500'),
            url: data.perma_url,
            followerCount: parseInt(data.follower_count) || 0,
            fanCount: parseInt(data.fan_count) || 0,
            isVerified: data.isVerified === 'true',
            bio: data.bio ? data.bio.map(b => decodeText(b.text || b)).join(' ') : '',
            topSongs: (data.topSongs || []).map(formatSong),
            topAlbums: (data.topAlbums || []).map(album => ({
                id: album.id,
                title: decodeText(album.title),
                image: album.image?.replace('150x150', '500x500'),
                url: album.perma_url,
                year: album.year
            }))
        });
    } catch (error) {
        console.error('JioSaavn get artist error:', error);
        res.status(500).json({
            error: { message: 'Failed to get artist details', status: 500 }
        });
    }
});

/**
 * @route   GET /api/jiosaavn/lyrics/:id
 * @desc    Get lyrics for a song
 */
router.get('/lyrics/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const data = await jiosaavnRequest({
            __call: 'lyrics.getLyrics',
            _format: 'json',
            _marker: '0',
            cc: 'in',
            lyrics_id: id
        });

        if (!data || data.error || !data.lyrics) {
            return res.status(404).json({
                error: { message: 'Lyrics not found', status: 404 }
            });
        }

        res.json({
            id: id,
            lyrics: data.lyrics,
            snippet: data.lyrics_snippet,
            copyright: data.lyrics_copyright
        });
    } catch (error) {
        console.error('JioSaavn get lyrics error:', error);
        res.status(500).json({
            error: { message: 'Failed to get lyrics', status: 500 }
        });
    }
});

/**
 * @route   GET /api/jiosaavn/trending
 * @desc    Get trending/top charts
 */
router.get('/trending', async (req, res) => {
    try {
        const data = await jiosaavnRequest({
            __call: 'content.getHomepageData',
            _format: 'json',
            _marker: '0',
            cc: 'in'
        });

        const trending = {
            charts: [],
            newReleases: [],
            topPlaylists: []
        };

        // Parse modules for trending content
        if (data.modules) {
            Object.values(data.modules).forEach(module => {
                if (module.title?.toLowerCase().includes('chart') && module.data) {
                    trending.charts = module.data.map(item => ({
                        id: item.id,
                        title: decodeText(item.title),
                        image: item.image?.replace('150x150', '500x500'),
                        url: item.perma_url,
                        type: item.type
                    }));
                }
                if (module.title?.toLowerCase().includes('new') && module.data) {
                    trending.newReleases = module.data.map(item => ({
                        id: item.id,
                        title: decodeText(item.title),
                        artist: decodeText(item.subtitle || item.music),
                        image: item.image?.replace('150x150', '500x500'),
                        url: item.perma_url,
                        type: item.type
                    }));
                }
                if (module.title?.toLowerCase().includes('playlist') && module.data) {
                    trending.topPlaylists = module.data.map(formatPlaylist);
                }
            });
        }

        res.json(trending);
    } catch (error) {
        console.error('JioSaavn get trending error:', error);
        res.status(500).json({
            error: { message: 'Failed to get trending content', status: 500 }
        });
    }
});

module.exports = router;
