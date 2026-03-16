/**
 * Unified User Model
 * Uses MongoDB when available, falls back to in-memory storage
 */

const mongoose = require('mongoose');
const MongoUser = require('./UserMongo');

// In-memory storage for fallback
const inMemoryUsers = new Map();
let userIdCounter = 1;

// In-memory User class (when MongoDB is not available)
class InMemoryUser {
    constructor({ name, email, password }) {
        this.id = userIdCounter++;
        this._id = this.id.toString(); // For consistent API
        this.name = name;
        this.email = email;
        this.password = password;
        this.connectedPlatforms = {
            spotify: null,
            youtube: null,
            deezer: null,
            appleMusic: null
        };
        this.transferHistory = [];
        this.createdAt = new Date();
        this.updatedAt = new Date();
    }

    async save() {
        this.updatedAt = new Date();
        inMemoryUsers.set(this.id, this);
        return this;
    }

    connectPlatform(platform, tokens) {
        this.connectedPlatforms[platform] = {
            ...tokens,
            connectedAt: tokens?.connectedAt
                ? new Date(tokens.connectedAt)
                : new Date()
        };
        this.updatedAt = new Date();
        return this;
    }

    disconnectPlatform(platform) {
        this.connectedPlatforms[platform] = null;
        this.updatedAt = new Date();
        return this;
    }

    isPlatformConnected(platform) {
        return this.connectedPlatforms[platform] !== null &&
            this.connectedPlatforms[platform].accessToken;
    }

    getPlatformTokens(platform) {
        return this.connectedPlatforms[platform];
    }

    async comparePassword(candidatePassword) {
        const bcrypt = require('bcryptjs');
        return bcrypt.compare(candidatePassword, this.password);
    }

    addTransfer(transfer) {
        this.transferHistory.push({
            ...transfer,
            createdAt: new Date()
        });
        return this;
    }

    toJSON() {
        return {
            id: this.id,
            _id: this._id,
            name: this.name,
            email: this.email,
            connectedPlatforms: Object.keys(this.connectedPlatforms).reduce((acc, key) => {
                acc[key] = this.connectedPlatforms[key] !== null;
                return acc;
            }, {}),
            transferHistory: this.transferHistory,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt
        };
    }
}

// Check if MongoDB is connected
const isMongoConnected = () => {
    return mongoose.connection.readyState === 1;
};

// Unified User Model API
const UserModel = {
    // Create a new user
    create: async (userData) => {
        if (isMongoConnected()) {
            return await MongoUser.create(userData);
        }

        // In-memory fallback with password hashing
        const bcrypt = require('bcryptjs');
        const hashedPassword = await bcrypt.hash(userData.password, 10);
        const user = new InMemoryUser({
            ...userData,
            password: hashedPassword
        });
        inMemoryUsers.set(user.id, user);
        return user;
    },

    // Find user by ID
    findById: async (id) => {
        if (isMongoConnected()) {
            if (mongoose.isValidObjectId(id)) {
                return await MongoUser.findById(id);
            }
            return null;
        }
        return inMemoryUsers.get(parseInt(id)) || null;
    },

    // Find user by ID with password (for authentication)
    findByIdWithPassword: async (id) => {
        if (isMongoConnected()) {
            if (mongoose.isValidObjectId(id)) {
                return await MongoUser.findById(id).select('+password');
            }
            return null;
        }
        return inMemoryUsers.get(parseInt(id)) || null;
    },

    // Find user by email
    findByEmail: async (email) => {
        if (isMongoConnected()) {
            return await MongoUser.findOne({ email: email.toLowerCase() });
        }
        return Array.from(inMemoryUsers.values())
            .find(user => user.email.toLowerCase() === email.toLowerCase()) || null;
    },

    // Find user by email with password
    findByEmailWithPassword: async (email) => {
        if (isMongoConnected()) {
            return await MongoUser.findOne({ email: email.toLowerCase() }).select('+password');
        }
        return Array.from(inMemoryUsers.values())
            .find(user => user.email.toLowerCase() === email.toLowerCase()) || null;
    },

    // Update user
    update: async (id, updates) => {
        if (isMongoConnected()) {
            return await MongoUser.findByIdAndUpdate(id, updates, { new: true });
        }

        const user = inMemoryUsers.get(parseInt(id));
        if (user) {
            Object.assign(user, updates);
            user.updatedAt = new Date();
            return user;
        }
        return null;
    },

    // Delete user
    delete: async (id) => {
        if (isMongoConnected()) {
            return await MongoUser.findByIdAndDelete(id);
        }
        return inMemoryUsers.delete(parseInt(id));
    },

    // Check if using MongoDB
    isUsingMongoDB: () => isMongoConnected()
};

module.exports = UserModel;
