const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const authMiddleware = require('../middleware/auth');
const axios = require('axios');

/**
 * AI Playlist Generator using Gemini 3.1 Preview + Spotify Recommendations
 */

// Initialize Gemini
let genAI = null;
const getGeminiClient = () => {
    if (!genAI && process.env.GEMINI_API_KEY) {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }
    return genAI;
};

// Spotify seed genres (official list)
const SPOTIFY_GENRES = [
    'acoustic', 'afrobeat', 'alt-rock', 'alternative', 'ambient', 'anime', 'black-metal',
    'bluegrass', 'blues', 'bossanova', 'brazil', 'breakbeat', 'british', 'cantopop',
    'chicago-house', 'children', 'chill', 'classical', 'club', 'comedy', 'country',
    'dance', 'dancehall', 'death-metal', 'deep-house', 'detroit-techno', 'disco',
    'disney', 'drum-and-bass', 'dub', 'dubstep', 'edm', 'electro', 'electronic',
    'emo', 'folk', 'forro', 'french', 'funk', 'garage', 'german', 'gospel', 'goth',
    'grindcore', 'groove', 'grunge', 'guitar', 'happy', 'hard-rock', 'hardcore',
    'hardstyle', 'heavy-metal', 'hip-hop', 'holidays', 'honky-tonk', 'house', 'idm',
    'indian', 'indie', 'indie-pop', 'industrial', 'iranian', 'j-dance', 'j-idol',
    'j-pop', 'j-rock', 'jazz', 'k-pop', 'kids', 'latin', 'latino', 'malay',
    'mandopop', 'metal', 'metal-misc', 'metalcore', 'minimal-techno', 'movies', 'mpb',
    'new-age', 'new-release', 'opera', 'pagode', 'party', 'philippines-opm', 'piano',
    'pop', 'pop-film', 'post-dubstep', 'power-pop', 'progressive-house', 'psych-rock',
    'punk', 'punk-rock', 'r-n-b', 'rainy-day', 'reggae', 'reggaeton', 'road-trip',
    'rock', 'rock-n-roll', 'rockabilly', 'romance', 'sad', 'salsa', 'samba',
    'sertanejo', 'show-tunes', 'singer-songwriter', 'ska', 'sleep', 'songwriter',
    'soul', 'soundtracks', 'spanish', 'study', 'summer', 'swedish', 'synth-pop',
    'tango', 'techno', 'trance', 'trip-hop', 'turkish', 'work-out', 'world-music'
];

// Parse user prompt with AI to extract specific songs
async function parsePromptWithAI(prompt) {
    const gemini = getGeminiClient();

    if (!gemini) {
        console.warn('No AI provider configured. Falling back to demo mode.');
        return null; // Fallback
    }

    const systemPrompt = `You are an expert music curator. The user wants a playlist based on this prompt: "${prompt}".
Generate a list of exactly 12 real, existing playable songs that perfectly match this prompt.

Return ONLY a valid JSON object (no markdown, no backticks) with this exact format:
{
    "playlistName": "A catchy name for the playlist",
    "description": "A short, fitting description",
    "genres": ["genre1", "genre2"],
    "mood": "happy|sad|energetic|calm|romantic|angry|focused",
    "tracks": [
        { "name": "Song Title", "artist": "Artist Name", "album": "Album Name (if known)" }
    ]
}`;

    try {
        let text = null;
        
        console.log("SENDING REQUEST TO GEMINI 2.5 FLASH...");
        try {
            // The user's account specifically has access to the newer Gemini 2.x endpoints
            const model = gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const result = await model.generateContent(systemPrompt);
            const response = await result.response;
            text = response.text().trim();
            console.log("SUCCESSFULLY RECEIVED RESPONSE FROM GEMINI 2.5 FLASH");
        } catch (ge) {
            console.warn('Gemini 2.5 Flash failed.', ge.message);
            
            try {
                const model = gemini.getGenerativeModel({ model: 'gemini-2.0-flash' });
                const result = await model.generateContent(systemPrompt);
                const response = await result.response;
                text = response.text().trim();
            } catch (gef) {
                 console.error('All Gemini AI generators exhausted.', gef.message);
            }
        }
        
        if (!text) {
             console.log("ERROR: Received empty text from Gemini engine");
             return null;
        }

        console.log("--- RAW AI RESPONSE BELOW ---");
        console.log(text);
        console.log("-----------------------------");

        // Try to parse JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.tracks && Array.isArray(parsed.tracks)) {
                console.log("Successfully parsed JSON payload with", parsed.tracks.length, "tracks.");
                return parsed;
            } else {
                console.log("JSON parsed successfully but tracks array is missing or invalid.");
            }
        } else {
             console.log("REGEX MATCH FAILED: No JSON object found in response string.");
        }
    } catch (error) {
        console.error('AI parsing completely failed:', error);
    }

    return null;
}

