const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Load environment variables from root directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Import database connection
const connectDB = require('./config/db');

const app = express();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable for development
    crossOriginEmbedderPolicy: false
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: {
        error: {
            message: 'Too many requests, please try again later.',
            status: 429
        }
    }
});
app.use('/api/', limiter);

// CORS configuration
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5000',
    credentials: true
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Import routes
const authRoutes = require('./routes/auth');
const playlistRoutes = require('./routes/playlist');
const spotifyRoutes = require('./routes/spotify');
const youtubeRoutes = require('./routes/youtube');
const deezerRoutes = require('./routes/deezer');
const aiPlaylistRoutes = require('./routes/ai-playlist');
const jiosaavnRoutes = require('./routes/jiosaavn');
const amazonMusicRoutes = require('./routes/amazon-music');
const gaanaRoutes = require('./routes/gaana');
const appleMusicRoutes = require('./routes/apple-music');

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/playlist', playlistRoutes);
app.use('/api/spotify', spotifyRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/deezer', deezerRoutes);
app.use('/api/ai-playlist', aiPlaylistRoutes);
app.use('/api/jiosaavn', jiosaavnRoutes);
app.use('/api/amazon-music', amazonMusicRoutes);
app.use('/api/gaana', gaanaRoutes);
app.use('/api/apple-music', appleMusicRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
    const UserModel = require('./models/User');
    res.json({
        status: 'OK',
        message: 'Plansfer API is running',
        timestamp: new Date().toISOString(),
        database: UserModel.isUsingMongoDB() ? 'MongoDB' : 'In-Memory'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
        error: {
            message: err.message || 'Internal Server Error',
            status: err.status || 500
        }
    });
});

// 404 handler for API routes (using middleware for path-to-regexp v8+ compatibility)
app.use('/api', (req, res, next) => {
    // Only handle requests that weren't matched by other API routes
    res.status(404).json({
        error: {
            message: 'API route not found',
            status: 404
        }
    });
});

// Serve index.html for all other routes (SPA support)
app.use((req, res, next) => {
    // Skip if it's an API route (already handled above)
    if (req.path.startsWith('/api')) {
        return next();
    }
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

const PORT = process.env.PORT || 5000;

// Start server with database connection
const startServer = async () => {
    // Connect to MongoDB (will fall back to in-memory if not configured)
    await connectDB();

    app.listen(PORT, () => {
        console.log(`🚀 Plansfer API server running on http://localhost:${PORT}`);
        console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
};

startServer();

module.exports = app;

