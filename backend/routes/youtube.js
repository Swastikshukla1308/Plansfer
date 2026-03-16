const express = require("express");
const router = express.Router();
const axios = require("axios");
const authMiddleware = require("../middleware/auth");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3";

// Scopes needed for playlist management
// NOTE: youtube.force-ssl provides full read/write access to YouTube.
// We avoid the 'youtube' scope because it's classified as RESTRICTED by Google,
// which blocks unverified apps even for test users.
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
].join(" ");

// Get YouTube authorization URL
router.get("/auth", authMiddleware, (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: req.userId.toString(),
  });

  res.json({
    authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
  });
});

// YouTube OAuth callback
router.get("/callback", async (req, res) => {
  const { code, state: userId } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5001";

  if (!code) {
    return res.redirect(`${frontendUrl}?error=youtube_auth_failed`);
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await axios.post(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Store tokens for the user
    const User = require("../models/User");
    const user = await User.findById(userId);

    if (user) {
      user.connectPlatform("youtube", {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + expires_in * 1000,
      });
    }

    res.redirect(`${frontendUrl}?youtube_connected=true`);
  } catch (error) {
    console.error(
      "YouTube callback error:",
      error.response?.data || error.message,
    );
    res.redirect(`${frontendUrl}?error=youtube_auth_failed`);
  }
});

// Refresh YouTube access token
async function refreshYouTubeToken(refreshToken) {
  const response = await axios.post(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    },
  );

  return {
    accessToken: response.data.access_token,
    expiresAt: Date.now() + response.data.expires_in * 1000,
  };
}

// Get YouTube access token (with auto-refresh)
async function getYouTubeAccessToken(user) {
  const tokens = user.getPlatformTokens("youtube");

  if (!tokens) {
    throw new Error("YouTube not connected");
  }

  // Check if token is expired or about to expire (5 min buffer)
  if (tokens.expiresAt < Date.now() + 300000) {
    try {
      const newTokens = await refreshYouTubeToken(tokens.refreshToken);
      user.connectPlatform("youtube", {
        ...tokens,
        accessToken: newTokens.accessToken,
        expiresAt: newTokens.expiresAt,
      });
      return newTokens.accessToken;
    } catch (error) {
      console.error("Token refresh error:", error);
      throw new Error("Failed to refresh YouTube token");
    }
  }

  return tokens.accessToken;
}

// Get playlist details
router.get("/playlist/:playlistId", authMiddleware, async (req, res) => {
  try {
    const { playlistId } = req.params;
    const accessToken = await getYouTubeAccessToken(req.user);

    const response = await axios.get(`${YOUTUBE_API_URL}/playlists`, {
      params: {
        part: "snippet,contentDetails",
        id: playlistId,
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.data.items || response.data.items.length === 0) {
      return res.status(404).json({
        error: {
          message: "Playlist not found",
          status: 404,
        },
      });
    }

    const playlist = response.data.items[0];

    res.json({
      playlist: {
        id: playlist.id,
        name: playlist.snippet.title,
        description: playlist.snippet.description,
        image:
          playlist.snippet.thumbnails?.high?.url ||
          playlist.snippet.thumbnails?.default?.url,
        tracks: playlist.contentDetails.itemCount,
        channelTitle: playlist.snippet.channelTitle,
        platform: "youtube",
      },
    });
  } catch (error) {
    console.error("Get playlist error:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message:
          error.response?.data?.error?.message || "Failed to fetch playlist",
        status: error.response?.status || 500,
      },
    });
  }
});

