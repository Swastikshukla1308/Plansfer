// State management
const state = {
  sourcePlatform: null,
  playlistUrl: null,
  destinationPlatform: null,
  isAuthenticated: false,
  playlistData: null,
  isCheckingDestinationAuth: false,
  isConnectingDestination: false,
  isDisconnectingDestination: false,
};

// DOM Elements
const views = {
  landing: document.getElementById("landing-view"),
  app: document.getElementById("app-view"),
};

const playlistUrlInput = document.getElementById("playlist-url");
const fetchPlaylistButton = document.getElementById("fetch-playlist");
const playlistPreview = document.getElementById("playlist-preview");
const detectedPlatformDiv = document.getElementById("detected-platform");
// platform-icon is removed in new design, strictly text based or derived
const platformText = document.getElementById("platform-text");
const destinationPlatformSelect = document.getElementById(
  "destination-platform",
);
const loginButton = document.getElementById("login-button");
const transferButton = document.getElementById("transfer-button");
const authStatus = document.getElementById("auth-status");
const progressSection = document.getElementById("progress-section");
const successSection = document.getElementById("success-section");
// platformName removed in favor of direct text updates if needed, or simplified
const getStartedBtn = document.getElementById("get-started-btn");
const SPOTIFY_REAUTH_GUARD_KEY = "musikTransferSpotifyReauthRedirected";

function hasSpotifyReauthRedirected() {
  return sessionStorage.getItem(SPOTIFY_REAUTH_GUARD_KEY) === "1";
}

function markSpotifyReauthRedirected() {
  sessionStorage.setItem(SPOTIFY_REAUTH_GUARD_KEY, "1");
}

function clearSpotifyReauthRedirected() {
  sessionStorage.removeItem(SPOTIFY_REAUTH_GUARD_KEY);
}

function formatSpotifyReauthFailureMessage(error) {
  const providerReason = error?.data?.error?.providerReason;
  const scopeStatus = error?.data?.error?.scopeStatus;
  const missingScopes = Array.isArray(scopeStatus?.missing)
    ? scopeStatus.missing.filter(Boolean)
    : [];

  if (missingScopes.length > 0) {
    return `Spotify still reports missing required access after reconnect. Missing scope: ${missingScopes.join(", ")}. Please reconnect from CONNECT ACCOUNT, approve all requested access, and retry.`;
  }

  if (providerReason) {
    return `Spotify still rejected the transfer after reconnect: ${providerReason}`;
  }

  return "Spotify still reports missing permissions after reconnect. Please reconnect Spotify from CONNECT ACCOUNT, approve all requested access, and retry the transfer.";
}

function normalizeDestinationAuthPlatform(platform) {
  return platform === "youtube-music" ? "youtube" : platform;
}

function formatCountLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function updateLoginButtonState() {
  if (!loginButton) return;

  if (!state.destinationPlatform) {
    loginButton.disabled = true;
    loginButton.textContent = "CONNECT ACCOUNT";
    return;
  }

  if (state.isCheckingDestinationAuth) {
    loginButton.disabled = true;
    loginButton.textContent = "CHECKING...";
    return;
  }

  if (state.isConnectingDestination) {
    loginButton.disabled = true;
    loginButton.textContent = "CONNECTING...";
    return;
  }

  if (state.isDisconnectingDestination) {
    loginButton.disabled = true;
    loginButton.textContent = "DISCONNECTING...";
    return;
  }

  loginButton.disabled = false;
  loginButton.textContent = state.isAuthenticated
    ? "DISCONNECT"
    : "CONNECT ACCOUNT";
}

async function refreshDestinationAuthState({ silent = true } = {}) {
  if (!state.destinationPlatform) {
    state.isAuthenticated = false;
    updateAuthStatus(false);
    updateUIState();
    return false;
  }

  const normalizedPlatform = normalizeDestinationAuthPlatform(
    state.destinationPlatform,
  );
  let statusRequest = null;

  switch (normalizedPlatform) {
    case "spotify":
      statusRequest = () => api.getSpotifyStatus();
      break;
    case "youtube":
      statusRequest = () => api.getYouTubeStatus();
      break;
    case "apple-music":
      statusRequest = async () => {
        try {
          if (!window.MusicKit) return { connected: false };
          let music;
          try { music = window.MusicKit.getInstance(); } catch (e) {}
          if (music && music.isAuthorized) {
            return { connected: true };
          }
          return { connected: false };
        } catch (e) {
          return { connected: false };
        }
      };
      break;
    default:
      updateAuthStatus(state.isAuthenticated);
      updateUIState();
      return state.isAuthenticated;
  }

  state.isCheckingDestinationAuth = true;
  updateUIState();

  try {
    const response = await statusRequest();
    state.isAuthenticated = !!response?.connected;
  } catch (error) {
    state.isAuthenticated = false;
    if (!silent && error?.status !== 401) {
      console.error("Destination auth state check failed:", error);
    }
  } finally {
    state.isCheckingDestinationAuth = false;
    updateAuthStatus(state.isAuthenticated);
    updateUIState();
  }

  return state.isAuthenticated;
}

