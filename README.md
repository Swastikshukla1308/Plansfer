# Plansfer (MusiKTransfer)

Plansfer is a powerful, full-stack web application designed to seamlessly transfer your music playlists across different streaming platforms. Want to move your favorite Spotify mix to YouTube Music, or transfer a YouTube playlist to Amazon Music? Plansfer automates the process by finding and matching your tracks across platforms.

## 🚀 Features

- **Cross-Platform Transfer:** Support for moving playlists between major streaming services.
- **Smart Song Matching:** Advanced backend intelligence (combining text normalization, fuzzy matching, and duration verification) to ensure the highest transfer accuracy.
- **AI Playlist Creator:** Describe the "vibe" you want (e.g., "A chill lo-fi study mix with a hint of jazz"), and our integrated Google Gemini AI engine generates a custom tracklist ready to be saved to your preferred platform.
- **Real-Time Progress:** See exactly what's happening during your transfers via Server-Sent Events (SSE).
- **Responsive Dark/Light UI:** A clean, modern, and fully responsive user interface built with vanilla HTML/CSS and glassmorphism design principles.

### Supported Platforms
* **Spotify** (Source & Destination)
* **YouTube & YouTube Music** (Source & Destination)
* **Amazon Music** (Source & Destination)*
* **Apple Music** (Source Only — *Destination integration coming soon!*)
* **Deezer** (Source)
* **JioSaavn** (Source)
* **Gaana** (Source)

*\*Amazon Music destination support requires authorized developer keys as the API is currently in closed beta.*

## 🛠️ Architecture

Plansfer is built on a standard JavaScript stack:
- **Frontend:** Vanilla HTML5, CSS3, and modern ES6 JavaScript. No heavy frontend frameworks required. API communications are modularized via `api.js` and `auth.js`.
- **Backend:** Node.js powered by Express.js.
- **Database:** MongoDB (using Mongoose) for persisting user sessions and OAuth tokens. *(Note: Includes an automatic in-memory fallback if MongoDB is not configured during development).*
- **Authentication:** JWT (JSON Web Tokens) for session security combined with strict OAuth 2.0 flows for third-party music providers.
- **AI Integration:** Google Generative AI (Gemini) SDK.

## ⚙️ Setup & Installation

### Prerequisites
- Node.js (v18.0.0 or higher recommended)
- npm (Node Package Manager)
- A MongoDB cluster (e.g., MongoDB Atlas) - *Optional but recommended for production*

### 1. Clone the Repository
```bash
git clone https://github.com/yourusername/musiktransfer.git
cd musiktransfer
```

### 2. Install Dependencies
Navigate to the `backend` directory and install the required Node packages:
```bash
cd backend
npm install
```

### 3. Environment Variables
Create a `.env` file in the root directory (outside the `backend` folder). You will need to populate this file with your own developer API credentials for the various integrations. 

Here is a template to follow:

```env
# Application Settings
PORT=5000
NODE_ENV=development
FRONTEND_URL=http://localhost:5000
JWT_SECRET=your_super_secret_jwt_key_here

# MongoDB Setup
MONGODB_URI=your_mongodb_connection_string

# Google / AI Settings
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
GEMINI_API_KEY=your_gemini_api_key
# OPENAI_API_KEY=your_openai_api_key (Optional alternative to Gemini)

# Spotify API
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret

# YouTube API
YOUTUBE_API_KEY=your_youtube_data_api_key

# Amazon Music API (Required for Amazon Destination)
AMAZON_CLIENT_ID=your_amazon_client_id
AMAZON_CLIENT_SECRET=your_amazon_client_secret

# Apple Music API (For future Destination API)
APPLE_TEAM_ID=your_apple_team_id
APPLE_MUSIC_KEY_ID=your_apple_music_key_id
APPLE_MUSIC_PRIVATE_KEY=your_multiline_p8_private_key_here
```

### 4. Running the Application
Return to the root directory (or stay in `backend`) and start the developer server. Plansfer includes scripts to run using `nodemon` for hot-reloading:

```bash
# In the backend directory
npm run dev
```
The server will start on `http://localhost:5000` (or `5001` if your PORT variable/OS mandates). Navigate to that URL in your browser to start transferring!

## 🔐 Security Note
Plansfer never sees or stores your music platform passwords. Authentication is handled entirely via secure OAuth 2.0 protocols directly with the providers (Spotify, Google, Amazon). We only request permission to read your public playlists and create new playlists on your behalf.

---
**Disclaimer:** *The APIs used by this platform (such as YouTube Data API, Spotify Web API, and various unofficial library endpoints) are subject to rate limiting and changes by their respective parent companies. Transfer speeds and success rates may vary based on catalog availability between platforms.*