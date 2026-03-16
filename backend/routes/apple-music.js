const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const authMiddleware = require("../middleware/auth");

/**
 * @route   GET /api/apple-music/token
 * @desc    Generate an Apple Music API Developer Token
 * @access  Private
 */
router.get("/token", authMiddleware, (req, res) => {
  try {
    const teamId = process.env.APPLE_TEAM_ID;
    const keyId = process.env.APPLE_MUSIC_KEY_ID;
    let privateKey = process.env.APPLE_MUSIC_PRIVATE_KEY;

    if (!teamId || !keyId || !privateKey) {
      return res.status(500).json({
        error: {
          message:
            "Apple Music developer credentials are not configured on the server. Please add APPLE_TEAM_ID, APPLE_MUSIC_KEY_ID, and APPLE_MUSIC_PRIVATE_KEY to .env.",
          status: 500,
        },
      });
    }

    // Handle multiline private keys from .env if they are escaped
    if (privateKey.includes("\\n")) {
      privateKey = privateKey.replace(/\\n/g, "\n");
    }

    const payload = {
      iss: teamId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 15777000, // Expires in 6 months (max allowed)
    };

    const signOptions = {
      algorithm: "ES256",
      keyid: keyId,
    };

    const developerToken = jwt.sign(payload, privateKey, signOptions);

    res.json({ token: developerToken });
  } catch (error) {
    console.error("Apple Music Token Generation Error:", error.message);
    res.status(500).json({
      error: {
        message: "Failed to generate Apple Music Developer Token",
        status: 500,
      },
    });
  }
});

module.exports = router;
