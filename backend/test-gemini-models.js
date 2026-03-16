require('dotenv').config({ path: '../.env' });

async function listModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.models) {
            console.log("Available Gemini Models:");
            data.models.forEach(m => {
                if (m.supportedGenerationMethods.includes('generateContent')) {
                    console.log(`- ${m.name}`);
                }
            });
        } else {
            console.error("Failed to list models:", data);
        }
    } catch (e) {
        console.error("Fetch error:", e.message);
    }
}
listModels();
