const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const UserModel = require('../models/User');
const authMiddleware = require('../middleware/auth');

// Generate JWT token
const generateToken = (userId) => {
    return jwt.sign({ userId }, process.env.JWT_SECRET, {
        expiresIn: '30d'
    });
};

// Register new user
router.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // Validation
        if (!name || !email || !password) {
            return res.status(400).json({
                error: {
                    message: 'Please provide all required fields',
                    status: 400
                }
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error: {
                    message: 'Password must be at least 6 characters',
                    status: 400
                }
            });
        }

        // Check if user already exists (async)
        const existingUser = await UserModel.findByEmail(email);
        if (existingUser) {
            return res.status(409).json({
                error: {
                    message: 'User with this email already exists',
                    status: 409
                }
            });
        }

        // Create user (password hashing handled by model)
        const user = await UserModel.create({
            name,
            email,
            password
        });

        // Generate token
        const token = generateToken(user._id || user.id);

        res.status(201).json({
            message: 'User registered successfully',
            token,
            user: user.toJSON ? user.toJSON() : user
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            error: {
                message: 'Registration failed',
                status: 500
            }
        });
    }
});

// Login user
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validation
        if (!email || !password) {
            return res.status(400).json({
                error: {
                    message: 'Please provide email and password',
                    status: 400
                }
            });
        }

        // Find user with password
        const user = await UserModel.findByEmailWithPassword(email);
        if (!user) {
            return res.status(401).json({
                error: {
                    message: 'Invalid email or password',
                    status: 401
                }
            });
        }

        // Check password (using model method)
        const isPasswordValid = user.comparePassword
            ? await user.comparePassword(password)
            : await bcrypt.compare(password, user.password);

        if (!isPasswordValid) {
            return res.status(401).json({
                error: {
                    message: 'Invalid email or password',
                    status: 401
                }
            });
        }

        // Generate token
        const token = generateToken(user._id || user.id);

        res.json({
            message: 'Login successful',
            token,
            user: user.toJSON ? user.toJSON() : user
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            error: {
                message: 'Login failed',
                status: 500
            }
        });
    }
});

// Get current user
router.get('/me', authMiddleware, (req, res) => {
    try {
        res.json({
            user: req.user.toJSON()
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({
            error: {
                message: 'Failed to get user data',
                status: 500
            }
        });
    }
});

// Logout user
router.post('/logout', authMiddleware, (req, res) => {
    res.json({
        message: 'Logout successful'
    });
});

// ── Google OAuth ─────────────────────────────────────────────
const axios = require('axios');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// Initiate Google OAuth flow
router.get('/google', (req, res) => {
    const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: process.env.GOOGLE_AUTH_REDIRECT_URI || `${process.env.FRONTEND_URL}/api/auth/google/callback`,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'consent'
    });

    res.json({
        authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`
    });
});

// Google OAuth callback
router.get('/google/callback', async (req, res) => {
    const { code } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5001';

    if (!code) {
        return res.redirect(`${frontendUrl}?error=google_auth_failed`);
    }

    try {
        // Exchange code for tokens
        const tokenResponse = await axios.post(GOOGLE_TOKEN_URL,
            new URLSearchParams({
                code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: process.env.GOOGLE_AUTH_REDIRECT_URI || `${frontendUrl}/api/auth/google/callback`,
                grant_type: 'authorization_code'
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const { access_token } = tokenResponse.data;

        // Get user info from Google
        const userInfoResponse = await axios.get(GOOGLE_USERINFO_URL, {
            headers: { 'Authorization': `Bearer ${access_token}` }
        });

        const { email, name, picture } = userInfoResponse.data;

        // Find or create the user
        let user = await UserModel.findByEmail(email);

        if (!user) {
            // Create a new user (random password — they log in via Google)
            const bcryptLib = require('bcryptjs');
            const randomPass = await bcryptLib.hash(Math.random().toString(36), 10);
            user = await UserModel.create({
                name: name || email.split('@')[0],
                email,
                password: randomPass
            });
        }

        // Generate JWT
        const token = generateToken(user._id || user.id);

        // Redirect to frontend with token + user data in query params
        const userData = encodeURIComponent(JSON.stringify({
            name: user.name || name,
            email: user.email || email
        }));

        res.redirect(`${frontendUrl}?google_connected=true&token=${token}&user=${userData}`);
    } catch (error) {
        console.error('Google OAuth error:', error.response?.data || error.message);
        res.redirect(`${frontendUrl}?error=google_auth_failed`);
    }
});

module.exports = router;
