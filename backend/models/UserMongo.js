const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// User Schema for MongoDB
const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
        maxlength: [100, 'Name cannot exceed 100 characters']
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [6, 'Password must be at least 6 characters'],
        select: false // Don't include password in queries by default
    },
    connectedPlatforms: {
        spotify: {
            accessToken: String,
            refreshToken: String,
            scopes: [String],
            expiresAt: Date,
            connectedAt: Date
        },
        youtube: {
            accessToken: String,
            refreshToken: String,
            expiresAt: Date,
            connectedAt: Date
        },
        deezer: {
            accessToken: String,
            refreshToken: String,
            expiresAt: Date,
            connectedAt: Date
        },
        appleMusic: {
            musicUserToken: String,
            expiresAt: Date,
            connectedAt: Date
        }
    },
    transferHistory: [{
        sourcePlatform: String,
        destinationPlatform: String,
        playlistName: String,
        trackCount: Number,
        status: {
            type: String,
            enum: ['pending', 'success', 'failed'],
            default: 'pending'
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }]
}, {
    timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) {
        return next();
    }
    this.password = await bcrypt.hash(this.password, 10);
    next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// Connect platform method
userSchema.methods.connectPlatform = function (platform, tokens) {
    this.connectedPlatforms[platform] = {
        ...tokens,
        connectedAt: tokens?.connectedAt ? new Date(tokens.connectedAt) : new Date()
    };
    return this.save();
};

// Disconnect platform method
userSchema.methods.disconnectPlatform = function (platform) {
    this.connectedPlatforms[platform] = undefined;
    return this.save();
};

// Check if platform is connected
userSchema.methods.isPlatformConnected = function (platform) {
    return this.connectedPlatforms[platform] &&
        this.connectedPlatforms[platform].accessToken;
};

// Get platform tokens
userSchema.methods.getPlatformTokens = function (platform) {
    return this.connectedPlatforms[platform] || null;
};

// Sanitize user data for API response
userSchema.methods.toJSON = function () {
    const obj = this.toObject();
    delete obj.password;

    // Convert connected platforms to boolean status
    obj.connectedPlatforms = Object.keys(obj.connectedPlatforms || {}).reduce((acc, key) => {
        acc[key] = !!(obj.connectedPlatforms[key] && obj.connectedPlatforms[key].accessToken);
        return acc;
    }, {});

    return obj;
};

// Add transfer to history
userSchema.methods.addTransfer = function (transfer) {
    this.transferHistory.push(transfer);
    return this.save();
};

const User = mongoose.model('User', userSchema);

module.exports = User;
