const express = require("express");
const router = express.Router();
const axios = require("axios");
const authMiddleware = require("../middleware/auth");
const optionalAuthMiddleware = require("../middleware/optionalAuth");
const { getYouTubeAccessToken } = require("./youtube");
const { getSpotifyAccessToken } = require("./spotify");

// ─── Shared helpers ──────────────────────────────────────────────────────────

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SPOTIFY_WRITE_TIMEOUT_MS = 15000;

const getSpotifyErrorMessage = (error) =>
  (
    error?.response?.data?.error?.message ||
    error?.response?.data?.error_description ||
    error?.message ||
    ""
  ).toString();

const isSpotifyAuthOrScopeError = ({ status, message }) => {
  const normalizedMessage = (message || "").toLowerCase();
  if (status === 401) return true;
  if (status !== 403) return false;

  return (
    normalizedMessage.includes("insufficient client scope") ||
    normalizedMessage.includes("insufficient scope") ||
    normalizedMessage.includes("missing scope") ||
    normalizedMessage.includes("invalid access token") ||
    normalizedMessage.includes("invalid token") ||
    normalizedMessage.includes("token expired") ||
    normalizedMessage.includes("access token expired") ||
    normalizedMessage.includes("authentication token")
  );
};

const isSpotifyPolicyRestrictionError = ({ status, message }) => {
  if (status !== 403) return false;
  const normalizedMessage = (message || "").toLowerCase();
  return (
    normalizedMessage.includes("not registered") ||
    normalizedMessage.includes("developer portal") ||
    normalizedMessage.includes("premium required") ||
    normalizedMessage.includes("spotify premium")
  );
};

const SPOTIFY_DESTINATION_REQUIRED_SCOPES = ["playlist-modify-private"];

const normalizeSpotifyScopes = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return [...new Set(value.map((scope) => String(scope || "").trim()).filter(Boolean))];
  }
  return [...new Set(String(value).split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
};

const getSpotifyScopeStatus = (tokenInfo, requiredScopes = []) => {
  const available = normalizeSpotifyScopes(tokenInfo?.scopes);
  return {
    checked: available.length > 0,
    available,
    required: [...requiredScopes],
    missing: requiredScopes.filter((scope) => !available.includes(scope)),
  };
};

const isSpotifyScopeMissing = (scopeStatus) =>
  !!scopeStatus?.checked &&
  Array.isArray(scopeStatus?.missing) &&
  scopeStatus.missing.length > 0;

const buildSpotifyScopeReason = (scopeStatus) => {
  if (!isSpotifyScopeMissing(scopeStatus)) return null;
  return `Spotify token is missing required scope(s): ${scopeStatus.missing.join(", ")}`;
};

const attachSpotifyDiagnostics = (error, tokenInfo, scopeStatus, providerReason) => {
  if (!error) return error;
  if (tokenInfo?.source) {
    error.spotifyTokenSource = tokenInfo.source;
  }
  if (scopeStatus) {
    error.spotifyScopeStatus = scopeStatus;
  }
  if (providerReason) {
    error.spotifyProviderReason = providerReason;
  }
  return error;
};

const getSpotifyPlaylistEntryTrack = (entry) => {
  const track = entry?.item || entry?.track || null;
  if (!track) return null;
  if (track.type && track.type !== "track") return null;
  return track;
};

// POST to the Spotify Web API with automatic 429 (rate-limit) retry.
// After the many search calls made during the matching phase, Spotify can
// rate-limit write operations (create playlist, add tracks).  This helper
// respects the Retry-After header and retries up to maxAttempts times so
// that a transient rate-limit never silently swallows an entire transfer.
const spotifyPost = async (url, data, config, maxAttempts = 5) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const requestConfig = {
        timeout: SPOTIFY_WRITE_TIMEOUT_MS,
        ...(config || {}),
      };
      return await axios.post(url, data, requestConfig);
    } catch (err) {
      const status = err.response?.status;
      // Retry on 429 (rate-limit), 502 (Bad Gateway), 503 (Service Unavailable)
      const isRetryable = status === 429 || status === 502 || status === 503;
      if (isRetryable && attempt < maxAttempts) {
        const retryAfter =
          status === 429
            ? Number(err.response.headers?.["retry-after"]) || attempt * 2
            : attempt * 1.5;
        console.warn(
          `[Spotify] HTTP ${status}. Retrying in ${retryAfter}s ` +
            `(attempt ${attempt}/${maxAttempts - 1}) — ${url}`,
        );
        await wait(retryAfter * 1000);
        continue;
      }
      throw err;
    }
  }
};

// SSE clients map to send real-time progress updates
const transferClients = new Map();

// Establish SSE connection for progress tracking
router.get("/transfer/progress/:id", (req, res) => {
  const { id } = req.params;

  // Set headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Check if client is already connected and remove
  if (transferClients.has(id)) {
    transferClients.delete(id);
  }

  transferClients.set(id, res);

  // Send a preliminary connection message
  res.write(
    `data: ${JSON.stringify({ status: "connected", message: "Ready to transfer" })}\n\n`,
  );

  req.on("close", () => {
    transferClients.delete(id);
  });
});

// Helper to send progress updates to a specific client
const sendProgress = (transferId, data) => {
  if (transferId && transferClients.has(transferId)) {
    const client = transferClients.get(transferId);
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
};

// Normalize different Spotify match shapes into a valid track URI
const toSpotifyTrackUri = (match) => {
  if (!match) return null;

  if (
    typeof match.spotifyUri === "string" &&
    match.spotifyUri.startsWith("spotify:track:")
  ) {
    return match.spotifyUri;
  }

  if (typeof match.uri === "string" && match.uri.startsWith("spotify:track:")) {
    return match.uri;
  }

  if (typeof match.id === "string" && match.id.trim()) {
    return `spotify:track:${match.id.trim()}`;
  }

  const spotifyUrl = match.externalUrl || match.external_urls?.spotify;
  if (typeof spotifyUrl === "string") {
    const urlMatch = spotifyUrl.match(/track\/([a-zA-Z0-9]+)/);
    if (urlMatch) return `spotify:track:${urlMatch[1]}`;
  }

  return null;
};

const formatTrackLabel = (track) => {
  if (!track) return "Unknown Track";
  const name = track.name || track.title || "Unknown Track";
  const artist = track.artist || track.artists || "";
  return artist ? `${name} - ${artist}` : name;
};

const mergeUniqueTrackLabels = (...lists) => {
  return [...new Set(lists.flat().filter(Boolean))];
};

const dedupeByKey = (items, getKey) => {
  const seen = new Set();
  const unique = [];
  const duplicates = [];

  for (const item of items || []) {
    const key = getKey(item);
    if (!key) {
      unique.push(item);
      continue;
    }
    if (seen.has(key)) {
      duplicates.push(item);
      continue;
    }
    seen.add(key);
    unique.push(item);
  }

  return { unique, duplicates };
};

const normalizeSpotifyTrackUri = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("spotify:track:")) {
    // Ensure there is an actual track ID after the prefix, not just the bare prefix
    const trackId = trimmed.slice("spotify:track:".length).trim();
    return trackId.length > 0 ? `spotify:track:${trackId}` : null;
  }

  const urlMatch = trimmed.match(/spotify\.com\/track\/([a-zA-Z0-9]+)/);
  if (urlMatch) {
    return `spotify:track:${urlMatch[1]}`;
  }

  if (/^[a-zA-Z0-9]{22}$/.test(trimmed)) {
    return `spotify:track:${trimmed}`;
  }

  return null;
};

