const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        // Check if MongoDB URI is configured
        if (!process.env.MONGODB_URI) {
            console.log('⚠️ MongoDB URI not configured. Using in-memory storage.');
            console.log('   Set MONGODB_URI in .env for persistent storage.');
            return false;
        }

        const conn = await mongoose.connect(process.env.MONGODB_URI, {
            // These options are defaults in Mongoose 6+, included for clarity
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });

        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
        return true;
    } catch (error) {
        console.error(`❌ MongoDB Connection Error: ${error.message}`);
        console.log('   Falling back to in-memory storage.');
        return false;
    }
};

module.exports = connectDB;
