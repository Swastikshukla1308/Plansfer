require('dotenv').config({ path: '../.env' });
const { OpenAI } = require('openai');

async function test() {
    console.log("Key prefix:", process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.substring(0, 10) : 'MISSING');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'Say hello' }]
        });
        console.log("Success:", response.choices[0].message.content);
    } catch (e) {
        console.error("OpenAI Error:", e.status, e.message, e.code);
    }
}
test();