const addTracksToSpotifyPlaylist = async ({
  accessToken,
  playlistId,
  uris,
  candidates,
}) => {
  const rawCandidates =
    candidates && candidates.length > 0
      ? candidates
      : (uris || []).map((uri) => ({ uri }));

  const failedTracks = [];
  let added = 0;
  const preparedCandidates = rawCandidates
    .map((candidate) => {
      const source =
        typeof candidate === "string" ? { uri: candidate } : candidate;
      const normalizedUri = normalizeSpotifyTrackUri(
        source.uri || source.spotifyUri || source.id || source.externalUrl,
      );
      if (!normalizedUri) {
        failedTracks.push({
          name: source.name || source.title || source.uri || "Unknown Track",
          artist: source.artist || "",
          reason: "invalid_uri",
        });
        return null;
      }
      return {
        uri: normalizedUri,
        name: source.name || source.title || source.uri || normalizedUri,
        artist: source.artist || "",
        reason: null,
      };
    })
    .filter(Boolean);

  const { unique: dedupedCandidates, duplicates: duplicateCandidates } =
    dedupeByKey(preparedCandidates, (candidate) => candidate.uri);
  for (const duplicate of duplicateCandidates) {
    failedTracks.push({
      name: duplicate.name,
      artist: duplicate.artist || "",
      reason: "duplicate_uri",
    });
  }

  if (dedupedCandidates.length === 0) {
    return {
      requested: rawCandidates.length,
      added: 0,
      failed: failedTracks.length,
      failedTracks,
    };
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  // Track the first Spotify error for surfacing in the API response so the
  // caller can show a meaningful message instead of a generic failure.
  let firstSpotifyError = null;
  const recordSpotifyError = (err) => {
    if (!firstSpotifyError) {
      firstSpotifyError = {
        status: err.response?.status,
        message: err.response?.data?.error?.message || err.message || "unknown",
      };
    }
  };

  // Abort only for true auth/scope problems (reauth may fix) and account-level
  // policy restrictions (allowlist / premium), but keep track-level 403s in the
  // fallback flow so we can continue transferring the rest of the playlist.
  const shouldAbortAddFlow = (err) => {
    const status = err.response?.status;
    const message = getSpotifyErrorMessage(err);
    return (
      isSpotifyAuthOrScopeError({ status, message }) ||
      isSpotifyPolicyRestrictionError({ status, message })
    );
  };

  // Spotify allows max 100 tracks per request.
  // spotifyPost() automatically retries on 429 (rate-limit) with backoff so
  // that rate-limiting during the post-matching write phase never causes all
  // tracks to fail silently.
  const addItemsEndpoint = `https://api.spotify.com/v1/playlists/${playlistId}/items`;

  for (let i = 0; i < dedupedCandidates.length; i += 100) {
    const batchCandidates = dedupedCandidates.slice(i, i + 100);
    const batchUris = batchCandidates.map((c) => c.uri);
    try {
      await spotifyPost(addItemsEndpoint, { uris: batchUris }, { headers });
      added += batchCandidates.length;
    } catch (bodyErr) {
      if (shouldAbortAddFlow(bodyErr)) throw bodyErr;
      console.warn(
        `[Spotify] Batch add failed (status ${bodyErr.response?.status}): ` +
          `${bodyErr.response?.data?.error?.message || bodyErr.message}. ` +
          `endpoint=/items body=${JSON.stringify(bodyErr.response?.data || {})}. ` +
          `Trying query-string fallback...`,
      );

      // Fallback: Spotify also accepts `uris` in the query string
      try {
        const params = new URLSearchParams({ uris: batchUris.join(",") });
        await spotifyPost(
          `${addItemsEndpoint}?${params.toString()}`,
          {},
          { headers },
        );
        added += batchCandidates.length;
      } catch (queryErr) {
        if (shouldAbortAddFlow(queryErr)) throw queryErr;
        console.warn(
          `[Spotify] Query-string fallback also failed (status ${queryErr.response?.status}): ` +
            `${queryErr.response?.data?.error?.message || queryErr.message}. ` +
            `endpoint=/items body=${JSON.stringify(queryErr.response?.data || {})}. ` +
            `Falling back to one-by-one add...`,
        );

        // Last resort: add one-by-one so a single bad URI doesn't fail the whole batch
        for (const candidate of batchCandidates) {
          try {
            await spotifyPost(addItemsEndpoint, { uris: [candidate.uri] }, { headers });
            added += 1;
          } catch (singleErr) {
            if (shouldAbortAddFlow(singleErr)) throw singleErr;
            const reason =
              singleErr.response?.data?.error?.message ||
              singleErr.message ||
              "add_failed";
            console.error(
              `[Spotify] Failed to add track "${candidate.name}" (${candidate.uri}): ` +
                `HTTP ${singleErr.response?.status} — ${reason} ` +
                `endpoint=/items body=${JSON.stringify(singleErr.response?.data || {})}`,
            );
            recordSpotifyError(singleErr);
            failedTracks.push({
              name: candidate.name,
              artist: candidate.artist || "",
              reason,
            });
          }
        }
      }
    }
  }

  return {
    requested: rawCandidates.length,
    added,
    failed: failedTracks.length,
    failedTracks,
    firstSpotifyError,
  };
};

const cleanupEmptySpotifyPlaylist = async (accessToken, playlistId) => {
  try {
    await axios.delete(
      `https://api.spotify.com/v1/playlists/${playlistId}/followers`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
  } catch (cleanupErr) {
    console.error(
      "Failed to cleanup empty Spotify playlist:",
      cleanupErr.response?.data || cleanupErr.message,
    );
  }
};

// Platform-specific helpers
const platformHelpers = {
  spotify: {
    extractPlaylistId: (url) => {
      const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
      return match ? match[1] : null;
    },
    apiUrl: "https://api.spotify.com/v1",
  },
  "apple-music": {
    extractPlaylistId: (url) => {
      const match = url.match(/playlist\/([^?]+)/);
      return match ? match[1] : null;
    },
  },
  youtube: {
    extractPlaylistId: (url) => {
      const match = url.match(/[?&]list=([^&]+)/);
      return match ? match[1] : null;
    },
  },
  "youtube-music": {
    extractPlaylistId: (url) => {
      const match = url.match(/[?&]list=([^&]+)/);
      return match ? match[1] : null;
    },
  },
  jiosaavn: {
    extractPlaylistId: (url) => {
      // JioSaavn playlist URLs:
      //   /s/playlist/{hash}/{slug}/{listId}
      //   /featured/{slug}/{listId}
      // The actual playlist ID is always the LAST segment of the URL path
      try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split("/").filter(Boolean);
        // Return the last segment (the playlist ID)
        return pathParts.length > 0 ? pathParts[pathParts.length - 1] : null;
      } catch {
        // Fallback regex approach
        const match = url.match(/\/([^/?]+)(?:\?.*)?$/);
        return match ? match[1] : null;
      }
    },
  },
  "amazon-music": {
    extractPlaylistId: (url) => {
      // Amazon Music playlist URLs: https://music.amazon.com/playlists/B0... or similar
      const match = url.match(/playlists\/([A-Z0-9]+)/i);
      return match ? match[1] : null;
    },
  },
  gaana: {
    extractPlaylistId: (url) => {
      // Gaana playlist URLs: https://gaana.com/playlist/playlist-name-123
      const match = url.match(/playlist\/([^?]+)/);
      return match ? match[1] : null;
    },
  },
};

// Detect platform from URL
router.post("/detect", (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        error: {
          message: "URL is required",
          status: 400,
        },
      });
    }

    let platform = null;
    let playlistId = null;

    if (url.includes("spotify.com")) {
      platform = "spotify";
      playlistId = platformHelpers.spotify.extractPlaylistId(url);
    } else if (url.includes("music.apple.com")) {
      platform = "apple-music";
      playlistId = platformHelpers["apple-music"].extractPlaylistId(url);
    } else if (url.includes("music.youtube.com")) {
      platform = "youtube-music";
      playlistId = platformHelpers["youtube-music"].extractPlaylistId(url);
    } else if (url.includes("youtube.com") || url.includes("youtu.be")) {
      platform = "youtube";
      playlistId = platformHelpers["youtube"].extractPlaylistId(url);
    } else if (url.includes("jiosaavn.com") || url.includes("saavn.com")) {
      platform = "jiosaavn";
      playlistId = platformHelpers["jiosaavn"].extractPlaylistId(url);
    } else if (
      url.includes("music.amazon.com") ||
      url.includes("music.amazon.in") ||
      url.includes("music.amazon.co.uk") ||
      url.includes("music.amazon.de")
    ) {
      platform = "amazon-music";
      playlistId = platformHelpers["amazon-music"].extractPlaylistId(url);
    } else if (url.includes("gaana.com")) {
      platform = "gaana";
      playlistId = platformHelpers["gaana"].extractPlaylistId(url);
    }

    if (!platform || !playlistId) {
      return res.status(400).json({
        error: {
          message: "Invalid or unsupported playlist URL",
          status: 400,
        },
      });
    }

    res.json({
      platform,
      playlistId,
    });
  } catch (error) {
    console.error("Platform detection error:", error);
    res.status(500).json({
      error: {
        message: "Failed to detect platform",
        status: 500,
      },
    });
  }
});

