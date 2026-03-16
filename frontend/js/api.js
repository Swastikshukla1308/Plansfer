// API Configuration
const API_BASE_URL = '/api';

// API Helper class
class API {
    constructor() {
        this.baseURL = API_BASE_URL;
        this.token = localStorage.getItem('musikTransferToken');
    }

    // Set authentication token
    setToken(token) {
        this.token = token;
        if (token) {
            localStorage.setItem('musikTransferToken', token);
        } else {
            localStorage.removeItem('musikTransferToken');
        }
    }

    // Get headers with auth token
    getHeaders() {
        const headers = {
            'Content-Type': 'application/json'
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        return headers;
    }

    // Make API request
    async request(endpoint, options = {}) {
        const {
            timeoutMs = 45000,
            ...requestOptions
        } = options;
        const url = `${this.baseURL}${endpoint}`;
        const controller = new AbortController();
        const timeoutId = Number.isFinite(timeoutMs) && timeoutMs > 0
            ? setTimeout(() => controller.abort(), timeoutMs)
            : null;
        const config = {
            credentials: 'include',
            ...requestOptions,
            signal: controller.signal,
            headers: {
                ...this.getHeaders(),
                ...requestOptions.headers
            }
        };

        try {
            const response = await fetch(url, config);
            const contentType = response.headers.get('content-type') || '';
            let data = {};

            if (contentType.includes('application/json')) {
                data = await response.json();
            } else {
                const text = await response.text();
                if (text) {
                    try {
                        data = JSON.parse(text);
                    } catch {
                        data = { error: { message: text } };
                    }
                }
            }

            if (!response.ok) {
                // Intercept 401 Unauthorized errors (e.g., User not found or Token expired)
                if (response.status === 401) {
                    this.setToken(null);
                    localStorage.removeItem('musikTransferUser');
                    window.dispatchEvent(new Event('auth_expired'));
                }

                const err = new Error(
                    data?.error?.message || `Request failed (${response.status})`
                );
                err.status = response.status;
                err.data = data;
                throw err;
            }

            return data;
        } catch (error) {
            if (error?.name === 'AbortError') {
                const timeoutError = new Error(
                    'The request timed out. Please retry.'
                );
                timeoutError.code = 'REQUEST_TIMEOUT';
                throw timeoutError;
            }

            if (
                error instanceof TypeError &&
                /failed to fetch/i.test(error.message || '')
            ) {
                const networkError = new Error(
                    'Connection to the server was interrupted. Please retry.'
                );
                networkError.code = 'NETWORK_ERROR';
                throw networkError;
            }

            console.error('API Error:', error);
            throw error;
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }

    // Auth endpoints
    async register(userData) {
        return this.request('/auth/register', {
            method: 'POST',
            body: JSON.stringify(userData)
        });
    }

    async login(credentials) {
        return this.request('/auth/login', {
            method: 'POST',
            body: JSON.stringify(credentials)
        });
    }

    async getMe() {
        return this.request('/auth/me');
    }

    async logout() {
        const result = await this.request('/auth/logout', {
            method: 'POST'
        });
        this.setToken(null);
        return result;
    }

    // Spotify endpoints
    async getSpotifyAuthUrl() {
        const frontendOrigin =
            typeof window !== 'undefined' && window.location?.origin
                ? window.location.origin
                : '';
        const query = frontendOrigin
            ? `?frontend_origin=${encodeURIComponent(frontendOrigin)}`
            : '';
        return this.request(`/spotify/auth${query}`);
    }

    async getSpotifyStatus() {
        return this.request('/spotify/status');
    }

    async disconnectSpotify() {
        return this.request('/spotify/disconnect', {
            method: 'POST'
        });
    }

    async getSpotifyPlaylist(playlistId) {
        return this.request(`/spotify/playlist/${playlistId}`);
    }

    async getSpotifyPlaylistTracks(playlistId) {
        return this.request(`/spotify/playlist/${playlistId}/tracks`);
    }

    async createSpotifyPlaylist(playlistData) {
        return this.request('/spotify/playlist', {
            method: 'POST',
            body: JSON.stringify(playlistData)
        });
    }

    async addTracksToSpotifyPlaylist(playlistId, trackUris) {
        return this.request(`/spotify/playlist/${playlistId}/tracks`, {
            method: 'POST',
            body: JSON.stringify({ trackUris })
        });
    }

    // Playlist endpoints
    async detectPlatform(url) {
        return this.request('/playlist/detect', {
            method: 'POST',
            body: JSON.stringify({ url })
        });
    }

    async fetchPlaylist(platform, playlistId, originalUrl) {
        const body = { platform, playlistId };
        if (originalUrl) body.originalUrl = originalUrl;
        return this.request('/playlist/fetch', {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async transferPlaylist(transferData) {
        return this.request('/playlist/transfer', {
            method: 'POST',
            body: JSON.stringify(transferData),
            timeoutMs: 8 * 60 * 1000
        });
    }

    async getTransferHistory() {
        return this.request('/playlist/history');
    }

    // YouTube endpoints
    async getYouTubeAuthUrl() {
        return this.request('/youtube/auth');
    }

    async getYouTubeStatus() {
        return this.request('/youtube/status');
    }

    async disconnectYouTube() {
        return this.request('/youtube/disconnect', {
            method: 'POST'
        });
    }

    async getYouTubePlaylist(playlistId) {
        return this.request(`/youtube/playlist/${playlistId}`);
    }

    async getYouTubePlaylistTracks(playlistId) {
        return this.request(`/youtube/playlist/${playlistId}/tracks`);
    }

    async createYouTubePlaylist(playlistData) {
        return this.request('/youtube/playlist', {
            method: 'POST',
            body: JSON.stringify(playlistData)
        });
    }

    async addVideosToYouTubePlaylist(playlistId, videoIds) {
        return this.request(`/youtube/playlist/${playlistId}/tracks`, {
            method: 'POST',
            body: JSON.stringify({ videoIds })
        });
    }

    // JioSaavn endpoints
    async getJioSaavnStatus() {
        return this.request('/jiosaavn/status');
    }

    async searchJioSaavn(query, type = 'all') {
        return this.request(`/jiosaavn/search?q=${encodeURIComponent(query)}&type=${type}`);
    }

    async getJioSaavnPlaylist(playlistId) {
        return this.request(`/jiosaavn/playlist/${playlistId}`);
    }

    async getJioSaavnSong(songId) {
        return this.request(`/jiosaavn/song/${songId}`);
    }

    async getJioSaavnAlbum(albumId) {
        return this.request(`/jiosaavn/album/${albumId}`);
    }

    async getJioSaavnTrending() {
        return this.request('/jiosaavn/trending');
    }

    // Amazon Music endpoints
    async getAmazonMusicAuthUrl() {
        return this.request('/amazon-music/auth');
    }

    async getAmazonMusicStatus() {
        return this.request('/amazon-music/status');
    }

    async getAmazonMusicPlaylist(playlistId) {
        return this.request(`/amazon-music/playlist/${playlistId}`);
    }

    // Gaana endpoints
    async getGaanaStatus() {
        return this.request('/gaana/status');
    }

    async getGaanaPlaylist(playlistId) {
        return this.request(`/gaana/playlist/${playlistId}`);
    }

    async searchGaana(query, type = 'all') {
        return this.request(`/gaana/search?q=${encodeURIComponent(query)}&type=${type}`);
    }

    async getGaanaTrending() {
        return this.request('/gaana/trending');
    }

    // Apple Music endpoints
    async getAppleMusicToken() {
        return this.request('/apple-music/token');
    }

    // Health check
    async healthCheck() {
        return fetch(`${this.baseURL.replace('/api', '')}/api/health`)
            .then(res => res.json());
    }
}

// Create and export API instance
const api = new API();

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
