require('dotenv').config({ path: '../.env' });
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function testParse() {
    const prompt = "Romantic songs of K.K.";
    const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const systemPrompt = `You are an expert music curator. The user wants a playlist based on this prompt: "${prompt}".
Generate a list of exactly 12 real, existing playable songs that perfectly match this prompt.

Return ONLY a valid JSON object (no markdown, no backticks) with this exact format:
{
    "playlistName": "A catchy name for the playlist",
    "description": "A short, fitting description",
    "genres": ["genre1", "genre2"],
    "mood": "happy|sad|energetic|calm|romantic|angry|focused",
    "tracks": [
        { "name": "Song Title", "artist": "Artist Name", "album": "Album Name (if known)" }
    ]
}`;

    try {
        let text = null;
        console.log("SENDING REQUEST TO GEMINI 2.5 FLASH...");
        const model = gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent(systemPrompt);
        const response = await result.response;
        text = response.text().trim();
        console.log("SUCCESSFULLY RECEIVED RESPONSE FROM GEMINI 2.5 FLASH");

        console.log("--- RAW AI RESPONSE BELOW ---");
        console.log(text);
        console.log("-----------------------------");

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.tracks && Array.isArray(parsed.tracks)) {
                console.log("Successfully parsed JSON payload with", parsed.tracks.length, "tracks.");
            } else {
                console.log("JSON parsed successfully but tracks array is missing or invalid.");
            }
        } else {
             console.log("REGEX MATCH FAILED: No JSON object found in response string.");
        }
    } catch (e) {
        console.error("Error generating:", e);
    }
}
testParse();