// Fetch playlist from source platform (optional auth — public playlists don't require login)
router.post("/fetch", optionalAuthMiddleware, async (req, res) => {
  try {
    const { platform, playlistId } = req.body;

    if (!platform || !playlistId) {
      return res.status(400).json({
        error: {
          message: "Platform and playlist ID are required",
          status: 400,
        },
      });
    }

    // Currently only Spotify is fully implemented
    if (platform === "spotify") {
      // Try to fetch using user's connected Spotify token first
      const spotifyData = req.user?.getPlatformTokens("spotify");
      let fetchedViaUserToken = false;

      if (spotifyData && spotifyData.accessToken) {
        try {
          const response = await axios.get(
            `https://api.spotify.com/v1/playlists/${playlistId}`,
            {
              headers: {
                Authorization: `Bearer ${spotifyData.accessToken}`,
              },
            },
          );

          return res.json({
            playlist: {
              id: response.data.id,
              name: response.data.name,
              description: response.data.description,
              image: response.data.images[0]?.url,
              tracks:
                response.data.items?.total ??
                response.data.tracks?.total ??
                0,
              owner: response.data.owner.display_name,
              public: response.data.public,
              platform,
            },
          });
        } catch (userTokenError) {
          // User token failed (expired, etc.) — fall through to oEmbed
          console.error(
            "Spotify user token fetch failed, trying oEmbed fallback:",
            userTokenError.response?.status,
            userTokenError.response?.data?.error?.message ||
              userTokenError.message,
          );
        }
      }

      // Fallback: scrape playlist details from Spotify's embed page __NEXT_DATA__
      // This contains full playlist info and works without any API authentication
      try {
        const embedPageResp = await axios.get(
          `https://open.spotify.com/embed/playlist/${playlistId}`,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
          },
        );
        const html = embedPageResp.data;
        const nextDataMatch = html.match(
          /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s,
        );
        if (nextDataMatch) {
          const nextData = JSON.parse(nextDataMatch[1]);
          const entity = nextData?.props?.pageProps?.state?.data?.entity;
          if (entity && entity.trackList) {
            return res.json({
              playlist: {
                id: entity.id || playlistId,
                name: entity.name || entity.title || "Spotify Playlist",
                description: entity.description || "",
                image: entity.coverArt?.sources?.[0]?.url || "",
                tracks: entity.trackList.length,
                owner: entity.subtitle || "Spotify",
                public: true,
                platform,
              },
            });
          }
        }
      } catch (embedScrapeError) {
        console.error(
          "Embed page scraping failed, trying oEmbed:",
          embedScrapeError.message,
        );
      }

      // Final fallback: use Spotify oEmbed API (public, no auth required, limited info)
      try {
        const embedResponse = await axios.get(
          `https://open.spotify.com/oembed?url=https://open.spotify.com/playlist/${playlistId}`,
        );

        return res.json({
          playlist: {
            id: playlistId,
            name: embedResponse.data.title || "Spotify Playlist",
            description: embedResponse.data.description || "",
            image: embedResponse.data.thumbnail_url || "",
            tracks: embedResponse.data.thumbnail_url ? "?" : 0,
            owner: embedResponse.data.author_name || "Spotify",
            public: true,
            platform,
          },
        });
      } catch (embedError) {
        console.error("Spotify oEmbed also failed:", embedError.message);
        return res.status(403).json({
          error: {
            message:
              "Unable to fetch this playlist. It may be private — try connecting your Spotify account.",
            status: 403,
          },
        });
      }
    } else if (platform === "youtube" || platform === "youtube-music") {
      // For YouTube, try multiple approaches for public playlists
      const platformKey = "youtube";
      try {
        let playlistData = null;

        // Approach 1: Try ytpl (no API key / OAuth required)
        try {
          const ytpl = require("ytpl");
          const result = await ytpl(playlistId, { limit: 1 });
          playlistData = {
            id: playlistId,
            name: result.title,
            description: result.description || "",
            image: result.bestThumbnail?.url || result.thumbnails?.[0]?.url,
            tracks: result.estimatedItemCount || result.items?.length || 0,
            owner: result.author?.name || "YouTube",
            public: true,
            platform,
          };
        } catch (ytplError) {
          console.log("ytpl fallback failed:", ytplError.message);
        }

        // Approach 2: Try YouTube Data API v3 if ytpl failed
        if (!playlistData) {
          const youtubeData = req.user?.getPlatformTokens(platformKey);

          const requestParams = {
            part: "snippet,contentDetails",
            id: playlistId,
          };
          const requestHeaders = {};

          if (youtubeData && youtubeData.accessToken) {
            requestHeaders["Authorization"] =
              `Bearer ${youtubeData.accessToken}`;
          } else if (
            process.env.YOUTUBE_API_KEY &&
            process.env.YOUTUBE_API_KEY !== "placeholder"
          ) {
            requestParams.key = process.env.YOUTUBE_API_KEY;
          } else {
            throw new Error(
              "Unable to fetch YouTube playlist. Please connect your YouTube account or set a valid YOUTUBE_API_KEY.",
            );
          }

          const response = await axios.get(
            "https://www.googleapis.com/youtube/v3/playlists",
            {
              params: requestParams,
              headers: requestHeaders,
            },
          );

          if (!response.data.items || response.data.items.length === 0) {
            throw new Error("Playlist not found");
          }

          const playlist = response.data.items[0];
          playlistData = {
            id: playlist.id,
            name: playlist.snippet.title,
            description: playlist.snippet.description,
            image:
              playlist.snippet.thumbnails?.high?.url ||
              playlist.snippet.thumbnails?.default?.url,
            tracks: playlist.contentDetails.itemCount,
            owner: playlist.snippet.channelTitle,
            public: true,
            platform,
          };
        }

        res.json({ playlist: playlistData });
      } catch (error) {
        console.error(
          "YouTube fetch error:",
          error.response?.data || error.message,
        );
        res.status(error.response?.status || 500).json({
          error: {
            message:
              error.response?.data?.error?.message ||
              error.message ||
              "Failed to fetch playlist",
            status: error.response?.status || 500,
          },
        });
      }
    } else if (platform === "jiosaavn") {
      // JioSaavn doesn't require OAuth - fetch directly from our internal API
      try {
        const jiosaavnResponse = await axios.get(
          `http://localhost:${process.env.PORT || 5000}/api/jiosaavn/playlist/${playlistId}`,
        );

        const playlist = jiosaavnResponse.data;

        res.json({
          playlist: {
            id: playlist.id,
            name: playlist.title,
            description: playlist.description || "",
            image: playlist.image,
            tracks: playlist.songCount || playlist.songs?.length || 0,
            owner: playlist.owner || "JioSaavn",
            public: true,
            platform,
          },
        });
      } catch (error) {
        console.error(
          "JioSaavn fetch error:",
          error.response?.data || error.message,
        );
        res.status(error.response?.status || 500).json({
          error: {
            message:
              error.response?.data?.error?.message ||
              "Failed to fetch JioSaavn playlist",
            status: error.response?.status || 500,
          },
        });
      }
    } else if (platform === "apple-music") {
      // Apple Music — scrape the public page for playlist data
      try {
        // Parse the Apple Music URL to get storefront, slug, and playlist ID
        const urlObj = new URL("https://placeholder.com"); // dummy, we use the original URL
        // The playlistId here is the full path or the pl.xxx ID
        // Apple Music URLs: /us/playlist/name/pl.xxx
        // We need the full URL to scrape, so reconstruct it
        const appleUrl =
          req.body.originalUrl ||
          `https://music.apple.com/us/playlist/playlist/${playlistId}`;

        const appleResp = await axios.get(appleUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            Accept: "text/html",
          },
          timeout: 15000,
        });

        const html = appleResp.data;
        const serialized = html.match(
          /id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/,
        );

        if (!serialized) {
          throw new Error("Could not parse Apple Music playlist data");
        }

        const fullData = JSON.parse(serialized[1]);
        const sections = fullData?.data?.[0]?.data?.sections;

        if (!sections || sections.length < 2) {
          throw new Error("Apple Music playlist structure not recognized");
        }

        // Section 0 = playlist metadata
        const playlistName =
          sections[0]?.items?.[0]?.impressionMetrics?.fields?.name ||
          "Apple Music Playlist";

        // Extract description from meta tag
        const descMatch = html.match(
          /<meta[^>]*name="description"[^>]*content="([^"]+)"/,
        );
        const description = descMatch?.[1] || "";

        // Extract artwork from og:image
        const imageMatch = html.match(
          /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/,
        );
        const image = imageMatch?.[1] || "";

        // Section 1 = tracks
        const trackItems = sections[1]?.items || [];

        // Helper to find a value recursively
        function findValue(obj, key, depth = 0) {
          if (depth > 6 || !obj || typeof obj !== "object") return undefined;
          if (obj[key] !== undefined) return obj[key];
          for (const k of Object.keys(obj)) {
            const r = findValue(obj[k], key, depth + 1);
            if (r !== undefined) return r;
          }
          return undefined;
        }

        const songs = trackItems
          .map((item) => {
            const name =
              item.impressionMetrics?.fields?.name || findValue(item, "name");
            const artist = findValue(item, "artistName") || "Unknown Artist";
            const duration = findValue(item, "durationInMillis") || 0;
            return { title: name, artist, duration: parseInt(duration) || 0 };
          })
          .filter((s) => s.title);

        res.json({
          playlist: {
            id: playlistId,
            name: playlistName,
            description,
            image,
            tracks: songs.length,
            owner: "Apple Music",
            public: true,
            platform: "apple-music",
            songs,
          },
        });
      } catch (error) {
        console.error("Apple Music fetch error:", error.message);
        res.status(error.response?.status || 500).json({
          error: {
            message: error.message || "Failed to fetch Apple Music playlist",
            status: error.response?.status || 500,
          },
        });
      }
    } else {
      res.status(501).json({
        error: {
          message: `${platform} integration coming soon`,
          status: 501,
        },
      });
    }
  } catch (error) {
    console.error("Fetch playlist error:", error);
    res.status(500).json({
      error: {
        message: "Failed to fetch playlist",
        status: 500,
      },
    });
  }
});

