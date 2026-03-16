const jwt = require('jsonwebtoken');
const UserModel = require('../models/User');

// Middleware to verify JWT token
const authMiddleware = async (req, res, next) => {
    try {
        // Get token from header or cookie
        const token = req.headers.authorization?.split(' ')[1] || req.cookies.token;

        if (!token) {
            return res.status(401).json({
                error: {
                    message: 'Authentication required',
                    status: 401
                }
            });
        }

        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Get user from database
        const user = await UserModel.findById(decoded.userId);

        if (!user) {
            return res.status(401).json({
                error: {
                    message: 'User not found',
                    status: 401
                }
            });
        }

        // Attach user to request
        req.user = user;
        req.userId = decoded.userId;

        next();
    } catch (error) {
        console.error('Auth middleware error:', error);

        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                error: {
                    message: 'Invalid token',
                    status: 401
                }
            });
        }

        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                error: {
                    message: 'Token expired',
                    status: 401
                }
            });
        }

        return res.status(500).json({
            error: {
                message: 'Authentication failed',
                status: 500
            }
        });
    }
};

module.exports = authMiddleware;
