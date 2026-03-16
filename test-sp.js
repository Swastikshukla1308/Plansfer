const mongoose = require('mongoose');
require('dotenv').config();
mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI)
  .then(async () => {
    const User = require('./backend/models/UserMongo');
    const users = await User.find();
    console.log("Users:", users.map(u => ({ id: u._id, sp: u.connectedPlatforms?.spotify })));
    process.exit(0);
  });