// Transfer playlist between platforms
router.post("/transfer", optionalAuthMiddleware, async (req, res) => {
  let spotifyDestinationTokenInfo = null;
  let spotifyDestinationScopeStatus = null;

  try {
    const {
      sourcePlatform,
      sourcePlaylistId,
      destinationPlatform,
      playlistName,
      playlistDescription,
      transferId,
    } = req.body;

    if (!sourcePlatform || !sourcePlaylistId || !destinationPlatform) {
      return res.status(400).json({
        error: {
          message: "Source and destination information required",
          status: 400,
        },
      });
    }

    // Check if source platform is connected
    // Check if source platform is connected
    // Skip for JioSaavn (public API), YouTube source (can use API key for public playlists),
    // and Spotify if the playlist is public (though our current copy logic needs tokens to read tracks).
    // Let's modify the requirement: we only strictly need source token if it's a private playlist.
    // However, the current transfer logic for Spotify-to-* explicitly fetches tracks using user tokens.
    // To fix issue #3: We should allow transferring FROM Spotify WITHOUT connecting Spotify context IF the destination is different,
    // because we can fetch the public playlist tracks differently.
    // Actually, our cross-platform transfer logic currently uses `req.user.getPlatformTokens(sourcePlatform)`.
    // We need to bypass the connection check specifically if we're dealing with Spotify cross-transfer and the user doesn't have it connected.

    const canUseApiKey =
      (sourcePlatform === "youtube" || sourcePlatform === "youtube-music") &&
      process.env.YOUTUBE_API_KEY;
    const isPublicSourceExempt =
      sourcePlatform === "spotify" && destinationPlatform !== "spotify";

    if (
      sourcePlatform !== "jiosaavn" &&
      sourcePlatform !== "apple-music" &&
      sourcePlatform !== "ai" &&
      !canUseApiKey &&
      !isPublicSourceExempt &&
      req.user &&
      !req.user.isPlatformConnected(sourcePlatform)
    ) {
      return res.status(403).json({
        error: {
          message: `Please connect your ${sourcePlatform} account to access this playlist`,
          status: 403,
        },
      });
    }

    // Check destination platform connection — also check cookies for Spotify
    const isSpotifyViaCookie =
      destinationPlatform === "spotify" &&
      (req.cookies?.spotify_access_token || req.cookies?.spotify_refresh_token);
    const isDestConnectedViaUser =
      req.user && req.user.isPlatformConnected(destinationPlatform);

    if (!isDestConnectedViaUser && !isSpotifyViaCookie) {
      return res.status(403).json({
        error: {
          message: `Please connect your ${destinationPlatform} account`,
          status: 403,
        },
      });
    }

    // Same-platform transfers (optimized direct copy)
    if (sourcePlatform === "spotify" && destinationPlatform === "spotify") {
      // Get Spotify access token (user model or cookies)
      let spotifyTokenInfo = null;
      try {
        spotifyTokenInfo = await getSpotifyAccessToken(req.user, req, res);
        spotifyDestinationTokenInfo = spotifyTokenInfo;
        spotifyDestinationScopeStatus = getSpotifyScopeStatus(
          spotifyTokenInfo,
          SPOTIFY_DESTINATION_REQUIRED_SCOPES,
        );
        console.info("[Spotify] Same-platform transfer token selected", {
          source: spotifyTokenInfo.source,
          refreshed: spotifyTokenInfo.refreshed,
          connectedAt: spotifyTokenInfo.connectedAt || "unknown",
          scopes: spotifyTokenInfo.scopes || [],
        });
      } catch (err) {
        spotifyTokenInfo = null;
      }

      const spotifyToken = spotifyTokenInfo?.accessToken || null;

      if (!spotifyToken) {
        return res.status(403).json({
          error: {
            message:
              "Spotify access token not found. Please reconnect Spotify.",
            status: 403,
          },
        });
      }

      // Fetch tracks from source playlist
      const tracksResponse = await axios.get(
        `https://api.spotify.com/v1/playlists/${sourcePlaylistId}/items`,
        {
          headers: {
            Authorization: `Bearer ${spotifyToken}`,
          },
          timeout: SPOTIFY_WRITE_TIMEOUT_MS,
        },
      );

      const sourceTracksForCopy = tracksResponse.data.items
        .map((item) => getSpotifyPlaylistEntryTrack(item))
        .filter(Boolean)
        .map((track) => ({
          uri: track.uri,
          name: track.name,
          artist: track.artists.map((a) => a.name).join(", "),
        }));

      sendProgress(transferId, {
        status: "progress",
        message: "Creating new playlist...",
        progress: 50,
      });

      if (isSpotifyScopeMissing(spotifyDestinationScopeStatus)) {
        const scopeReason = buildSpotifyScopeReason(spotifyDestinationScopeStatus);
        const scopeError = new Error(scopeReason);
        scopeError.response = {
          status: 403,
          data: { error: { message: scopeReason } },
        };
        throw attachSpotifyDiagnostics(
          scopeError,
          spotifyDestinationTokenInfo,
          spotifyDestinationScopeStatus,
          scopeReason,
        );
      }

      const runSpotifySamePlatformCreateAndAdd = async (accessToken) => {
        const createResponse = await axios.post(
          `https://api.spotify.com/v1/me/playlists`,
          {
            name: playlistName || "Transferred Playlist",
            description: playlistDescription || "Created with MusiKtransfer",
            public: false,
          },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            timeout: SPOTIFY_WRITE_TIMEOUT_MS,
          },
        );

        const newPlaylistId = createResponse.data.id;

        sendProgress(transferId, {
          status: "progress",
          message: "Adding tracks to new playlist...",
          progress: 70,
        });

        try {
          const addResult = await addTracksToSpotifyPlaylist({
            accessToken,
            playlistId: newPlaylistId,
            candidates: sourceTracksForCopy,
          });
          return { createResponse, newPlaylistId, addResult };
        } catch (addErr) {
          await cleanupEmptySpotifyPlaylist(accessToken, newPlaylistId).catch(() => {});
          throw addErr;
        }
      };

      let createResponse;
      let newPlaylistId;
      let addResult;
      let attemptedForcedRefresh = false;
      let currentSpotifyTokenInfo = spotifyTokenInfo;
      let currentSpotifyAccessToken = spotifyToken;

      while (true) {
        try {
          const runResult = await runSpotifySamePlatformCreateAndAdd(
            currentSpotifyAccessToken,
          );
          createResponse = runResult.createResponse;
          newPlaylistId = runResult.newPlaylistId;
          addResult = runResult.addResult;
          break;
        } catch (spotifyWriteErr) {
          const status = spotifyWriteErr.response?.status;
          const message = getSpotifyErrorMessage(spotifyWriteErr);
          attachSpotifyDiagnostics(
            spotifyWriteErr,
            currentSpotifyTokenInfo,
            spotifyDestinationScopeStatus,
            message || spotifyWriteErr.spotifyProviderReason,
          );
          console.warn("[Spotify] Same-platform write failed", {
            status,
            message,
            source: currentSpotifyTokenInfo?.source || "unknown",
            scopeStatus: spotifyDestinationScopeStatus,
          });

          const shouldRetryWithRefresh =
            !attemptedForcedRefresh &&
            isSpotifyAuthOrScopeError({ status, message });

          if (!shouldRetryWithRefresh) {
            throw spotifyWriteErr;
          }

          attemptedForcedRefresh = true;
          currentSpotifyTokenInfo = await getSpotifyAccessToken(
            req.user,
            req,
            res,
            { forceRefresh: true },
          );
          spotifyDestinationTokenInfo = currentSpotifyTokenInfo;
          spotifyDestinationScopeStatus = getSpotifyScopeStatus(
            currentSpotifyTokenInfo,
            SPOTIFY_DESTINATION_REQUIRED_SCOPES,
          );
          currentSpotifyAccessToken = currentSpotifyTokenInfo.accessToken;
          console.info("[Spotify] Retrying same-platform transfer with refreshed token", {
            source: currentSpotifyTokenInfo.source,
            refreshed: currentSpotifyTokenInfo.refreshed,
            connectedAt: currentSpotifyTokenInfo.connectedAt || "unknown",
            scopeStatus: spotifyDestinationScopeStatus,
          });
        }
      }
      if (sourceTracksForCopy.length > 0 && addResult.added === 0) {
        const failedTracks = addResult.failedTracks.map(formatTrackLabel);
        await cleanupEmptySpotifyPlaylist(currentSpotifyAccessToken, newPlaylistId);
        return res.status(400).json({
          error: {
            message:
              "Transfer failed: none of the source tracks could be copied to Spotify.",
            status: 400,
          },
          unmatchedTracks: failedTracks,
          failedToTransferTracks: failedTracks,
          totalSource: sourceTracksForCopy.length,
          totalMatched: 0,
          totalUnmatched: failedTracks.length,
        });
      }

      res.json({
        success: true,
        message: "Playlist transferred successfully",
        playlist: {
          id: newPlaylistId,
          name: createResponse.data.name,
          url: createResponse.data.external_urls.spotify,
          tracks: addResult.added,
        },
        unmatchedTracks: addResult.failedTracks.map(formatTrackLabel),
        totalSource: sourceTracksForCopy.length,
        totalMatched: sourceTracksForCopy.length - addResult.failed,
        totalUnmatched: addResult.failed,
      });
    } else if (
      (sourcePlatform === "youtube" || sourcePlatform === "youtube-music") &&
      (destinationPlatform === "youtube" ||
        destinationPlatform === "youtube-music")
    ) {
      // YouTube to YouTube transfer
      let sourceTokens = null;
      if (req.user && req.user.isPlatformConnected("youtube")) {
        const ytAccess = await getYouTubeAccessToken(req.user);
        sourceTokens = { accessToken: ytAccess };
      } else {
        sourceTokens = req.user?.getPlatformTokens("youtube");
      }

      // Fetch tracks from source playlist
      let allTracks = [];
      let pageToken = null;

      do {
        const tracksResponse = await axios.get(
          "https://www.googleapis.com/youtube/v3/playlistItems",
          {
            params: {
              part: "snippet,contentDetails",
              playlistId: sourcePlaylistId,
              maxResults: 50,
              pageToken: pageToken,
            },
            headers: {
              Authorization: `Bearer ${sourceTokens.accessToken}`,
            },
          },
        );

        allTracks.push(...tracksResponse.data.items);
        pageToken = tracksResponse.data.nextPageToken;
      } while (pageToken);

      const videoCandidates = allTracks
        .filter((item) => item.contentDetails?.videoId)
        .map((item) => ({
          videoId: item.contentDetails.videoId,
          label: formatTrackLabel({
            name: item.snippet?.title || item.contentDetails.videoId,
            artist: item.snippet?.videoOwnerChannelTitle || "",
          }),
        }));

      const {
        unique: uniqueVideoCandidates,
        duplicates: duplicateVideoCandidates,
      } = dedupeByKey(videoCandidates, (candidate) => candidate.videoId);

      // Create new playlist
      const createResponse = await axios.post(
        "https://www.googleapis.com/youtube/v3/playlists",
        {
          snippet: {
            title: playlistName || "Transferred Playlist",
            description: playlistDescription || "Created with Plansfer",
          },
          status: {
            privacyStatus: "private",
          },
        },
        {
          params: { part: "snippet,status" },
          headers: {
            Authorization: `Bearer ${sourceTokens.accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );

      const newPlaylistId = createResponse.data.id;

      // Add videos to new playlist
      let addedCount = 0;
      const failedVideoTracks = duplicateVideoCandidates.map(
        (candidate) => candidate.label,
      );
      for (const candidate of uniqueVideoCandidates) {
        const videoId = candidate.videoId;
        try {
          await axios.post(
            "https://www.googleapis.com/youtube/v3/playlistItems",
            {
              snippet: {
                playlistId: newPlaylistId,
                resourceId: {
                  kind: "youtube#video",
                  videoId: videoId,
                },
              },
            },
            {
              params: { part: "snippet" },
              headers: {
                Authorization: `Bearer ${sourceTokens.accessToken}`,
                "Content-Type": "application/json",
              },
            },
          );
          addedCount++;
        } catch (err) {
          console.error(
            `Failed to add video ${videoId}:`,
            err.response?.data || err.message,
          );
          failedVideoTracks.push(candidate.label);
        }
      }

      res.json({
        success: true,
        message: "Playlist transferred successfully",
        playlist: {
          id: newPlaylistId,
          name: createResponse.data.snippet.title,
          url: `https://www.youtube.com/playlist?list=${newPlaylistId}`,
          tracks: addedCount,
        },
        unmatchedTracks: failedVideoTracks,
        totalSource: videoCandidates.length,
        totalMatched: addedCount,
        totalUnmatched: failedVideoTracks.length,
      });
    } else {
      // ── Cross-Platform Transfer ──────────────────────────
      const { matchAllTracks } = require("../services/song-matcher");

      // Step 1: Fetch source tracks
      let sourceTracks = [];

      if (sourcePlatform === "ai") {
        sourceTracks = req.body.tracks || [];
      } else if (sourcePlatform === "spotify") {
        let srcSpotifyAuth = null;
        try {
          srcSpotifyAuth = await getSpotifyAccessToken(req.user, req, res);
        } catch (authErr) {
          srcSpotifyAuth = null;
        }

        // Helper: fetch ALL tracks using Spotify API with user token (handles pagination)
        const fetchAllSpotifyTracks = async (token) => {
          let allItems = [];
          let url = `https://api.spotify.com/v1/playlists/${sourcePlaylistId}/items`;
          const params = { limit: 100 };

          while (url) {
            const resp = await axios.get(url, {
              headers: { Authorization: `Bearer ${token}` },
              params:
                url.startsWith("https://api.spotify.com") && !url.includes("?")
                  ? params
                  : undefined,
              timeout: SPOTIFY_WRITE_TIMEOUT_MS,
            });
            allItems.push(...(resp.data.items || []));
            url = resp.data.next || null;
          }
          return allItems;
        };

        // Helper: scrape track data directly from Spotify's embed page.
        // The embed page contains full track data in __NEXT_DATA__ JSON,
        // including track names, artists, URIs, and durations.
        // This requires NO API authentication and works for all public playlists.
        const scrapeSpotifyEmbedTracks = async () => {
          const embedResp = await axios.get(
            `https://open.spotify.com/embed/playlist/${sourcePlaylistId}`,
            {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              },
            },
          );
          const html = embedResp.data;

          // Extract __NEXT_DATA__ JSON from the page
          const nextDataMatch = html.match(
            /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s,
          );
          if (!nextDataMatch) {
            throw new Error("Could not find track data in Spotify embed page");
          }

          const nextData = JSON.parse(nextDataMatch[1]);
          const entity = nextData?.props?.pageProps?.state?.data?.entity;
          if (!entity || !entity.trackList || entity.trackList.length === 0) {
            throw new Error("No tracks found in Spotify embed data");
          }

          return entity.trackList
            .filter((t) => t.uri && t.title)
            .map((t) => ({
              name: t.title,
              artist: t.subtitle || "Unknown Artist",
              album: "",
              duration: t.duration || 0,
              spotifyUri: t.uri,
            }));
        };

        let fetchSucceeded = false;

        // Attempt 1: Use user's Spotify token if available (gives full data including album names)
        const accessToken = srcSpotifyAuth?.accessToken;
        if (accessToken) {
          try {
            const trackItems = await fetchAllSpotifyTracks(accessToken);
            sourceTracks = trackItems
              .map((item) => getSpotifyPlaylistEntryTrack(item))
              .filter(Boolean)
              .map((track) => ({
                name: track.name,
                artist: track.artists.map((a) => a.name).join(", "),
                album: track.album?.name || "",
                duration: track.duration_ms,
                spotifyUri: track.uri,
              }));
            fetchSucceeded = true;
          } catch (userErr) {
            console.log(
              "User Spotify token failed, will try embed scraping. Error:",
              userErr.response?.status,
              userErr.response?.data?.error?.message || userErr.message,
            );
          }
        }

        // Attempt 2: Scrape tracks from Spotify embed page (no auth required, works for public playlists)
        if (!fetchSucceeded) {
          try {
            console.log(
              "Scraping Spotify embed page for playlist tracks:",
              sourcePlaylistId,
            );
            sourceTracks = await scrapeSpotifyEmbedTracks();
            console.log(
              `Successfully scraped ${sourceTracks.length} tracks from embed page`,
            );
            fetchSucceeded = true;
          } catch (scrapeErr) {
            console.error("Embed page scraping failed:", scrapeErr.message);
            return res.status(403).json({
              error: {
                message:
                  "Could not access this Spotify playlist. It may be private or unavailable.",
                status: 403,
              },
            });
          }
        }
      } else if (
        sourcePlatform === "youtube" ||
        sourcePlatform === "youtube-music"
      ) {
        // ── Approach 1: ytpl — no API key or OAuth required (public playlists) ──
        let ytplSucceeded = false;
        try {
          const ytpl = require("ytpl");
          const ytplResult = await ytpl(sourcePlaylistId, { limit: Infinity });
          sourceTracks = (ytplResult.items || []).map((item) => ({
            name: item.title,
            artist: item.author?.name || item.author?.ref || "Unknown",
            youtubeId: item.id,
          }));
          ytplSucceeded = sourceTracks.length > 0;
          console.log(
            `[YouTube] ytpl fetched ${sourceTracks.length} tracks for playlist ${sourcePlaylistId}`,
          );
        } catch (ytplErr) {
          console.warn(
            `[YouTube] ytpl failed (${ytplErr.message}), trying fallback…`,
          );
        }

        // ── Approach 2: YouTube Data API v3 via OAuth token ─────────────────
        if (!ytplSucceeded) {
          let srcTokens = null;
          if (req.user && req.user.isPlatformConnected("youtube")) {
            const ytAccess = await getYouTubeAccessToken(req.user);
            srcTokens = { accessToken: ytAccess };
          } else {
            srcTokens = req.user?.getPlatformTokens("youtube");
          }

          // ── Approach 3: YouTube Data API v3 via explicit API key ──────────
          // NOTE: YOUTUBE_API_KEY must be a real Data API key from
          // https://console.cloud.google.com — do NOT use GOOGLE_CLIENT_ID here,
          // that is an OAuth client ID and will be rejected by the YouTube API.
          const hasValidApiKey =
            process.env.YOUTUBE_API_KEY &&
            process.env.YOUTUBE_API_KEY !== "placeholder" &&
            process.env.YOUTUBE_API_KEY !== "your_youtube_api_key" &&
            !process.env.YOUTUBE_API_KEY.includes(
              ".apps.googleusercontent.com",
            );

          if (!srcTokens?.accessToken && !hasValidApiKey) {
            return res.status(403).json({
              error: {
                message:
                  "Unable to fetch tracks from this YouTube playlist. " +
                  "Please either (a) connect your YouTube account, or " +
                  "(b) set a valid YOUTUBE_API_KEY in your .env file " +
                  "(get one free at https://console.cloud.google.com).",
                status: 403,
              },
            });
          }

          let allItems = [];
          let pageToken = null;
          do {
            const ytParams = {
              part: "snippet,contentDetails",
              playlistId: sourcePlaylistId,
              maxResults: 50,
              pageToken,
            };
            const ytHeaders = {};
            if (srcTokens?.accessToken) {
              ytHeaders["Authorization"] = `Bearer ${srcTokens.accessToken}`;
            } else {
              ytParams.key = process.env.YOUTUBE_API_KEY;
            }
            const resp = await axios.get(
              "https://www.googleapis.com/youtube/v3/playlistItems",
              { params: ytParams, headers: ytHeaders },
            );
            allItems.push(...resp.data.items);
            pageToken = resp.data.nextPageToken;
          } while (pageToken);

          sourceTracks = allItems
            .filter((i) => i.contentDetails?.videoId)
            .map((i) => ({
              name: i.snippet.title,
              artist: i.snippet.videoOwnerChannelTitle || "Unknown",
              youtubeId: i.contentDetails.videoId,
            }));
        }
      } else if (sourcePlatform === "jiosaavn") {
        const jiosaavnResp = await axios.get(
          `http://localhost:${process.env.PORT || 5000}/api/jiosaavn/playlist/${sourcePlaylistId}`,
        );
        sourceTracks = (jiosaavnResp.data.songs || []).map((s) => ({
          name: s.title,
          artist: s.artist,
          album: s.album,
          duration: (s.duration || 0) * 1000,
          jiosaavnId: s.id,
        }));
      } else if (sourcePlatform === "apple-music") {
        // Scrape Apple Music page for track data
        const appleUrl =
          req.body.originalUrl ||
          `https://music.apple.com/us/playlist/playlist/${sourcePlaylistId}`;
        const appleResp = await axios.get(appleUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            Accept: "text/html",
          },
          timeout: 15000,
        });
        const html = appleResp.data;
        const serialized = html.match(
          /id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/,
        );
        if (serialized) {
          const fullData = JSON.parse(serialized[1]);
          const sections = fullData?.data?.[0]?.data?.sections || [];

          // Find the track section (the one with the most items, typically > 5)
          let trackSection = null;
          for (const s of sections) {
            if (s.items && s.items.length > 5) {
              trackSection = s;
              break;
            }
          }

          if (trackSection) {
            function findVal(obj, key, depth = 0) {
              if (depth > 6 || !obj || typeof obj !== "object")
                return undefined;
              if (obj[key] !== undefined) return obj[key];
              for (const k of Object.keys(obj)) {
                const r = findVal(obj[k], key, depth + 1);
                if (r !== undefined) return r;
              }
              return undefined;
            }
            sourceTracks = trackSection.items
              .map((item) => {
                const name =
                  item.impressionMetrics?.fields?.name || findVal(item, "name");
                const artist = findVal(item, "artistName") || "Unknown Artist";
                return { name, artist };
              })
              .filter((t) => t.name);
          }
        }
      }

      if (sourceTracks.length === 0) {
        return res.status(400).json({
          error: {
            message: "No tracks found in the source playlist",
            status: 400,
          },
        });
      }

      // Step 2: Match tracks on the destination platform
      sendProgress(transferId, {
        status: "progress",
        message: "Matching tracks on destination platform...",
        progress: 30,
      });
      let destTokens;
      if (destinationPlatform === "spotify") {
        try {
          const spotifyAuth = await getSpotifyAccessToken(req.user, req, res);
          spotifyDestinationTokenInfo = spotifyAuth;
          spotifyDestinationScopeStatus = getSpotifyScopeStatus(
            spotifyAuth,
            SPOTIFY_DESTINATION_REQUIRED_SCOPES,
          );
          console.info("[Spotify] Destination transfer token selected", {
            source: spotifyAuth.source,
            refreshed: spotifyAuth.refreshed,
            connectedAt: spotifyAuth.connectedAt || "unknown",
            scopes: spotifyAuth.scopes || [],
          });
          destTokens = { accessToken: spotifyAuth.accessToken };
        } catch (err) {
          destTokens = null;
        }
      } else {
        const platformKey =
          destinationPlatform === "youtube-music"
            ? "youtube"
            : destinationPlatform;
        if (
          platformKey === "youtube" &&
          req.user &&
          req.user.isPlatformConnected("youtube")
        ) {
          const ytAccess = await getYouTubeAccessToken(req.user);
          destTokens = { accessToken: ytAccess };
        } else if (destinationPlatform === "amazon-music") {
          destTokens = req.user?.getPlatformTokens("amazon-music");
        } else if (destinationPlatform === "apple-music") {
          if (req.body.appleMusicToken) {
            destTokens = { accessToken: req.body.appleMusicToken };
          } else {
            destTokens = null;
          }
        } else {
          destTokens = req.user?.getPlatformTokens(platformKey);
        }
      }

      if (!destTokens) {
        return res.status(403).json({
          error: {
            message: `Please connect your ${destinationPlatform} account`,
            status: 403,
          },
        });
      }

      const { matched, unmatched } = await matchAllTracks(
        sourceTracks,
        destinationPlatform,
        destTokens || {},
        (current, total, trackName) => {
          const prog = 30 + Math.floor(40 * (current / total));
          sendProgress(transferId, {
            status: "progress",
            message: `Matching: ${trackName} (${current}/${total})`,
            progress: prog,
          });
        },
      );
      const unmatchedAtMatchStage = unmatched.map(formatTrackLabel);
      let failedToTransferTracks = [];

      if (matched.length === 0) {
        const unmatchedTracks =
          unmatchedAtMatchStage.length > 0
            ? unmatchedAtMatchStage
            : sourceTracks.map(formatTrackLabel);
        return res.status(400).json({
          error: {
            message: `No tracks could be matched on ${destinationPlatform}.`,
            status: 400,
          },
          unmatchedTracks,
          failedToTransferTracks: unmatchedTracks,
          totalSource: sourceTracks.length,
          totalMatched: 0,
          totalUnmatched: unmatchedTracks.length,
        });
      }

      // Step 3: Create playlist + add tracks on the destination
      // Brief pause after the matching phase: the search loop issues many
      // Spotify API calls (up to 3 queries × N tracks).  Waiting 1 second
      // lets Spotify's rolling rate-limit window recover so that the
      // subsequent create-playlist and add-tracks write calls succeed.
      if (destinationPlatform === "spotify") {
        await wait(1000);
      }

      sendProgress(transferId, {
        status: "progress",
        message: "Creating new playlist...",
        progress: 75,
      });
      let newPlaylistId,
        newPlaylistUrl,
        addedCount = 0;
      let transferMessage = "Playlist transferred successfully";

      if (destinationPlatform === "spotify") {
        if (isSpotifyScopeMissing(spotifyDestinationScopeStatus)) {
          const scopeReason = buildSpotifyScopeReason(spotifyDestinationScopeStatus);
          const scopeError = new Error(scopeReason);
          scopeError.response = {
            status: 403,
            data: { error: { message: scopeReason } },
          };
          throw attachSpotifyDiagnostics(
            scopeError,
            spotifyDestinationTokenInfo,
            spotifyDestinationScopeStatus,
            scopeReason,
          );
        }

        const spotifyTrackCandidates = matched.map((m) => ({
          uri: toSpotifyTrackUri(m.match),
          name:
            m.source.name || m.source.title || m.match.name || "Unknown Track",
          artist: m.source.artist || m.match.artist || "",
        }));
        const {
          unique: uniqueSpotifyTrackCandidates,
          duplicates: duplicateSpotifyTrackCandidates,
        } = dedupeByKey(spotifyTrackCandidates, (candidate) =>
          normalizeSpotifyTrackUri(candidate.uri),
        );

        failedToTransferTracks = mergeUniqueTrackLabels(
          failedToTransferTracks,
          duplicateSpotifyTrackCandidates.map(formatTrackLabel),
        );

        const validSpotifyUris = uniqueSpotifyTrackCandidates
          .map((c) => normalizeSpotifyTrackUri(c.uri))
          .filter(Boolean);
        if (validSpotifyUris.length === 0) {
          return res.status(400).json({
            error: {
              message:
                "Tracks were matched but no valid Spotify URIs were produced.",
              status: 400,
            },
          });
        }

        const runSpotifyCreateAndAdd = async (accessToken) => {
          // Create playlist
          let createResp;
          try {
            createResp = await axios.post(
              "https://api.spotify.com/v1/me/playlists",
              {
                name: playlistName || "Transferred Playlist",
                description: playlistDescription || "Created with MusiKtransfer",
                public: false,
              },
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
                timeout: SPOTIFY_WRITE_TIMEOUT_MS,
              },
            );
          } catch (err) {
            console.error(
              "Spotify Create Playlist Error:",
              err.response?.data || err.message,
            );
            throw err;
          }

          const createdPlaylistId = createResp.data.id;
          const createdPlaylistUrl = createResp.data.external_urls.spotify;

          // Wrap addTracksToSpotifyPlaylist so the empty playlist is always
          // cleaned up before any error is re-thrown to the outer catch handler.
          let addResult;
          try {
            addResult = await addTracksToSpotifyPlaylist({
              accessToken,
              playlistId: createdPlaylistId,
              candidates: uniqueSpotifyTrackCandidates,
            });
          } catch (addErr) {
            await cleanupEmptySpotifyPlaylist(
              accessToken,
              createdPlaylistId,
            ).catch(() => {});
            throw addErr;
          }

          return {
            createdPlaylistId,
            createdPlaylistUrl,
            addResult,
          };
        };

        let addResult;
        let attemptedForcedRefresh = false;
        let currentSpotifyTokenInfo = spotifyDestinationTokenInfo;
        let currentSpotifyAccessToken = currentSpotifyTokenInfo.accessToken;

        while (true) {
          try {
            const runResult = await runSpotifyCreateAndAdd(
              currentSpotifyAccessToken,
            );
            newPlaylistId = runResult.createdPlaylistId;
            newPlaylistUrl = runResult.createdPlaylistUrl;
            addResult = runResult.addResult;
            break;
          } catch (spotifyWriteErr) {
            const status = spotifyWriteErr.response?.status;
            const message = getSpotifyErrorMessage(spotifyWriteErr);
            attachSpotifyDiagnostics(
              spotifyWriteErr,
              currentSpotifyTokenInfo,
              spotifyDestinationScopeStatus,
              message || spotifyWriteErr.spotifyProviderReason,
            );
            console.warn("[Spotify] Destination write failed", {
              status,
              message,
              source: currentSpotifyTokenInfo?.source || "unknown",
              scopeStatus: spotifyDestinationScopeStatus,
            });
            const shouldRetryWithRefresh =
              !attemptedForcedRefresh &&
              isSpotifyAuthOrScopeError({ status, message });

            if (!shouldRetryWithRefresh) {
              throw spotifyWriteErr;
            }

            attemptedForcedRefresh = true;
            try {
              currentSpotifyTokenInfo = await getSpotifyAccessToken(
                req.user,
                req,
                res,
                { forceRefresh: true },
              );
              spotifyDestinationTokenInfo = currentSpotifyTokenInfo;
              spotifyDestinationScopeStatus = getSpotifyScopeStatus(
                currentSpotifyTokenInfo,
                SPOTIFY_DESTINATION_REQUIRED_SCOPES,
              );
              currentSpotifyAccessToken = currentSpotifyTokenInfo.accessToken;
              destTokens.accessToken = currentSpotifyAccessToken;
              console.info("[Spotify] Retrying transfer with refreshed token", {
                source: currentSpotifyTokenInfo.source,
                refreshed: currentSpotifyTokenInfo.refreshed,
                connectedAt: currentSpotifyTokenInfo.connectedAt || "unknown",
                scopeStatus: spotifyDestinationScopeStatus,
              });
            } catch (refreshErr) {
              throw spotifyWriteErr;
            }
          }
        }

        failedToTransferTracks = mergeUniqueTrackLabels(
          failedToTransferTracks,
          addResult.failedTracks.map(formatTrackLabel),
        );

        if (addResult.added === 0) {
          const finalUnmatchedTracks = mergeUniqueTrackLabels(
            unmatchedAtMatchStage,
            failedToTransferTracks,
          );
          await cleanupEmptySpotifyPlaylist(
            currentSpotifyAccessToken,
            newPlaylistId,
          );

          // Build an informative error message that includes the actual
          // Spotify error if one was captured during the add-tracks phase.
          const spotifyErrDetail = addResult.firstSpotifyError
            ? ` Spotify returned: ${addResult.firstSpotifyError.status} — ${addResult.firstSpotifyError.message}.`
            : "";

          return res.status(400).json({
            error: {
              message:
                "Transfer failed: none of the tracks could be transferred to Spotify." +
                spotifyErrDetail,
              status: 400,
            },
            unmatchedTracks: finalUnmatchedTracks,
            failedToTransferTracks,
            totalSource: sourceTracks.length,
            totalMatched: 0,
            totalUnmatched: finalUnmatchedTracks.length,
          });
        }
        addedCount = addResult.added;
      } else if (
        destinationPlatform === "youtube" ||
        destinationPlatform === "youtube-music"
      ) {
        const ytToken = destTokens.accessToken;
        const {
          unique: uniqueYouTubeMatches,
          duplicates: duplicateYouTubeMatches,
        } = dedupeByKey(matched, (item) => item.match?.youtubeId);
        failedToTransferTracks = mergeUniqueTrackLabels(
          failedToTransferTracks,
          duplicateYouTubeMatches.map((item) => formatTrackLabel(item.source)),
        );

        // Create playlist
        const createResp = await axios.post(
          "https://www.googleapis.com/youtube/v3/playlists",
          {
            snippet: {
              title: playlistName || "Transferred Playlist",
              description: playlistDescription || "Created with MusiKtransfer",
            },
            status: { privacyStatus: "private" },
          },
          {
            params: { part: "snippet,status" },
            headers: {
              Authorization: `Bearer ${ytToken}`,
              "Content-Type": "application/json",
            },
          },
        );
        newPlaylistId = createResp.data.id;
        newPlaylistUrl = `https://www.youtube.com/playlist?list=${newPlaylistId}`;
        sendProgress(transferId, {
          status: "progress",
          message: "Adding tracks to new playlist...",
          progress: 80,
        });
        // Add videos one by one
        for (let i = 0; i < uniqueYouTubeMatches.length; i++) {
          const m = uniqueYouTubeMatches[i];
          const videoId = m.match.youtubeId;
          if (!videoId) {
            failedToTransferTracks.push(formatTrackLabel(m.source));
            continue;
          }
          try {
            await axios.post(
              "https://www.googleapis.com/youtube/v3/playlistItems",
              {
                snippet: {
                  playlistId: newPlaylistId,
                  resourceId: { kind: "youtube#video", videoId },
                },
              },
              {
                params: { part: "snippet" },
                headers: {
                  Authorization: `Bearer ${ytToken}`,
                  "Content-Type": "application/json",
                },
              },
            );
            addedCount++;
            sendProgress(transferId, {
              status: "progress",
              message: `Adding track ${i + 1}/${uniqueYouTubeMatches.length}`,
              progress:
                80 +
                Math.floor(
                  20 * ((i + 1) / Math.max(uniqueYouTubeMatches.length, 1)),
                ),
            });
          } catch (err) {
            console.error(
              `Failed to add video ${videoId}:`,
              err.response?.data || err.message,
            );
            failedToTransferTracks.push(formatTrackLabel(m.source));
          }
        }
      } else if (destinationPlatform === "amazon-music") {
        const amzToken = destTokens.accessToken;
        const {
          unique: uniqueAmazonMatches,
          duplicates: duplicateAmazonMatches,
        } = dedupeByKey(
          matched,
          // Assuming amazonId is returned by the matcher.
          (item) => item.match?.amazonId || item.match?.id,
        );
        failedToTransferTracks = mergeUniqueTrackLabels(
          failedToTransferTracks,
          duplicateAmazonMatches.map((item) => formatTrackLabel(item.source)),
        );

        // We assume the user UUID is retrieved or embedded in the token payload.
        // For the beta Amazon API, POST /api/{userUUID}/playlists is the typical path.
        // As a placeholder, we use 'me' or extract the UUID if available.
        const userUUID = destTokens.userUUID || "me";

        try {
          const createResp = await axios.post(
            `https://api.amazon.com/music/v1/users/${userUUID}/playlists`,
            {
              title: playlistName || "Transferred Playlist",
              description: playlistDescription || "Created with MusiKtransfer",
              visibility: "PRIVATE",
            },
            {
              headers: {
                Authorization: `Bearer ${amzToken}`,
                "Content-Type": "application/json",
              },
            },
          );
          newPlaylistId = createResp.data.id;
          // Amazon Music typically uses standard domain routes for playlists
          newPlaylistUrl = `https://music.amazon.com/playlists/${newPlaylistId}`;
          
          sendProgress(transferId, {
            status: "progress",
            message: "Adding tracks to new Amazon Music playlist...",
            progress: 80,
          });

          // Add tracks in batch if supported, or one-by-one
          const trackIds = uniqueAmazonMatches
            .map((m) => m.match?.amazonId || m.match?.id)
            .filter(Boolean);

          if (trackIds.length > 0) {
            await axios.post(
              `https://api.amazon.com/music/v1/users/${userUUID}/playlists/${newPlaylistId}/tracks`,
              {
                tracks: trackIds.map((id) => ({ id })),
              },
              {
                headers: {
                  Authorization: `Bearer ${amzToken}`,
                  "Content-Type": "application/json",
                },
              },
            );
            addedCount = trackIds.length;
          }
        } catch (err) {
          console.error(
            "Amazon Music Transfer Error:",
            err.response?.data || err.message,
          );
          failedToTransferTracks = mergeUniqueTrackLabels(
            failedToTransferTracks,
            uniqueAmazonMatches.map((m) => formatTrackLabel(m.source)),
          );
        }
      } else if (destinationPlatform === "apple-music") {
        const musicUserToken = destTokens.accessToken;
        const {
          unique: uniqueAppleMatches,
          duplicates: duplicateAppleMatches,
        } = dedupeByKey(
          matched,
          (item) => item.match?.appleMusicId || item.match?.id,
        );
        failedToTransferTracks = mergeUniqueTrackLabels(
          failedToTransferTracks,
          duplicateAppleMatches.map((item) => formatTrackLabel(item.source)),
        );

        const jwt = require("jsonwebtoken");
        const teamId = process.env.APPLE_TEAM_ID;
        const keyId = process.env.APPLE_MUSIC_KEY_ID;
        let privateKey = process.env.APPLE_MUSIC_PRIVATE_KEY;
        
        if (privateKey && privateKey.includes("\\n")) {
          privateKey = privateKey.replace(/\\n/g, "\n");
        }

        const developerToken = jwt.sign(
          {
            iss: teamId,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
          privateKey,
          { algorithm: "ES256", keyid: keyId }
        );

        try {
          const createResp = await axios.post(
            `https://api.music.apple.com/v1/me/library/playlists`,
            {
              attributes: {
                name: playlistName || "Transferred Playlist",
                description: playlistDescription || "Created with MusiKtransfer",
              }
            },
            {
              headers: {
                Authorization: `Bearer ${developerToken}`,
                "Music-User-Token": musicUserToken,
                "Content-Type": "application/json",
              },
            },
          );
          
          newPlaylistId = createResp.data.data[0].id;
          newPlaylistUrl = `https://music.apple.com/library/playlist/${newPlaylistId}`;
          
          sendProgress(transferId, {
            status: "progress",
            message: "Adding tracks to new Apple Music playlist...",
            progress: 80,
          });

          const trackIds = uniqueAppleMatches
            .map((m) => m.match?.appleMusicId || m.match?.id)
            .filter(Boolean);

          if (trackIds.length > 0) {
            await axios.post(
              `https://api.music.apple.com/v1/me/library/playlists/${newPlaylistId}/tracks`,
              {
                data: trackIds.map((id) => ({ id, type: "songs" })),
              },
              {
                headers: {
                  Authorization: `Bearer ${developerToken}`,
                  "Music-User-Token": musicUserToken,
                  "Content-Type": "application/json",
                },
              },
            );
            addedCount = trackIds.length;
          }
        } catch (err) {
          console.error(
            "Apple Music Transfer Error:",
            err.response?.data || err.message,
          );
          failedToTransferTracks = mergeUniqueTrackLabels(
            failedToTransferTracks,
            uniqueAppleMatches.map((m) => formatTrackLabel(m.source)),
          );
        }
      }

      const finalUnmatchedTracks = mergeUniqueTrackLabels(
        unmatchedAtMatchStage,
        failedToTransferTracks,
      );
      const totalTransferred = Math.max(
        0,
        sourceTracks.length - finalUnmatchedTracks.length,
      );

      res.json({
        success: true,
        message: transferMessage,
        playlist: {
          id: newPlaylistId,
          name: playlistName || "Transferred Playlist",
          url: newPlaylistUrl,
          tracks: addedCount,
        },
        unmatchedTracks: finalUnmatchedTracks,
        failedToTransferTracks,
        totalSource: sourceTracks.length,
        totalMatched: totalTransferred,
        totalUnmatched: finalUnmatchedTracks.length,
      });
    }
  } catch (error) {
    console.error(
      "Transfer playlist error:",
      error.response?.data || error.message,
    );

    let errorMessage =
      error.response?.data?.error?.message || "Transfer failed";
    let errorCode = error.response?.data?.error?.code || null;
    const statusCode = error.response?.status;
    const destinationPlatform = req.body?.destinationPlatform;
    const spotifyRawMessage = getSpotifyErrorMessage(error);
    const spotifyErrorMessage = spotifyRawMessage.toLowerCase();
    let providerReason = null;
    const spotifyTokenSource =
      error.spotifyTokenSource || spotifyDestinationTokenInfo?.source || null;
    const spotifyScopeStatus =
      error.spotifyScopeStatus || spotifyDestinationScopeStatus || null;

    // Translate cryptic YouTube API errors
    if (errorMessage === "Forbidden" && error.response?.data?.error?.errors) {
      const ytErrorReason = error.response.data.error.errors[0]?.reason;
      if (ytErrorReason === "youtubeSignupRequired") {
        errorMessage =
          "Your connected Google account does not have a YouTube Channel. Please go to youtube.com and create a channel first to allow transferring playlists.";
      } else if (ytErrorReason === "quotaExceeded") {
        errorMessage =
          "YouTube API daily quota exceeded. Please try again tomorrow.";
      } else {
        errorMessage =
          "Access Forbidden: Ensure your connected account has permission to create playlists.";
      }
    } else if (
      destinationPlatform === "spotify" &&
      (isSpotifyAuthOrScopeError({
        status: statusCode,
        message: spotifyRawMessage,
      }) ||
        isSpotifyScopeMissing(spotifyScopeStatus))
    ) {
      // Ask frontend to reconnect Spotify only for actual auth/scope failures
      errorMessage = "SPOTIFY_REAUTH_REQUIRED";
      errorCode = "SPOTIFY_REAUTH_REQUIRED";
      providerReason =
        error.spotifyProviderReason ||
        buildSpotifyScopeReason(spotifyScopeStatus) ||
        spotifyRawMessage ||
        "spotify_auth_or_scope_error";
    } else if (statusCode === 403 && destinationPlatform === "spotify") {
      // Translate common Spotify 403 sub-types into actionable messages
      if (
        spotifyErrorMessage.includes("not registered") ||
        spotifyErrorMessage.includes("developer portal")
      ) {
        // App is in Spotify Development Mode and this user is not on the allowlist
        errorMessage =
          "Your Spotify account is not authorised to use this app in its current " +
          "development mode. Please ask the app owner to add your Spotify email to " +
          "their Spotify Developer Dashboard allowlist, or wait for the app to be " +
          "promoted to Extended Quota Mode.";
      } else if (
        spotifyErrorMessage.includes("premium") ||
        spotifyErrorMessage.includes("premium required")
      ) {
        errorMessage =
          "This action requires a Spotify Premium account. Please upgrade your " +
          "Spotify subscription and try again.";
      } else {
        // Surface whatever Spotify actually said, with a fallback
        errorMessage =
          spotifyRawMessage ||
          "Spotify rejected the request to add tracks. Some songs may be unavailable " +
            "in your region or account.";
      }
      providerReason = spotifyRawMessage || providerReason;
    }

    res.status(statusCode || 500).json({
      error: {
        message: errorMessage,
        code: errorCode || undefined,
        providerReason: providerReason || undefined,
        tokenSource: spotifyTokenSource || undefined,
        scopeStatus: spotifyScopeStatus || undefined,
        status: statusCode || 500,
        details: error.message,
      },
    });
  }
});

// Get transfer history (placeholder)
router.get("/history", authMiddleware, (req, res) => {
  res.json({
    transfers: [],
    message: "Transfer history coming soon",
  });
});

module.exports = router;
