const jwt = require('jsonwebtoken');
const UserModel = require('../models/User');

/**
 * Optional auth middleware — attaches user to request if a valid JWT is present,
 * but does NOT block the request if no token or invalid token is provided.
 * Use this for endpoints that work for both authenticated and unauthenticated users.
 */
const optionalAuthMiddleware = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1] || req.cookies.token;

        if (!token) {
            return next(); // No token — proceed without user
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await UserModel.findById(decoded.userId);

        if (user) {
            req.user = user;
            req.userId = decoded.userId;
        }

        next();
    } catch (error) {
        // Token invalid/expired — proceed without user
        next();
    }
};

module.exports = optionalAuthMiddleware;