// Fallback keyword-based parsing
function parsePromptFallback(prompt) {
    const lowerPrompt = prompt.toLowerCase();

    const moodMap = {
        'happy': { valence: 0.8, energy: 0.7, genres: ['pop', 'happy', 'dance'] },
        'sad': { valence: 0.2, energy: 0.3, genres: ['sad', 'acoustic', 'piano'] },
        'energetic': { valence: 0.7, energy: 0.9, genres: ['dance', 'edm', 'work-out'] },
        'calm': { valence: 0.5, energy: 0.2, genres: ['ambient', 'chill', 'sleep'] },
        'focus': { valence: 0.5, energy: 0.4, genres: ['study', 'ambient', 'piano'] },
        'workout': { valence: 0.7, energy: 0.95, genres: ['work-out', 'hip-hop', 'edm'] },
        'party': { valence: 0.9, energy: 0.9, genres: ['party', 'dance', 'club'] },
        'romantic': { valence: 0.6, energy: 0.4, genres: ['romance', 'r-n-b', 'soul'] },
        'chill': { valence: 0.5, energy: 0.3, genres: ['chill', 'ambient', 'indie'] },
        'rock': { valence: 0.6, energy: 0.8, genres: ['rock', 'hard-rock', 'alternative'] },
        'jazz': { valence: 0.5, energy: 0.4, genres: ['jazz', 'blues', 'bossanova'] },
        'hip hop': { valence: 0.6, energy: 0.7, genres: ['hip-hop', 'r-n-b', 'rap'] },
        'classical': { valence: 0.5, energy: 0.3, genres: ['classical', 'piano', 'opera'] },
        'lofi': { valence: 0.5, energy: 0.3, genres: ['chill', 'ambient', 'study'] }
    };

    // Find matching mood
    let result = { valence: 0.5, energy: 0.5, genres: ['pop'], mood: 'neutral' };

    for (const [keyword, values] of Object.entries(moodMap)) {
        if (lowerPrompt.includes(keyword)) {
            result = { ...values, mood: keyword };
            break;
        }
    }

    return {
        genres: result.genres,
        mood: result.mood,
        energy: result.energy,
        valence: result.valence,
        danceability: result.energy > 0.6 ? 0.7 : 0.4,
        playlistName: `${result.mood.charAt(0).toUpperCase() + result.mood.slice(1)} Vibes`
    };
}