async function disconnectDestinationPlatform() {
  if (!state.destinationPlatform) return;

  const config = platformConfig[state.destinationPlatform];
  const normalizedPlatform = normalizeDestinationAuthPlatform(
    state.destinationPlatform,
  );

  state.isDisconnectingDestination = true;
  updateUIState();

  try {
    switch (normalizedPlatform) {
      case "spotify":
        await api.disconnectSpotify();
        break;
      case "youtube":
        await api.disconnectYouTube();
        break;
      case "apple-music":
        try {
          if (window.MusicKit) {
            const music = window.MusicKit.getInstance();
            if (music) await music.unauthorize();
          }
        } catch (e) {
          console.error("Failed to disconnect Apple Music", e);
        }
        break;
      default:
        break;
    }

    clearSpotifyReauthRedirected();
    state.isAuthenticated = false;
    updateAuthStatus(false);
    showNotification(`${config.name} disconnected successfully.`, "success");
  } catch (error) {
    console.error("Disconnect account error:", error);
    showNotification(
      error.message || `Failed to disconnect ${config.name}. Please try again.`,
      "error",
    );
  } finally {
    state.isDisconnectingDestination = false;
    updateUIState();
  }
}

// Save session state to survive OAuth redirects
function saveSessionState() {
  const stateToPersist = {
    sourcePlatform: state.sourcePlatform,
    playlistUrl: state.playlistUrl,
    destinationPlatform: state.destinationPlatform,
    playlistData: state.playlistData,
  };
  sessionStorage.setItem("musikTransferState", JSON.stringify(stateToPersist));
}

// Restore session state after OAuth redirects
function restoreSessionState() {
  const savedState = sessionStorage.getItem("musikTransferState");
  if (savedState) {
    try {
      const parsedState = JSON.parse(savedState);
      // Do not persist/restore auth booleans across redirects; OAuth callback
      // should be the source of truth for connection state.
      if (Object.prototype.hasOwnProperty.call(parsedState, "sourcePlatform")) {
        state.sourcePlatform = parsedState.sourcePlatform;
      }
      if (Object.prototype.hasOwnProperty.call(parsedState, "playlistUrl")) {
        state.playlistUrl = parsedState.playlistUrl;
      }
      if (
        Object.prototype.hasOwnProperty.call(parsedState, "destinationPlatform")
      ) {
        state.destinationPlatform = parsedState.destinationPlatform;
      }
      if (Object.prototype.hasOwnProperty.call(parsedState, "playlistData")) {
        state.playlistData = parsedState.playlistData;
      }

      // Restore UI inputs if they exist
      if (playlistUrlInput && state.playlistUrl) {
        playlistUrlInput.value = state.playlistUrl;
      }
      if (destinationPlatformSelect && state.destinationPlatform) {
        destinationPlatformSelect.value = state.destinationPlatform;
      }

      // Restore UI views
      if (state.sourcePlatform) {
        displayDetectedPlatform(state.sourcePlatform);
      }
      if (state.playlistData) {
        if (fetchPlaylistButton)
          fetchPlaylistButton.textContent = "✓ Playlist Loaded";
        displayPlaylistPreview(state.playlistData);
      }
    } catch (e) {
      console.error("Failed to restore state", e);
    }
  }
}

// Platform configurations
const platformConfig = {
  spotify: {
    name: "Spotify",
    urlPattern: /^https?:\/\/(open\.)?spotify\.com\/playlist\/.+/,
    icon: "🎵",
  },
  "apple-music": {
    name: "Apple Music",
    urlPattern: /^https?:\/\/(music\.apple\.com\/).+/,
    icon: "🍎",
  },
  "youtube-music": {
    name: "YouTube Music",
    urlPattern: /^https?:\/\/music\.youtube\.com\/playlist.+/,
    icon: "📺",
  },
  deezer: {
    name: "Deezer",
    urlPattern: /^https?:\/\/(www\.)?deezer\.com\/[a-z]+\/playlist\/.+/,
    icon: "💿",
  },
  tidal: {
    name: "Tidal",
    urlPattern: /^https?:\/\/(www\.)?tidal\.com\/browse\/playlist\/.+/,
    icon: "🌊",
  },
  youtube: {
    name: "YouTube",
    urlPattern: /^https?:\/\/(www\.)?youtube\.com\/playlist.+/,
    icon: "▶️",
  },
  jiosaavn: {
    name: "JioSaavn",
    urlPattern:
      /^https?:\/\/(www\.)?(jiosaavn\.com|saavn\.com)\/(featured|s\/playlist)\/.+/,
    icon: "🎧",
  },
  "amazon-music": {
    name: "Amazon Music",
    urlPattern: /^https?:\/\/music\.amazon\.(com|in|co\.uk|de)\/playlists\/.+/,
    icon: "📦",
  },
  gaana: {
    name: "Gaana",
    urlPattern: /^https?:\/\/(www\.)?gaana\.com\/playlist\/.+/,
    icon: "🎶",
  },
};

