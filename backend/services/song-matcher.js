/**
 * Song Matcher Service
 * Searches for tracks across platforms and finds the best match
 * Used for cross-platform playlist transfers
 */

const axios = require("axios");
const jwt = require("jsonwebtoken");

const JIOSAAVN_API_BASE = "https://www.jiosaavn.com/api.php";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";
const YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SPOTIFY_SEARCH_TIMEOUT_MS = 9000;
const SPOTIFY_SEARCH_MAX_ATTEMPTS = 2;
const SPOTIFY_SEARCH_MAX_LIMIT = 10;
const SPOTIFY_SEARCH_RESULT_LIMIT = 10;
const SPOTIFY_SEARCH_QUERY_LIMIT = 3;

const isAbortError = (error) =>
  error?.name === "AbortError" ||
  error?.name === "CanceledError" ||
  error?.code === "ERR_CANCELED";

async function withAbortableTimeout(taskFactory, timeoutMs, label = "operation") {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await taskFactory(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && isAbortError(error)) {
      const timeoutError = new Error(`${label}_timeout`);
      timeoutError.code = "TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Normalize a string for fuzzy comparison
 * Strips parenthetical content, lowercases, removes special chars
 */
function sanitizeTrackTitle(str) {
  if (!str) return "";

  let value = String(str).replace(/\s+/g, " ").trim();
  if (!value) return "";

  // YouTube and scraped titles often append movie/channel metadata after pipes.
  value = value.replace(/\s*\|.*$/g, "").trim();

  // Drop trailing metadata segments without touching legitimate song names.
  value = value.replace(
    /\s[-:]\s(?:official|full song|video song|music video|lyric(?:al)? video|lyrics|audio|hd|hq|4k|remastered|jukebox|teaser|trailer|promo).+$/i,
    "",
  ).trim();

  // Remove bracketed marketing labels, but keep musical qualifiers like
  // "(Film Version)" available for title variants later.
  value = value.replace(
    /[\[(](?:official|full song|video song|music video|lyric(?:al)? video|lyrics|audio|hd|hq|4k|remastered|jukebox|teaser|trailer|promo)[^)\]]*[)\]]/gi,
    " ",
  );

  return value.replace(/\s+/g, " ").trim();
}

function sanitizeArtistName(str) {
  if (!str) return "";
  return String(str)
    .replace(/\s+/g, " ")
    .replace(/\b(ft|feat)\.?\b.*$/i, "")
    .trim();
}

function normalizeText(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/ft\.?|feat\.?/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTitleVariants(sourceTrack) {
  const rawTitle = sanitizeTrackTitle(sourceTrack.name || sourceTrack.title || "");
  if (!rawTitle) return [];

  const variants = [rawTitle];
  const withoutBracketedText = rawTitle
    .replace(/\s*[\[(][^)\]]+[\])]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const leadDashSegment = rawTitle
    .split(/\s[-:]\s/)
    .map((part) => part.trim())
    .filter(Boolean)[0];

  if (withoutBracketedText && withoutBracketedText !== rawTitle) {
    variants.push(withoutBracketedText);
  }
  if (
    leadDashSegment &&
    leadDashSegment.length >= 2 &&
    leadDashSegment !== rawTitle &&
    !variants.includes(leadDashSegment)
  ) {
    variants.push(leadDashSegment);
  }

  return [...new Set(variants)].filter((title) => title.length >= 2);
}

function normalize(str) {
  return normalizeText(sanitizeTrackTitle(str) || str);
}

function buildSpotifyQueryVariants(sourceTrack) {
  const titleVariants = buildTitleVariants(sourceTrack);
  const artistRaw = sanitizeArtistName(sourceTrack.artist || "");
  const primaryArtist = artistRaw
    .split(/[,&/]|(?:\s+x\s+)/i)
    .map((artist) => artist.trim())
    .filter(Boolean)[0];

  if (titleVariants.length === 0) return [];

  // Keep the query set small enough to avoid rate-limit churn, but make each
  // query more precise so film versions, bracketed titles, and noisy YouTube
  // names still resolve to Spotify catalog tracks reliably.
  const queries = [];
  const preferredTitle = titleVariants[0];

  if (primaryArtist) {
    queries.push(`track:${preferredTitle} artist:${primaryArtist}`);
  }
  if (artistRaw) {
    queries.push(`${artistRaw} ${preferredTitle}`.trim());
  }
  queries.push(preferredTitle);

  for (const alternateTitle of titleVariants.slice(1)) {
    if (primaryArtist) {
      queries.push(`track:${alternateTitle} artist:${primaryArtist}`);
    }
    queries.push(alternateTitle);
  }

  return [...new Set(queries)]
    .filter((query) => query.length >= 2)
    .slice(0, SPOTIFY_SEARCH_QUERY_LIMIT);
}