// Get playlist tracks (videos)
router.get("/playlist/:playlistId/tracks", authMiddleware, async (req, res) => {
  try {
    const { playlistId } = req.params;
    const accessToken = await getYouTubeAccessToken(req.user);

    const tracks = [];
    let pageToken = null;

    do {
      const response = await axios.get(`${YOUTUBE_API_URL}/playlistItems`, {
        params: {
          part: "snippet,contentDetails",
          playlistId: playlistId,
          maxResults: 50,
          pageToken: pageToken,
        },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const items = response.data.items.map((item) => ({
        id: item.contentDetails.videoId,
        name: item.snippet.title,
        artist: item.snippet.videoOwnerChannelTitle || "Unknown",
        thumbnail: item.snippet.thumbnails?.default?.url,
        position: item.snippet.position,
        youtubeId: item.contentDetails.videoId,
      }));

      tracks.push(...items);
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    res.json({ tracks });
  } catch (error) {
    console.error("Get tracks error:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message:
          error.response?.data?.error?.message || "Failed to fetch tracks",
        status: error.response?.status || 500,
      },
    });
  }
});

// Create playlist
router.post("/playlist", authMiddleware, async (req, res) => {
  try {
    const { name, description, isPublic = false } = req.body;
    const accessToken = await getYouTubeAccessToken(req.user);

    const response = await axios.post(
      `${YOUTUBE_API_URL}/playlists`,
      {
        snippet: {
          title: name,
          description: description || "Created with Plansfer",
        },
        status: {
          privacyStatus: isPublic ? "public" : "private",
        },
      },
      {
        params: { part: "snippet,status" },
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    res.json({
      playlist: {
        id: response.data.id,
        name: response.data.snippet.title,
        url: `https://www.youtube.com/playlist?list=${response.data.id}`,
      },
    });
  } catch (error) {
    console.error(
      "Create playlist error:",
      error.response?.data || error.message,
    );
    res.status(error.response?.status || 500).json({
      error: {
        message:
          error.response?.data?.error?.message || "Failed to create playlist",
        status: error.response?.status || 500,
      },
    });
  }
});

// Add videos to playlist
router.post(
  "/playlist/:playlistId/tracks",
  authMiddleware,
  async (req, res) => {
    try {
      const { playlistId } = req.params;
      const { videoIds } = req.body;
      const accessToken = await getYouTubeAccessToken(req.user);

      if (!Array.isArray(videoIds) || videoIds.length === 0) {
        return res.status(400).json({
          error: {
            message: "videoIds must be a non-empty array",
            status: 400,
          },
        });
      }

      const seen = new Set();
      const uniqueVideoIds = [];
      let skippedDuplicates = 0;
      for (const videoId of videoIds) {
        if (typeof videoId !== "string" || !videoId.trim()) continue;
        const key = videoId.trim();
        if (seen.has(key)) {
          skippedDuplicates++;
          continue;
        }
        seen.add(key);
        uniqueVideoIds.push(key);
      }

      let added = 0;
      const errors = [];

      // Add videos one by one (YouTube API limitation)
      for (const videoId of uniqueVideoIds) {
        try {
          await axios.post(
            `${YOUTUBE_API_URL}/playlistItems`,
            {
              snippet: {
                playlistId: playlistId,
                resourceId: {
                  kind: "youtube#video",
                  videoId: videoId,
                },
              },
            },
            {
              params: { part: "snippet" },
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            },
          );
          added++;
        } catch (err) {
          errors.push({
            videoId,
            error: err.response?.data?.error?.message || err.message,
          });
        }
      }

      res.json({
        added,
        total: uniqueVideoIds.length,
        skippedDuplicates,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error) {
      console.error("Add videos error:", error.response?.data || error.message);
      res.status(error.response?.status || 500).json({
        error: {
          message:
            error.response?.data?.error?.message || "Failed to add videos",
          status: error.response?.status || 500,
        },
      });
    }
  },
);

// Check connection status
router.get("/status", authMiddleware, (req, res) => {
  const isConnected = req.user.isPlatformConnected("youtube");
  res.json({
    connected: isConnected,
    platform: "youtube",
  });
});

router.post("/disconnect", authMiddleware, async (req, res) => {
  try {
    await req.user.disconnectPlatform("youtube");
    res.json({
      message: "YouTube disconnected successfully",
    });
  } catch (error) {
    console.error("YouTube disconnect error:", error);
    res.status(500).json({
      error: {
        message: "Failed to disconnect YouTube",
        status: 500,
      },
    });
  }
});

module.exports = router;
module.exports.getYouTubeAccessToken = getYouTubeAccessToken;