// Initialize
async function init() {
  initTheme(); // Initialize theme FIRST so it doesn't break on missing DOM elements
  setupEventListeners();

  window.addEventListener('auth_expired', () => {
      // Hard refresh if token is orphaned/deleted
      window.location.reload();
  });

  checkAuthStateForView(); // Check initial view state
  restoreSessionState(); // Restore state before handling OAuth callback
  handleOAuthCallback(); // Handle OAuth redirects
  if (state.destinationPlatform && !state.isAuthenticated) {
    await refreshDestinationAuthState();
  }
  updateUIState();
  animateStats(); // Start stats animation
  renderHistory(); // Load local history
}

// Theme Management
function initTheme() {
  const toggleBtn = document.getElementById("theme-toggle");
  const savedTheme = localStorage.getItem("musikTransferTheme") || "light";

  // Apply saved theme
  document.documentElement.setAttribute("data-theme", savedTheme);
  if (toggleBtn) toggleBtn.textContent = savedTheme === "dark" ? "☀️" : "🌙";

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const newTheme = current === "dark" ? "light" : "dark";

      document.documentElement.setAttribute("data-theme", newTheme);
      localStorage.setItem("musikTransferTheme", newTheme);
      toggleBtn.textContent = newTheme === "dark" ? "☀️" : "🌙";
    });
  }
}

// Animate Stats
function animateStats() {
  const statsElement = document.querySelector(".stats-text strong");
  if (!statsElement) return;

  const target = 245000; // 245K
  const duration = 2000; // 2 seconds
  const start = 0;
  const increment = target / (duration / 16); // 60fps

  let current = start;

  const animate = () => {
    current += increment;
    if (current < target) {
      statsElement.textContent = Math.floor(current / 1000) + "K+";
      requestAnimationFrame(animate);
    } else {
      statsElement.textContent = "245K+";
    }
  };

  animate();
}

// Setup event listeners
function setupEventListeners() {
  if (playlistUrlInput)
    playlistUrlInput.addEventListener("input", handlePlaylistUrlInput);
  if (fetchPlaylistButton)
    fetchPlaylistButton.addEventListener("click", handleFetchPlaylist);
  if (destinationPlatformSelect)
    destinationPlatformSelect.addEventListener(
      "change",
      handleDestinationPlatformChange,
    );
  if (loginButton) loginButton.addEventListener("click", handleConnectAccount);
  if (transferButton) transferButton.addEventListener("click", handleTransfer);
  if (getStartedBtn)
    getStartedBtn.addEventListener(
      "click",
      () => (document.getElementById("auth-modal").style.display = "flex"),
    );

  // Mobile Menu
  const mobileBtn = document.getElementById("mobile-menu-toggle");
  const nav = document.getElementById("main-nav");
  if (mobileBtn && nav) {
    mobileBtn.addEventListener("click", () => {
      nav.classList.toggle("active");
      mobileBtn.textContent = nav.classList.contains("active") ? "✕" : "☰";
    });
  }

  // Smooth scrolling for navigation links
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", function (e) {
      const href = this.getAttribute("href") || "";
      if (!href.startsWith("#") || href.length <= 1) {
        return;
      }
      e.preventDefault();
      const target = document.querySelector(href);
      if (target) {
        target.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    });
  });
}

function checkAuthStateForView() {
  // This function will be called by auth.js or init
  // We need to expose a way to switch views
  const user = localStorage.getItem("musikTransferUser");

  // Only proceed if views exist (they might not on create-playlist.html)
  if (!views.landing || !views.app) return;

  if (user) {
    views.landing.style.display = "none";
    views.app.style.display = "block";
  } else {
    views.landing.style.display = "block";
    views.app.style.display = "none";
  }
}

// Expose switch view function globally for auth.js to call
window.updateViewOnLogin = function (isLoggedIn) {
  if (!views.landing || !views.app) return;

  if (isLoggedIn) {
    views.landing.style.display = "none";
    views.app.style.display = "block";
  } else {
    views.landing.style.display = "block";
    views.app.style.display = "none";
  }
};