/**
 * HTML entity decoder for JioSaavn responses
 */
function decodeText(text) {
  if (!text) return "";
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Score how well two tracks match (0-100)
 */
function matchScore(sourceTrack, candidate) {
  let score = 0;
  const srcTitle = normalize(sourceTrack.name || sourceTrack.title);
  const srcArtist = normalizeText(sanitizeArtistName(sourceTrack.artist));
  const candTitle = normalize(candidate.name || candidate.title);
  const candArtist = normalizeText(sanitizeArtistName(candidate.artist));

  // Title similarity (worth up to 50 points)
  if (srcTitle === candTitle) {
    score += 50;
  } else if (candTitle.includes(srcTitle) || srcTitle.includes(candTitle)) {
    score += 38;
  } else {
    // Word overlap
    const srcWords = srcTitle.split(" ").filter((w) => w.length > 1);
    const candWords = candTitle.split(" ").filter((w) => w.length > 1);
    const overlap = srcWords.filter((w) => candWords.includes(w)).length;
    const ratio = srcWords.length > 0 ? overlap / srcWords.length : 0;
    score += Math.round(ratio * 35);
  }

  // Artist similarity (worth up to 25 points)
  if (srcArtist === candArtist) {
    score += 25;
  } else if (candArtist.includes(srcArtist) || srcArtist.includes(candArtist)) {
    score += 18;
  } else {
    const srcArtists = srcArtist
      .split(/[,&]/)
      .map((a) => a.trim())
      .filter(Boolean);
    const candArtists = candArtist
      .split(/[,&]/)
      .map((a) => a.trim())
      .filter(Boolean);
    const artistOverlap = srcArtists.filter((a) =>
      candArtists.some((c) => c.includes(a) || a.includes(c)),
    ).length;
    const ratio = srcArtists.length > 0 ? artistOverlap / srcArtists.length : 0;
    score += Math.round(ratio * 20);
  }

  // Duration match (worth up to 10 points) — within 5s tolerance
  if (sourceTrack.duration && candidate.duration) {
    const srcMs =
      sourceTrack.duration > 1000
        ? sourceTrack.duration
        : sourceTrack.duration * 1000;
    const candMs =
      candidate.duration > 1000
        ? candidate.duration
        : candidate.duration * 1000;
    const diff = Math.abs(srcMs - candMs);
    if (diff < 3000) score += 10;
    else if (diff < 5000) score += 7;
    else if (diff < 10000) score += 3;
  }

  // Official/VEVO channel bonus (worth up to 25 points)
  // Prioritizes results from official music channels over covers/lyrics channels
  const rawTitle = (candidate.name || candidate.title || "").toLowerCase();
  const rawChannel = (
    candidate.artist ||
    candidate.channel ||
    ""
  ).toLowerCase();

  // Known official labels, music publishers, and YouTube format patterns
  const officialLabels = [
    "vevo",
    "t-series",
    "tseries",
    "sony music",
    "universal music",
    "warner music",
    "zee music",
    "yrf",
    "tips official",
    "saregama",
    "speed records",
    "shemaroo",
    "eros now",
    "desi music factory",
    "atlantic records",
    "interscope",
    "republic records",
    "columbia records",
    "def jam",
    "rca records",
  ];

  if (
    rawChannel.includes("topic") &&
    normalize(rawTitle) === normalize(sourceTrack.name || sourceTrack.title)
  ) {
    score += 25; // Auto-generated YouTube Music "Topic" channels are highly likely to be the exact official audio
  } else if (officialLabels.some((label) => rawChannel.includes(label))) {
    score += 20; // Known music label or Vevo
  } else if (
    rawChannel.includes("official") ||
    rawTitle.includes("official audio") ||
    rawTitle.includes("official video") ||
    rawTitle.includes("official lyric video")
  ) {
    score += 15; // Official channel or content
  } else if (rawTitle.includes("audio") && !rawTitle.includes("lyrics")) {
    score += 5; // Audio version (not lyrics)
  }

  // Penalize covers, remixes, lyrics-only videos, live performances unless specified in source
  const srcRawTitle = (
    sourceTrack.name ||
    sourceTrack.title ||
    ""
  ).toLowerCase();

  const karaokeMismatch =
    rawTitle.includes("karaoke") && !srcRawTitle.includes("karaoke");
  if (
    (rawTitle.includes("cover") && !srcRawTitle.includes("cover")) ||
    (rawTitle.includes("remix") && !srcRawTitle.includes("remix")) ||
    karaokeMismatch
  ) {
    score -= 20;
  }
  if (rawTitle.includes("live") && !srcRawTitle.includes("live")) {
    score -= 10;
  }
  if (
    rawTitle.includes("lyrics") &&
    !rawTitle.includes("lyric video") &&
    !srcRawTitle.includes("lyrics")
  ) {
    score -= 10; // Lyrics-only videos are less ideal, usually fan-made
  }

  return Math.max(0, score);
}

// ─── Platform Search Functions ──────────────────────────────

/**
 * Search Spotify for a track
 * @param {string} query - Search query (e.g. "artist - title")
 * @param {string} accessToken - Spotify access token
 * @returns {Array} Array of { name, artist, album, duration, spotifyUri }
 */
async function searchSpotify(query, accessToken, options = {}) {
  const signal = options.signal;
  const effectiveLimit = Math.max(
    1,
    Math.min(SPOTIFY_SEARCH_RESULT_LIMIT, SPOTIFY_SEARCH_MAX_LIMIT),
  );
  try {
    let response;
    const maxAttempts = SPOTIFY_SEARCH_MAX_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) {
        const aborted = new Error("spotify_search_aborted");
        aborted.code = "ERR_CANCELED";
        throw aborted;
      }
      try {
        response = await axios.get(`${SPOTIFY_API_URL}/search`, {
          params: {
            q: query,
            type: "track",
            limit: effectiveLimit,
          },
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: SPOTIFY_SEARCH_TIMEOUT_MS,
          signal,
        });
        break;
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) {
          throw err;
        }
        const status = err.response?.status;
        const canRetry = status === 429 || (status >= 500 && status < 600);
        if (!canRetry || attempt === maxAttempts) throw err;

        const retryAfterHeader = Number(err.response?.headers?.["retry-after"]);
        const retryAfterSeconds = Number.isFinite(retryAfterHeader)
          ? retryAfterHeader
          : attempt;
        const retryAfter = Math.min(2, Math.max(0.5, retryAfterSeconds));
        await wait(retryAfter * 1000);
      }
    }

    return (response.data.tracks?.items || []).map((track) => ({
      id: track.id,
      name: track.name,
      artist: track.artists.map((a) => a.name).join(", "),
      album: track.album.name,
      duration: track.duration_ms,
      uri: track.uri,
      spotifyUri: track.uri,
      externalUrl: track.external_urls?.spotify,
      isrc: track.external_ids?.isrc,
    }));
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    console.error(
      `Spotify search error (query="${query}", limit=${effectiveLimit}):`,
      error.response?.data || error.message,
    );
    return [];
  }
}