// Get Spotify recommendations
async function getSpotifyRecommendations(params, accessToken) {
    try {
        const queryParams = new URLSearchParams({
            seed_genres: params.genres.join(','),
            target_energy: params.energy || 0.5,
            target_valence: params.valence || 0.5,
            target_danceability: params.danceability || 0.5,
            limit: 15
        });

        if (params.tempo) {
            queryParams.append('target_tempo', params.tempo);
        }

        const response = await axios.get(
            `https://api.spotify.com/v1/recommendations?${queryParams.toString()}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        return response.data.tracks.map(track => ({
            id: track.id,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            album: track.album.name,
            albumArt: track.album.images[0]?.url,
            duration: track.duration_ms,
            uri: track.uri,
            previewUrl: track.preview_url,
            externalUrl: track.external_urls.spotify
        }));
    } catch (error) {
        console.error('Spotify recommendations error:', error.response?.data || error.message);
        throw error;
    }
}

// Generate AI playlist (Returns real YouTube tracks)
router.post('/generate', authMiddleware, async (req, res) => {
    try {
        const { prompt } = req.body;

        if (!prompt || prompt.trim().length < 3) {
            return res.status(400).json({
                error: { message: 'Please provide a description for your playlist', status: 400 }
            });
        }

        // Check if Spotify is connected
        const spotifyTokens = req.user.getPlatformTokens('spotify');
        const hasSpotify = spotifyTokens && spotifyTokens.accessToken;

        let tracks = [];
        let aiResult = await parsePromptWithAI(prompt);
        let playlistName = aiResult?.playlistName || 'AI Generated Playlist';
        let playlistDescription = aiResult?.description || `Generated for: "${prompt}"`;
        let playlistMood = aiResult?.mood || 'chill';
        let playlistGenres = aiResult?.genres || ['pop'];

        if (aiResult && aiResult.tracks && aiResult.tracks.length > 0) {
            // Get yt-search internally to quickly map the songs to real metadata/thumbnails
            const yts = require('yt-search');

            // Map AI songs to real search queries concurrently
            const searchPromises = aiResult.tracks.map(async (t, i) => {
                try {
                    const searchRes = await yts(`${t.name} ${t.artist} audio`);
                    if (searchRes.videos && searchRes.videos.length > 0) {
                        const m = searchRes.videos[0];
                        return {
                            id: m.videoId || `ai-${i}`,
                            name: t.name,
                            artist: t.artist,
                            album: t.album || 'Single',
                            albumArt: m.thumbnail,
                            duration: m.seconds ? m.seconds * 1000 : 180000,
                            youtubeId: m.videoId,
                            uri: hasSpotify ? `spotify:track:unknown` : null // Fake URI if Spotify, actual mapping takes API quota
                        };
                    }
                } catch (err) {
                    console.error('YT search error during AI generation:', err.message);
                }
                return { ...t, id: `ai-${i}`, duration: 180000 };
            });

            tracks = await Promise.all(searchPromises);
        }

        // If Gemini failed completely, fallback
        if (tracks.length === 0) {
            const params = parsePromptFallback(prompt);
            tracks = generateDemoPlaylist(params);
            playlistName = params.playlistName;
            playlistMood = params.mood;
        }

        res.json({
            success: true,
            playlist: {
                name: playlistName,
                description: playlistDescription,
                mood: playlistMood,
                genres: playlistGenres,
                tracks
            },
            source: tracks.some(t => t.youtubeId) ? 'gemini+youtube' : 'demo',
            message: tracks.some(t => t.youtubeId) ? 'AI Curated Tracks found!' : 'Demo tracks (connect Spotify for personalized recommendations)'
        });

    } catch (error) {
        console.error('AI playlist generation error:', error);
        res.status(500).json({
            error: { message: 'Failed to generate playlist', status: 500 }
        });
    }
});

// Demo playlist data (fallback when Spotify not connected)
function generateDemoPlaylist(params) {
    const demoTracks = {
        pop: [
            { name: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours' },
            { name: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia' },
            { name: 'Watermelon Sugar', artist: 'Harry Styles', album: 'Fine Line' },
            { name: 'Don\'t Start Now', artist: 'Dua Lipa', album: 'Future Nostalgia' },
            { name: 'Circles', artist: 'Post Malone', album: 'Hollywood\'s Bleeding' }
        ],
        chill: [
            { name: 'Electric', artist: 'Khalid', album: 'Free Spirit' },
            { name: 'Good Days', artist: 'SZA', album: 'Good Days' },
            { name: 'Heat Waves', artist: 'Glass Animals', album: 'Dreamland' },
            { name: 'Location', artist: 'Khalid', album: 'American Teen' },
            { name: 'Sunflower', artist: 'Post Malone', album: 'Spider-Man' }
        ],
        'work-out': [
            { name: 'Stronger', artist: 'Kanye West', album: 'Graduation' },
            { name: 'Till I Collapse', artist: 'Eminem', album: 'The Eminem Show' },
            { name: 'Power', artist: 'Kanye West', album: 'My Beautiful Dark Twisted Fantasy' },
            { name: 'Lose Yourself', artist: 'Eminem', album: '8 Mile' },
            { name: 'Eye of the Tiger', artist: 'Survivor', album: 'Eye of the Tiger' }
        ],
        jazz: [
            { name: 'Take Five', artist: 'Dave Brubeck', album: 'Time Out' },
            { name: 'So What', artist: 'Miles Davis', album: 'Kind of Blue' },
            { name: 'My Favorite Things', artist: 'John Coltrane', album: 'My Favorite Things' },
            { name: 'Fly Me to the Moon', artist: 'Frank Sinatra', album: 'It Might as Well Be Swing' },
            { name: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue' }
        ],
        rock: [
            { name: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera' },
            { name: 'Smells Like Teen Spirit', artist: 'Nirvana', album: 'Nevermind' },
            { name: 'Back in Black', artist: 'AC/DC', album: 'Back in Black' },
            { name: 'Sweet Child O\' Mine', artist: 'Guns N\' Roses', album: 'Appetite for Destruction' },
            { name: 'Hotel California', artist: 'Eagles', album: 'Hotel California' }
        ],
        study: [
            { name: 'Snowman', artist: 'WYS', album: 'Lofi Study' },
            { name: 'Coffee', artist: 'Beabadoobee', album: 'Patched Up' },
            { name: 'Affection', artist: 'Jinsang', album: 'Solitude' },
            { name: 'Autumn in Tokyo', artist: 'Tomppabeats', album: 'Harbor' },
            { name: 'Blue Boi', artist: 'Lakey Inspired', album: 'Blue Boi' }
        ]
    };

    // Find matching tracks based on genres
    let selectedTracks = [];
    for (const genre of params.genres) {
        if (demoTracks[genre]) {
            selectedTracks.push(...demoTracks[genre]);
        }
    }

    // Fallback to pop if no matches
    if (selectedTracks.length === 0) {
        selectedTracks = demoTracks.pop;
    }

    // Shuffle and limit
    selectedTracks = selectedTracks
        .sort(() => Math.random() - 0.5)
        .slice(0, 12)
        .map((track, index) => ({
            id: `demo-${index + 1}`,
            ...track,
            albumArt: null,
            duration: 180000 + Math.random() * 120000,
            uri: null,
            previewUrl: null
        }));

    return selectedTracks;
}

// Save generated playlist to Spotify
router.post('/save-to-spotify', authMiddleware, async (req, res) => {
    try {
        const { name, description, tracks } = req.body;

        const spotifyTokens = req.user.getPlatformTokens('spotify');
        if (!spotifyTokens || !spotifyTokens.accessToken) {
            return res.status(403).json({
                error: { message: 'Please connect your Spotify account to save playlists', status: 403 }
            });
        }

        // Search for the tracks on Spotify to get real URIs
        const { searchSpotify } = require('../services/song-matcher');
        const realUris = [];

        if (tracks && tracks.length > 0) {
            for (const t of tracks) {
                // If it already has a real Spotify URI (not our dummy one), use it
                if (t.uri && t.uri.startsWith('spotify:track:') && t.uri !== 'spotify:track:unknown') {
                    realUris.push(t.uri);
                    continue;
                }

                // Otherwise search Spotify for this track mapped by Gemini
                try {
                    const query = `${t.name} ${t.artist}`.trim();
                    const matches = await searchSpotify(query, spotifyTokens.accessToken);
                    if (matches.length > 0) {
                        realUris.push(matches[0].spotifyUri);
                    }
                } catch (err) {
                    console.error('Spotify search failed for track:', t.name, err.message);
                }
            }
        }

        if (realUris.length === 0) {
            return res.status(400).json({
                error: { message: 'Failed to match any tracks on Spotify.', status: 400 }
            });
        }

        // Create playlist
        const createResp = await axios.post(
            'https://api.spotify.com/v1/me/playlists',
            { name: name || 'AI Generated Playlist', description: description || 'Created with Plansfer AI', public: false },
            { headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` } }
        );

        // Add tracks in chunks
        for (let i = 0; i < realUris.length; i += 100) {
            await axios.post(
                `https://api.spotify.com/v1/playlists/${createResp.data.id}/items`,
                { uris: realUris.slice(i, i + 100) },
                { headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` } }
            );
        }

        res.json({
            success: true,
            playlist: {
                id: createResp.data.id,
                name: createResp.data.name,
                url: createResp.data.external_urls.spotify
            }
        });

    } catch (error) {
        console.error('Save to Spotify error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: {
                message: 'Failed to save playlist to Spotify',
                status: error.response?.status || 500
            }
        });
    }
});

router.get('/status', (req, res) => {
    res.json({
        geminiConfigured: !!process.env.GEMINI_API_KEY,
        availableGenres: SPOTIFY_GENRES.length,
        features: {
            aiParsing: !!process.env.GEMINI_API_KEY,
            spotifyRecommendations: 'Requires Spotify connection',
            demoMode: 'Always available'
        }
    });
});

module.exports = router;