// Handle OAuth callback from URL params
function handleOAuthCallback() {
  const urlParams = new URLSearchParams(window.location.search);

  if (urlParams.get("youtube_connected") === "true") {
    showNotification("YouTube account connected successfully!", "success");
    if (!state.destinationPlatform) {
      state.destinationPlatform = "youtube";
      if (destinationPlatformSelect) {
        destinationPlatformSelect.value = "youtube";
      }
    }
    state.isCheckingDestinationAuth = false;
    state.isConnectingDestination = false;
    state.isDisconnectingDestination = false;
    state.isAuthenticated = true;
    updateAuthStatus(true);
    updateUIState();
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  if (urlParams.get("spotify_connected") === "true") {
    showNotification("Spotify account connected successfully!", "success");
    if (!state.destinationPlatform) {
      state.destinationPlatform = "spotify";
      if (destinationPlatformSelect) {
        destinationPlatformSelect.value = "spotify";
      }
    }
    state.isCheckingDestinationAuth = false;
    state.isConnectingDestination = false;
    state.isDisconnectingDestination = false;
    state.isAuthenticated = true;
    updateAuthStatus(true);
    updateUIState();
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  if (urlParams.get("amazon_music_connected") === "true") {
    showNotification("Amazon Music account connected successfully!", "success");
    if (!state.destinationPlatform) {
      state.destinationPlatform = "amazon-music";
      if (destinationPlatformSelect) {
        destinationPlatformSelect.value = "amazon-music";
      }
    }
    state.isCheckingDestinationAuth = false;
    state.isConnectingDestination = false;
    state.isDisconnectingDestination = false;
    state.isAuthenticated = true;
    updateAuthStatus(true);
    updateUIState();
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  if (urlParams.get("error")) {
    showNotification("Failed to connect account. Please try again.", "error");
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// Handle Connect Account button
async function handleConnectAccount() {
  if (!state.destinationPlatform) {
    showNotification("Please select a destination platform first", "error");
    return;
  }

  if (state.isAuthenticated) {
    await disconnectDestinationPlatform();
    return;
  }

  state.isConnectingDestination = true;
  updateUIState();

  try {
    let authUrl;

    if (
      state.destinationPlatform === "youtube" ||
      state.destinationPlatform === "youtube-music"
    ) {
      const result = await api.getYouTubeAuthUrl();
      authUrl = result.authUrl;
    } else if (state.destinationPlatform === "spotify") {
      const result = await api.getSpotifyAuthUrl();
      authUrl = result.authUrl;
    } else if (state.destinationPlatform === "amazon-music") {
      const result = await api.getAmazonMusicAuthUrl();
      authUrl = result.authUrl;
    } else if (state.destinationPlatform === "apple-music") {
      try {
        const tokenRes = await api.getAppleMusicToken();
        const developerToken = tokenRes.token;
        
        if (!window.MusicKit) {
            throw new Error("MusicKit not loaded");
        }
        
        let music;
        try {
          music = window.MusicKit.getInstance();
        } catch (e) {
          music = await window.MusicKit.configure({
            developerToken: developerToken,
            app: {
              name: 'Plansfer',
              build: '1.0'
            }
          });
        }
        
        await music.authorize();
        showNotification("Apple Music account connected successfully!", "success");
        state.isAuthenticated = true;
        updateAuthStatus(true);
        updateUIState();
        return; // Apple Music does not redirect
      } catch (error) {
         console.error("Apple Music connection error:", error);
         showNotification("Apple Music login failed.", "error");
         return;
      }
    } else {
      showNotification(
        `Please connect your ${platformConfig[state.destinationPlatform].name} account`,
        "error",
      );
      return;
    }

    // Redirect to OAuth
    window.location.href = authUrl;
  } catch (error) {
    console.error("Connect account error:", error);
    showNotification("Failed to start connection. Please try again.", "error");
  } finally {
    state.isConnectingDestination = false;
    updateUIState();
  }
}

// Normalize URL to handle various input formats
function normalizeUrl(input) {
  if (!input) return input;
  let url = input.trim();

  // Remove leading/trailing quotes
  url = url.replace(/^["']+|["']+$/g, "");

  // If no protocol, add https://
  if (!url.match(/^https?:\/\//i)) {
    // Handle 'www.' or direct domain
    url = "https://" + url;
  }

  // Replace mobile YouTube with standard YouTube
  url = url.replace(/\/\/m\.youtube\.com\//i, "//www.youtube.com/");

  // Handle youtu.be share links → full youtube.com URL
  const youtuBeMatch = url.match(/youtu\.be\/([^?]+)(\?.*)?$/);
  if (youtuBeMatch) {
    const params = youtuBeMatch[2] || "";
    const listMatch = params.match(/list=([^&]+)/);
    if (listMatch) {
      url = `https://www.youtube.com/playlist?list=${listMatch[1]}`;
    }
  }

  return url;
}

// Detect platform from URL
function detectPlatform(url) {
  if (!url) return null;

  for (const [platform, config] of Object.entries(platformConfig)) {
    if (config.urlPattern.test(url)) {
      return platform;
    }
  }
  return null;
}

// Display detected platform
function displayDetectedPlatform(platform) {
  if (platform) {
    const config = platformConfig[platform];
    platformText.innerHTML = `<span style="font-size:1.2em;vertical-align:middle;">${config.icon}</span> ${config.name} Detected`;
    detectedPlatformDiv.style.display = "flex";
    detectedPlatformDiv.style.alignItems = "center";
    detectedPlatformDiv.style.gap = "6px";
    detectedPlatformDiv.style.marginTop = "8px";
    detectedPlatformDiv.style.padding = "6px 14px";
    detectedPlatformDiv.style.borderRadius = "20px";
    detectedPlatformDiv.style.background = "rgba(46, 213, 115, 0.15)";
    detectedPlatformDiv.style.color = "#2ed573";
    detectedPlatformDiv.style.fontSize = "0.85rem";
    detectedPlatformDiv.style.fontWeight = "500";
    detectedPlatformDiv.style.marginBottom = "1rem";
  } else {
    detectedPlatformDiv.style.display = "none";
  }
}

// Playlist URL input handler
function handlePlaylistUrlInput(e) {
  let rawUrl = e.target.value.trim();

  // Normalize the URL
  const normalizedUrl = normalizeUrl(rawUrl);
  state.playlistUrl = normalizedUrl;

  // Update input with normalized URL (only if it changed significantly)
  if (
    normalizedUrl !== rawUrl &&
    normalizedUrl !== "https://" + rawUrl &&
    rawUrl.length > 5
  ) {
    // Don't update while user is typing a protocol
    if (!rawUrl.startsWith("http")) {
      e.target.value = normalizedUrl;
    }
  }

  // Auto-detect platform from URL
  const detectedPlatform = detectPlatform(normalizedUrl);
  state.sourcePlatform = detectedPlatform;

  // Display detected platform
  displayDetectedPlatform(detectedPlatform);

  // Hide playlist preview when URL changes
  if (state.playlistData) {
    state.playlistData = null;
    playlistPreview.style.display = "none";
  }

  updateUIState();
}

// Validate playlist URL
function isValidUrl(url, platform) {
  if (!url || !platform) return false;
  const config = platformConfig[platform];
  return config && config.urlPattern.test(url);
}

// Fetch playlist handler
async function handleFetchPlaylist() {
  if (!isValidUrl(state.playlistUrl, state.sourcePlatform)) {
    showNotification("Invalid playlist URL for the selected platform", "error");
    return;
  }

  // Show loading state
  fetchPlaylistButton.disabled = true;
  fetchPlaylistButton.textContent = "Fetching...";

  try {
    // Detect platform and get playlist ID
    const detectResult = await api.detectPlatform(state.playlistUrl);
    const { platform, playlistId } = detectResult;

    // Fetch playlist details
    const fetchResult = await api.fetchPlaylist(
      platform,
      playlistId,
      state.playlistUrl,
    );

    state.playlistData = {
      id: fetchResult.playlist.id,
      name: fetchResult.playlist.name,
      tracks: fetchResult.playlist.tracks,
      image: fetchResult.playlist.image || "https://via.placeholder.com/80",
      description: fetchResult.playlist.description,
      platform: fetchResult.playlist.platform,
    };

    displayPlaylistPreview(state.playlistData);
    fetchPlaylistButton.textContent = "✓ Playlist Loaded";
    showNotification("Playlist fetched successfully!", "success");

    // Reset button after 2 seconds
    setTimeout(() => {
      fetchPlaylistButton.textContent = "FETCH DATA";
      updateUIState();
    }, 2000);
  } catch (error) {
    console.error("Fetch playlist error:", error);
    showNotification(error.message || "Failed to fetch playlist", "error");
    fetchPlaylistButton.textContent = "FETCH DATA";
    fetchPlaylistButton.disabled = false;
  }
}

// Display playlist preview
function displayPlaylistPreview(data) {
  document.getElementById("preview-image").src = data.image;
  document.getElementById("preview-name").textContent = data.name;

  // Handle unknown track counts (e.g. from Spotify oEmbed)
  const trackText =
    data.tracks === "?" || !data.tracks
      ? "Tracks hidden"
      : formatCountLabel(data.tracks, "track");
  document.getElementById("preview-details").textContent = trackText;

  playlistPreview.style.display = "block";
}

// Destination platform change handler
async function handleDestinationPlatformChange(e) {
  state.destinationPlatform = e.target.value;
  clearSpotifyReauthRedirected();
  state.isAuthenticated = false;
  state.isCheckingDestinationAuth = false;
  state.isConnectingDestination = false;
  state.isDisconnectingDestination = false;
  updateAuthStatus(false);
  updateUIState();

  if (state.destinationPlatform) {
    await refreshDestinationAuthState();
  }
}

// Login handler - uses real OAuth for supported platforms
async function handleLogin() {
  const config = platformConfig[state.destinationPlatform];

  // Show loading state
  loginButton.disabled = true;
  loginButton.innerHTML = '<span class="button-icon">⏳</span> Connecting...';

  try {
    // Different auth flows based on platform
    switch (state.destinationPlatform) {
      case "youtube":
      case "youtube-music":
        // Real YouTube OAuth
        const ytResult = await api.getYouTubeAuthUrl();
        if (ytResult.authUrl) {
          window.location.href = ytResult.authUrl;
          return;
        }
        break;

      case "spotify":
        // Real Spotify OAuth
        const spotifyResult = await api.getSpotifyAuthUrl();
        if (spotifyResult.authUrl) {
          window.location.href = spotifyResult.authUrl;
          return;
        }
        break;

      case "amazon-music":
        // Amazon Music OAuth
        const amazonResult = await api.getAmazonMusicAuthUrl();
        if (amazonResult.authUrl) {
          window.location.href = amazonResult.authUrl;
          return;
        }
        break;

      default:
        // Simulated login for unsupported platforms
        state.isAuthenticated = true;
        updateAuthStatus(true);
        loginButton.innerHTML = `<span class="button-icon">✓</span> Logged in to ${config.name}`;
        showNotification(`Logged in to ${config.name} (simulated)`, "success");
        updateUIState();
        return;
    }

    throw new Error("OAuth not configured for this platform");
  } catch (error) {
    console.error("Login error:", error);
    showNotification(
      error.message || "Login failed. Please try again.",
      "error",
    );
    loginButton.disabled = false;
    loginButton.innerHTML = "CONNECT ACCOUNT";
  }
}

// Update authentication status display
function updateAuthStatus(authenticated) {
  if (authenticated) {
    authStatus.classList.add("authenticated");
    authStatus.innerHTML = `
            <div class="auth-prompt">
                <span class="auth-icon">✅</span>
                <p>Authenticated and ready to create playlist</p>
            </div>
        `;
  } else {
    authStatus.classList.remove("authenticated");
    authStatus.innerHTML = `
            <div class="auth-prompt">
                <span class="auth-icon">🔐</span>
                <p>Connect the selected platform to create the playlist</p>
            </div>
        `;
  }
}

// Transfer handler
async function handleTransfer() {
  if (!state.playlistData || !state.destinationPlatform) {
    showNotification(
      "Please fetch a playlist and select a destination",
      "error",
    );
    return;
  }

  // Hide any previous results
  successSection.style.display = "none";

  // Show progress section
  progressSection.style.display = "flex";
  transferButton.disabled = true;
  transferButton.textContent = "Transferring...";
  let eventSource = null;

  try {
    const transferId =
      Date.now().toString() + Math.random().toString(36).substring(7);
    const sourcePlat = state.playlistData.platform || state.sourcePlatform;

    // Reset progress UI
    const progressFill = document.getElementById("progress-fill");
    const progressMessage = document.getElementById("progress-message");
    const progressPercentage = document.getElementById("progress-percentage");

    progressFill.style.width = "0%";
    progressMessage.textContent = "Initializing transfer...";
    progressPercentage.textContent = "0%";

    // Setup SSE for real-time progress
    eventSource = new EventSource(
      `${api.baseURL}/playlist/transfer/progress/${transferId}`,
    );
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.status === "progress" && data.progress) {
          progressFill.style.width = `${data.progress}%`;
          progressPercentage.textContent = `${data.progress}%`;
          if (data.message) {
            progressMessage.textContent = data.message;
          }
        }
      } catch (err) {
        console.error("Error parsing progress data", err);
      }
    };

    let appleMusicToken = null;
    if (state.destinationPlatform === "apple-music") {
       try {
         appleMusicToken = window.MusicKit.getInstance().musicUserToken;
       } catch (e) {
         console.warn("Could not retrieve Music User Token");
       }
    }

    // Start the real transfer
    const result = await api.transferPlaylist({
      sourcePlatform: sourcePlat,
      sourcePlaylistId: state.playlistData.id,
      destinationPlatform:
        state.destinationPlatform === "youtube-music"
          ? "youtube"
          : state.destinationPlatform,
      playlistName: state.playlistData.name,
      playlistDescription:
        state.playlistData.description || "Transferred with Plansfer",
      isPublicSpotify: sourcePlat === "spotify",
      originalUrl: state.playlistUrl,
      transferId: transferId,
      appleMusicToken: appleMusicToken,
    });

    // Update progress to 100%
    clearSpotifyReauthRedirected();
    progressFill.style.width = "100%";
    progressMessage.textContent = "Transfer complete!";
    progressPercentage.textContent = "100%";

    // Show success after brief delay
    setTimeout(() => {
      progressSection.style.display = "none";
      showSuccess(result);
    }, 500);
  } catch (error) {
    console.error("Transfer error:", error);
    progressSection.style.display = "none";

    const isSpotifyReauthRequired =
      error.message === "SPOTIFY_REAUTH_REQUIRED" ||
      error?.data?.error?.code === "SPOTIFY_REAUTH_REQUIRED";

    if (isSpotifyReauthRequired) {
      // Mark destination auth stale so reconnect is always available immediately.
      state.isAuthenticated = false;
      updateAuthStatus(false);
      transferButton.disabled = false;
      transferButton.textContent = "START TRANSFER";
      updateUIState();

      if (hasSpotifyReauthRedirected()) {
        showNotification(
          formatSpotifyReauthFailureMessage(error),
          "error",
        );
        updateUIState();
        return;
      }

      markSpotifyReauthRedirected();
      updateUIState();
      showNotification(
        "Spotify requires additional permissions to create your playlist. Redirecting...",
        "info",
      );
      setTimeout(async () => {
        try {
          const response = await api.getSpotifyAuthUrl();
          if (response && response.authUrl) {
            window.location.href = response.authUrl;
          }
        } catch (err) {
          showNotification("Failed to redirect to Spotify", "error");
          updateUIState();
        }
      }, 2000);
      return;
    }

    if (error?.code === "NETWORK_ERROR") {
      showNotification(
        "Transfer was interrupted due to a network disconnect. Please retry once.",
        "error",
      );
      transferButton.disabled = false;
      transferButton.textContent = "START TRANSFER";
      updateUIState();
      return;
    }

    if (error?.code === "REQUEST_TIMEOUT") {
      showNotification(
        "Transfer took too long and timed out. Please reconnect Spotify and retry.",
        "error",
      );
      transferButton.disabled = false;
      transferButton.textContent = "START TRANSFER";
      updateUIState();
      return;
    }

    const unmatchedCount = Array.isArray(error?.data?.unmatchedTracks)
      ? error.data.unmatchedTracks.length
      : 0;
    if (unmatchedCount > 0) {
      console.warn("Skipped/Untransferred tracks:", error.data.unmatchedTracks);
      showNotification(
        `${error.message || "Transfer failed"} (${formatCountLabel(unmatchedCount, "track")} skipped)`,
        "error",
      );
    } else {
      showNotification(
        error.message || "Transfer failed. Please try again.",
        "error",
      );
    }
    transferButton.disabled = false;
    transferButton.textContent = "START TRANSFER";
    updateUIState();
  } finally {
    if (eventSource) {
      eventSource.close();
    }
  }
}

// Simulate transfer progress
async function simulateTransfer() {
  const totalTracks = state.playlistData.tracks;
  const progressFill = document.getElementById("progress-fill");
  const progressMessage = document.getElementById("progress-message");
  const progressTracks = document.getElementById("progress-tracks");
  const progressPercentage = document.getElementById("progress-percentage");

  const steps = [
    { message: "Analyzing playlist...", progress: 10 },
    { message: "Fetching track information...", progress: 30 },
    {
      message: "Searching for tracks on destination platform...",
      progress: 60,
    },
    { message: "Creating playlist...", progress: 80 },
    { message: "Adding tracks...", progress: 95 },
    { message: "Finalizing...", progress: 100 },
  ];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    progressMessage.textContent = step.message;
    progressFill.style.width = step.progress + "%";
    progressPercentage.textContent = step.progress + "%";

    const tracksProcessed = Math.floor((step.progress / 100) * totalTracks);
    progressTracks.textContent = `${tracksProcessed}/${totalTracks} tracks processed`;

    await sleep(800);
  }

  // Show success
  setTimeout(() => {
    progressSection.style.display = "none";
    showSuccess();
  }, 500);
}

// Show success message
function showSuccess(result) {
  const config = platformConfig[state.destinationPlatform];
  const playlistName = result?.playlist?.name || state.playlistData.name;
  const playlistUrl = result?.playlist?.url || "#";
  const unmatched = Array.isArray(result?.unmatchedTracks)
    ? result.unmatchedTracks
    : [];

  if (unmatched.length > 0) {
    document.getElementById("success-message").textContent =
      `Your playlist "${playlistName}" was transferred to ${config.name} with ${formatCountLabel(unmatched.length, "skipped track")}.`;
  } else {
    document.getElementById("success-message").textContent =
      `Your playlist "${playlistName}" has been successfully transferred to ${config.name}`;
  }

  const successLink = document.getElementById("success-link");
  const hasValidPlaylistUrl =
    typeof playlistUrl === "string" && /^https?:\/\//i.test(playlistUrl);
  successLink.href = hasValidPlaylistUrl ? playlistUrl : "#";
  successLink.textContent = hasValidPlaylistUrl
    ? "View Playlist"
    : "Playlist Link Unavailable";
  successLink.style.pointerEvents = hasValidPlaylistUrl ? "auto" : "none";
  successLink.style.opacity = hasValidPlaylistUrl ? "1" : "0.65";
  successLink.onclick = (e) => {
    e.preventDefault();
    if (!hasValidPlaylistUrl) return;
    window.open(playlistUrl, "_blank", "noopener,noreferrer");
  };

  const modal = successSection.querySelector(".success-modal");
  let unmatchedBlock = document.getElementById("success-unmatched");
  if (unmatchedBlock) {
    unmatchedBlock.remove();
  }

  if (unmatched.length > 0 && modal) {
    const maxToShow = 10;
    const shown = unmatched.slice(0, maxToShow);
    const extra = unmatched.length - shown.length;

    unmatchedBlock = document.createElement("div");
    unmatchedBlock.id = "success-unmatched";
    unmatchedBlock.className = "success-unmatched";
    unmatchedBlock.innerHTML = `
            <p class="success-unmatched-title">Skipped ${unmatched.length === 1 ? "track" : "tracks"} (${unmatched.length}):</p>
            <div class="success-unmatched-box">
                <ul class="success-unmatched-list">
                    ${shown
                      .map(
                        (t) =>
                          `<li>${String(t).replace(
                            /[&<>"']/g,
                            (c) =>
                              ({
                                "&": "&amp;",
                                "<": "&lt;",
                                ">": "&gt;",
                                '"': "&quot;",
                                "'": "&#39;",
                              })[c],
                          )}</li>`,
                      )
                      .join("")}
                </ul>
                ${extra > 0 ? `<p class="success-unmatched-more">...and ${extra} more</p>` : ""}
            </div>
        `;
    modal.insertBefore(unmatchedBlock, successLink);
  }

  successSection.style.display = "flex";

  // Scroll to success section
  successSection.scrollIntoView({ behavior: "smooth", block: "center" });

  // Reset transfer button
  transferButton.disabled = false;
  transferButton.textContent = "START TRANSFER";

  // Save to History
  saveTransferHistory(playlistName, config.name);
}

// Save History
function saveTransferHistory(playlistName, destination) {
  const history = JSON.parse(
    localStorage.getItem("musikTransferHistory") || "[]",
  );
  const newEntry = {
    playlist: playlistName,
    to: destination,
    date: new Date().toLocaleDateString(),
  };

  history.unshift(newEntry); // Add to top
  if (history.length > 5) history.pop(); // Keep last 5

  localStorage.setItem("musikTransferHistory", JSON.stringify(history));
  renderHistory();
}

// Render History
function renderHistory() {
  // Check if history container exists, if not create it
  let historyContainer = document.getElementById("recent-history");
  if (!historyContainer) {
    // Inject into dashboard
    const dashboard = document.querySelector(".transfer-dashboard .container");
    if (!dashboard) return; // Exit if no dashboard found (e.g. AI page)

    historyContainer = document.createElement("div");
    historyContainer.id = "recent-history";
    historyContainer.className = "history-section";
    // Insert after header
    dashboard.insertBefore(historyContainer, dashboard.children[1]);
  }

  const history = JSON.parse(
    localStorage.getItem("musikTransferHistory") || "[]",
  );

  if (history.length === 0) {
    historyContainer.style.display = "none";
    return;
  }

  historyContainer.style.display = "block";
  historyContainer.innerHTML = `
        <h3>Recent Transfers</h3>
        <div class="history-grid">
            ${history
              .map(
                (item) => `
                <div class="history-item">
                    <span class="h-icon">✅</span>
                    <div class="h-info">
                        <strong>${item.playlist}</strong>
                        <span>to ${item.to} • ${item.date}</span>
                    </div>
                </div>
            `,
              )
              .join("")}
        </div>
    `;
}

// Update UI state based on current state
function updateUIState() {
  // Save state to session storage so it survives OAuth redirects
  saveSessionState();

  // Fetch button state
  if (fetchPlaylistButton) {
    fetchPlaylistButton.disabled = !(
      state.sourcePlatform &&
      state.playlistUrl &&
      isValidUrl(state.playlistUrl, state.sourcePlatform)
    );
  }

  // Login button state
  updateLoginButtonState();

  // Transfer button state
  if (transferButton) {
    transferButton.disabled = !(
      state.playlistData &&
      state.destinationPlatform &&
      state.isAuthenticated
    );
  }
}

// Utility: Show notification
function showNotification(message, type = "info") {
  // Route errors to the centered dialog
  if (type === "error") {
    showErrorDialog(message);
    return;
  }

  // Toast notification for success / info
  const notification = document.createElement("div");
  notification.className = `notification notification-${type}`;
  notification.textContent = message;

  document.body.appendChild(notification);

  // Remove after 3 seconds
  setTimeout(() => {
    notification.style.animation = "slideOut 0.3s ease";
    setTimeout(() => {
      document.body.removeChild(notification);
    }, 300);
  }, 3000);
}

// Utility: Show centered error dialog
function showErrorDialog(message) {
  const overlay = document.getElementById("error-dialog");
  const msgEl = document.getElementById("error-dialog-message");
  const closeBtn = document.getElementById("error-dialog-close");

  if (!overlay || !msgEl) return;

  msgEl.textContent = message;
  overlay.style.display = "flex";
  document.body.style.overflow = "hidden";

  // Close handler (remove old listeners to avoid stacking)
  const closeDialog = () => {
    overlay.style.display = "none";
    document.body.style.overflow = "auto";
  };

  closeBtn.onclick = closeDialog;
  overlay.onclick = (e) => {
    if (e.target === overlay) closeDialog();
  };
}

// Utility: Sleep function
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Handle Feature Navigation
window.handleFeatureNavigation = function (event, url) {
  if (event) event.preventDefault();

  // Check if authenticated
  const user = localStorage.getItem("musikTransferUser");

  if (user) {
    window.location.href = url;
  } else {
    // Show auth modal
    const authModal = document.getElementById("auth-modal");
    if (authModal) authModal.style.display = "flex";
    showNotification("Please login to access features", "info");
  }
};

// Initialize on page load
document.addEventListener("DOMContentLoaded", init);