/**
 * Search YouTube for a track
 * @param {string} query - Search query
 * @param {string} accessToken - YouTube/Google access token (no longer strictly needed for search)
 * @returns {Array} Array of { name, artist, youtubeId, duration }
 */
async function searchYouTube(query, accessToken) {
  try {
    const yts = require("yt-search");
    // Add 'official audio' to prefer official uploads over covers/lyrics videos
    const officialQuery = query + " official audio";
    const results = await yts(officialQuery);

    // Return more candidates (10) to give the scoring algorithm a better pool
    return (results.videos || []).slice(0, 10).map((item) => ({
      name: item.title,
      artist: item.author.name,
      youtubeId: item.videoId,
      duration: item.seconds ? item.seconds * 1000 : null,
      thumbnail: item.thumbnail,
      views: item.views || 0,
    }));
  } catch (error) {
    console.error("YouTube search error:", error.message);
    return [];
  }
}

/**
 * Search JioSaavn for a track (no auth required)
 * @param {string} query - Search query
 * @returns {Array} Array of { name, artist, album, duration, jiosaavnId }
 */
async function searchJioSaavn(query) {
  try {
    const url = new URL(JIOSAAVN_API_BASE);
    url.searchParams.append("__call", "search.getResults");
    url.searchParams.append("_format", "json");
    url.searchParams.append("_marker", "0");
    url.searchParams.append("cc", "in");
    url.searchParams.append("n", "5");
    url.searchParams.append("p", "1");
    url.searchParams.append("q", query);

    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
      },
    });

    if (!response.ok) return [];
    const data = await response.json();

    return (data.results || []).map((song) => ({
      name: decodeText(song.song || song.title),
      artist: decodeText(
        song.primary_artists ||
          song.more_info?.artistMap?.primary_artists
            ?.map((a) => a.name)
            .join(", ") ||
          "",
      ),
      album: decodeText(song.album || song.more_info?.album),
      duration: (parseInt(song.duration) || 0) * 1000, // convert to ms
      jiosaavnId: song.id || song.perma_url?.split("/").pop(),
    }));
  } catch (error) {
    console.error("JioSaavn search error:", error.message);
    return [];
  }
}

