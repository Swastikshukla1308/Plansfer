/**
 * AI Playlist Creator - Frontend
 * Now uses backend API with Gemini AI + Spotify Recommendations
 */

// Store current generated playlist
let currentAIPlaylist = [];
let currentPlaylistMeta = null;

// API base URL 
const API_BASE = '/api';

// Generate playlist using backend AI
async function generatePlaylistFromAPI(prompt) {
    const response = await fetch(`${API_BASE}/ai-playlist/generate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('musikTransferToken') || ''}`
        },
        body: JSON.stringify({ prompt })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to generate playlist');
    }

    return response.json();
}

// Save playlist to selected platform
async function savePlaylistToPlatform(platform, name, tracks) {
    const transferId = `ai_transfer_${Date.now()}`;
    const response = await fetch(`${API_BASE}/playlist/transfer`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('musikTransferToken') || ''}`
        },
        body: JSON.stringify({
            sourcePlatform: 'ai',
            sourcePlaylistId: 'ai-gen',
            destinationPlatform: platform,
            playlistName: name,
            playlistDescription: currentPlaylistMeta?.description || 'Created with Plansfer AI',
            transferId,
            tracks
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || `Failed to save playlist to ${platform}`);
    }

    return response.json();
}

// Display generated playlist
function displayPlaylist(tracks, meta = {}) {
    const songList = document.getElementById('ai-song-list');
    const resultContainer = document.getElementById('ai-result');

    if (!songList || !resultContainer) return;

    songList.innerHTML = '';

    tracks.forEach((track, index) => {
        const li = document.createElement('li');
        li.className = 'ai-song-item';
        li.innerHTML = `
            <span class="ai-song-num">${index + 1}</span>
            ${track.albumArt ? `<img src="${track.albumArt}" alt="Cover" class="ai-song-cover" style="width: 40px; height: 40px; border-radius: 4px; margin-right: 12px;">` : ''}
            <div class="ai-song-info">
                <div class="ai-song-title">${track.name}</div>
                <div class="ai-song-artist">${track.artist}${track.album ? ` • ${track.album}` : ''}</div>
            </div>
            ${track.previewUrl ? `<button class="btn-preview" onclick="playPreview('${track.previewUrl}')" title="Preview">▶</button>` : ''}
        `;
        songList.appendChild(li);
    });

    // Update header if we have metadata
    if (meta.name) {
        const header = resultContainer.querySelector('h4');
        if (header) {
            header.textContent = `🎵 ${meta.name}`;
        }
    }

    resultContainer.style.display = 'block';
}

// Play audio preview
let currentAudio = null;
function playPreview(url) {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    currentAudio = new Audio(url);
    currentAudio.volume = 0.5;
    currentAudio.play();

    // Stop after 30 seconds max
    setTimeout(() => {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio = null;
        }
    }, 30000);
}

// Initialize AI Playlist functionality
function initAIPlaylist() {
    const generateBtn = document.getElementById('generate-ai-playlist');
    const regenerateBtn = document.getElementById('regenerate-ai-playlist');
    const saveBtn = document.getElementById('save-ai-playlist');
    const tryAIBtn = document.getElementById('try-ai-btn');
    const promptInput = document.getElementById('ai-prompt');

    if (generateBtn) {
        generateBtn.addEventListener('click', async () => {
            const prompt = promptInput?.value?.trim();

            if (!prompt) {
                showNotification('Please describe the type of playlist you want!', 'error');
                return;
            }

            // Show loading state
            generateBtn.disabled = true;
            generateBtn.innerHTML = '⏳ AI IS THINKING...';

            try {
                const result = await generatePlaylistFromAPI(prompt);

                currentAIPlaylist = result.playlist.tracks;
                currentPlaylistMeta = {
                    name: result.playlist.name,
                    description: result.playlist.description,
                    mood: result.playlist.mood,
                    genres: result.playlist.genres
                };

                displayPlaylist(currentAIPlaylist, currentPlaylistMeta);

                const sourceMsg = result.source === 'spotify'
                    ? '🎧 Real Spotify tracks!'
                    : '🎵 Demo tracks (connect Spotify for personalized results)';

                showNotification(`${currentAIPlaylist.length} songs generated! ${sourceMsg}`, 'success');

            } catch (error) {
                console.error('AI generation error:', error);
                showNotification(error.message || 'Failed to generate playlist', 'error');
            } finally {
                generateBtn.disabled = false;
                generateBtn.innerHTML = '✨ GENERATE PLAYLIST';
            }
        });
    }

    if (regenerateBtn) {
        regenerateBtn.addEventListener('click', async () => {
            const prompt = promptInput?.value?.trim() || 'chill vibes';

            regenerateBtn.disabled = true;
            regenerateBtn.innerHTML = '⏳ ...';

            try {
                const result = await generatePlaylistFromAPI(prompt);
                currentAIPlaylist = result.playlist.tracks;
                currentPlaylistMeta = result.playlist;
                displayPlaylist(currentAIPlaylist, currentPlaylistMeta);
                showNotification('Playlist regenerated!', 'success');
            } catch (error) {
                showNotification(error.message || 'Failed to regenerate', 'error');
            } finally {
                regenerateBtn.disabled = false;
                regenerateBtn.innerHTML = 'REGENERATE';
            }
        });
    }

    // Modal Elements for Save to Platform
    const aiSaveModal = document.getElementById('ai-save-modal');
    const closeAiSaveModalBtn = document.getElementById('close-ai-save-modal');
    const aiDestinationPlatformSelect = document.getElementById('ai-destination-platform');
    const aiSaveConfirmBtn = document.getElementById('ai-save-confirm-btn');

    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            if (currentAIPlaylist.length === 0) {
                showNotification('No playlist to save. Generate one first!', 'error');
                return;
            }
            if (aiSaveModal) {
                aiSaveModal.style.display = 'flex';
                document.body.style.overflow = 'hidden';
            }
        });
    }

    if (closeAiSaveModalBtn) {
        closeAiSaveModalBtn.addEventListener('click', () => {
            aiSaveModal.style.display = 'none';
            document.body.style.overflow = '';
        });
    }

    if (aiDestinationPlatformSelect && aiSaveConfirmBtn) {
        aiDestinationPlatformSelect.addEventListener('change', (e) => {
            const platform = e.target.value;
            aiSaveConfirmBtn.disabled = !platform;
            aiSaveConfirmBtn.innerHTML = platform ? `CONNECT & SAVE TO ${platform.toUpperCase()}` : 'CONNECT & SAVE';
        });

        aiSaveConfirmBtn.addEventListener('click', async () => {
            const platform = aiDestinationPlatformSelect.value;
            if (!platform) return;

            aiSaveConfirmBtn.disabled = true;
            aiSaveConfirmBtn.innerHTML = 'Connecting...';

            // Wait, we need to ensure the user is connected to the selected platform.
            // Using window.api from script.js to trigger the flow if needed? Yes, but if we don't have it, 
            // the backend will just send a 403 "Please connect..." which we can catch and trigger a redirect.
            try {
                const result = await savePlaylistToPlatform(
                    platform,
                    currentPlaylistMeta?.name || 'AI Generated Playlist',
                    currentAIPlaylist
                );

                aiSaveModal.style.display = 'none';
                document.body.style.overflow = '';
                showNotification(`Playlist saved to ${platform}! 🎉`, 'success');

                // Open playlist in new tab if URL is returned
                if (result.playlist?.url) {
                    window.open(result.playlist.url, '_blank');
                }
            } catch (error) {
                if (error.message.includes('Please connect')) {
                    // Trigger auth flow
                    showNotification(`Please authenticate with ${platform} first. Check the Home page to connect.`, 'error');
                    // In a full implementation, we could trigger the window.open auth window right here,
                    // but for now we guide the user or trigger the API endpoint if accessible.
                    if (window.api) {
                        try {
                            // Rough trigger of auth
                            let authUrl = null;
                            if (platform === 'spotify') authUrl = await window.api.getSpotifyAuthUrl();
                            else if (platform === 'youtube' || platform === 'youtube-music') authUrl = await window.api.getYouTubeAuthUrl();
                            // etc...
                            
                            if (authUrl) {
                                window.location.href = authUrl.url;
                            }
                        } catch (e) {
                            showNotification(error.message, 'error');
                        }
                    } else {
                        showNotification(error.message, 'error');
                    }
                } else {
                    showNotification(error.message || `Failed to save playlist`, 'error');
                }
            } finally {
                aiSaveConfirmBtn.disabled = false;
                aiSaveConfirmBtn.innerHTML = `CONNECT & SAVE TO ${platform.toUpperCase()}`;
            }
        });
    }

    // "Try AI Now" button on landing page
    if (tryAIBtn) {
        tryAIBtn.addEventListener('click', (e) => {
            e.preventDefault();

            // Check if logged in
            const savedUser = localStorage.getItem('musikTransferUser');
            if (!savedUser) {
                // Open login modal
                const authModal = document.getElementById('auth-modal');
                if (authModal) {
                    authModal.style.display = 'flex';
                    document.body.style.overflow = 'hidden';
                }
                showNotification('Please log in to use AI Playlist Creator', 'error');
                return;
            }

            // Redirect to AI Playlist page
            window.location.href = 'create-playlist.html';
        });
    }
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    initAIPlaylist();
});