/**
 * Search Amazon Music for a track
 * @param {string} query - Search query
 * @param {string} accessToken - Amazon Music access token
 * @returns {Array} Array of { name, artist, duration, amazonId }
 */
async function searchAmazonMusic(query, accessToken) {
  try {
    // Amazon Music API search endpoint
    // Requires LWA access token with 'amazon_music:access' scope
    const response = await axios.get("https://api.amazon.com/music/v1/search", {
      params: {
        keyword: query,
        types: "TRACK",
        limit: 10,
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
    });

    if (!response.data || !response.data.tracks) return [];

    return (response.data.tracks || []).map((track) => ({
      name: track.title || track.name,
      artist: track.artists?.map((a) => a.name).join(", ") || "",
      album: track.album?.name || "",
      duration: track.duration_ms || track.duration * 1000 || 0,
      amazonId: track.id,
    }));
  } catch (error) {
    console.error("Amazon Music search error:", error.response?.data || error.message);
    return [];
  }
}

/**
 * Search Apple Music for a track
 * @param {string} query - Search query
 * @returns {Array} Array of { name, artist, duration, appleMusicId }
 */
async function searchAppleMusic(query) {
  try {
    const teamId = process.env.APPLE_TEAM_ID;
    const keyId = process.env.APPLE_MUSIC_KEY_ID;
    let privateKey = process.env.APPLE_MUSIC_PRIVATE_KEY;

    if (!teamId || !keyId || !privateKey) {
      console.warn("Skipping Apple Music search: credentials missing");
      return [];
    }

    if (privateKey.includes("\\n")) {
      privateKey = privateKey.replace(/\\n/g, "\n");
    }

    const payload = {
      iss: teamId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour for background job
    };

    const developerToken = jwt.sign(payload, privateKey, {
      algorithm: "ES256",
      keyid: keyId,
    });

    // Default to 'us' storefront for broad catalog search
    const storefront = "us";
    const response = await axios.get(`https://api.music.apple.com/v1/catalog/${storefront}/search`, {
      params: {
        term: query,
        types: "songs",
        limit: 10,
      },
      headers: {
        Authorization: `Bearer ${developerToken}`,
      },
    });

    if (!response.data || !response.data.results || !response.data.results.songs) {
       return [];
    }

    return (response.data.results.songs.data || []).map((song) => ({
      name: song.attributes?.name,
      artist: song.attributes?.artistName,
      album: song.attributes?.albumName,
      duration: song.attributes?.durationInMillis || 0,
      appleMusicId: song.id,
    }));
  } catch (error) {
    console.error("Apple Music search error:", error.response?.data || error.message);
    return [];
  }
}

// ─── Core Matching Function ─────────────────────────────────

/**
 * Find the best match for a source track on a destination platform
 * @param {Object} sourceTrack - { name, artist, album?, duration? }
 * @param {string} destPlatform - 'spotify' | 'youtube' | 'youtube-music' | 'jiosaavn'
 * @param {Object} tokens - { accessToken } for the destination platform (not needed for JioSaavn)
 * @returns {Object|null} Best matching track or null
 */
async function matchTrack(sourceTrack, destPlatform, tokens = {}, options = {}) {
  const query =
    `${sourceTrack.artist} ${sourceTrack.name || sourceTrack.title}`.trim();
  const signal = options.signal;

  if (!query || query.length < 2) return null;

  let candidates = [];

  switch (destPlatform) {
    case "spotify":
      {
        const queries = buildSpotifyQueryVariants(sourceTrack);

        const collected = [];
        for (let qi = 0; qi < queries.length; qi++) {
          if (signal?.aborted) {
            const aborted = new Error("spotify_match_aborted");
            aborted.code = "ERR_CANCELED";
            throw aborted;
          }
          const results = await searchSpotify(queries[qi], tokens.accessToken, {
            signal,
          });
          collected.push(...results);
          if (collected.length >= SPOTIFY_SEARCH_RESULT_LIMIT) {
            break;
          }
          // Short pause between consecutive Spotify search calls to avoid
          // hitting the per-endpoint rate limit mid-matching-loop
          if (qi < queries.length - 1) {
            await wait(120);
          }
        }

        // Deduplicate by Spotify ID/URI while preserving order
        const seen = new Set();
        candidates = collected.filter((c) => {
          const key = c.id || c.spotifyUri || c.uri || `${c.name}-${c.artist}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      break;
    case "youtube":
    case "youtube-music":
      candidates = await searchYouTube(query, tokens.accessToken);
      break;
    case "jiosaavn":
      candidates = await searchJioSaavn(query);
      break;
    case "amazon-music":
      // Tokens needed for Amazon API requests
      if (!tokens || !tokens.accessToken) {
        throw new Error("Missing Amazon Music access token");
      }
      candidates = await searchAmazonMusic(query, tokens.accessToken);
      break;
    case "apple-music":
      candidates = await searchAppleMusic(query);
      break;
    default:
      return null;
  }

  if (candidates.length === 0) return null;

  // Score each candidate and return the best one
  let bestMatch = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = matchScore(sourceTrack, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { ...candidate, matchScore: score };
    }
  }

  // Spotify source metadata can be noisy, so use a slightly lower threshold there.
  const minScore = destPlatform === "spotify" ? 22 : 30;
  return bestScore >= minScore ? bestMatch : null;
}

/**
 * Match an entire list of tracks to a destination platform
 * @param {Array} sourceTracks - Array of { name, artist, album?, duration? }
 * @param {string} destPlatform
 * @param {Object} tokens
 * @param {Function} [onProgress] - Optional callback (current, total, trackName)
 * @returns {{ matched: Array, unmatched: Array }}
 */
async function matchAllTracks(
  sourceTracks,
  destPlatform,
  tokens = {},
  onProgress,
) {
  const matched = [];
  const unmatched = [];
  const total = sourceTracks.length;

  for (let i = 0; i < total; i++) {
    const track = sourceTracks[i];
    try {
      const trackTimeoutMs = destPlatform === "spotify" ? 14000 : 12000;
      const match = await withAbortableTimeout(
        (signal) => matchTrack(track, destPlatform, tokens, { signal }),
        trackTimeoutMs,
        "track_match",
      );
      if (match) {
        matched.push({ source: track, match });
      } else {
        unmatched.push(track);
      }
      // Inter-track delay — longer for Spotify to stay well within its
      // rolling rate-limit window before the next burst of search queries
      const interTrackDelay = destPlatform === "spotify" ? 400 : 200;
      await wait(interTrackDelay);
    } catch (err) {
      console.error(`Failed to match "${track.name}":`, err.message);
      unmatched.push(track);
    }

    // Report progress
    if (typeof onProgress === "function") {
      onProgress(i + 1, total, track.name || track.title || "Unknown track");
    }
  }

  return { matched, unmatched };
}

module.exports = {
  searchSpotify,
  searchYouTube,
  searchJioSaavn,
  searchAmazonMusic,
  searchAppleMusic,
  matchTrack,
  matchAllTracks,
  matchScore,
  normalize,
};
