const fs = require('fs-extra');
const path = require('path');

const SESSIONS_DIR = path.join(__dirname, 'sessions');

async function generatePayload() {
  try {
    if (!await fs.pathExists(SESSIONS_DIR)) {
      console.error('❌ sessions directory not found.');
      return;
    }

    const files = await fs.readdir(SESSIONS_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    
    const payload = {};

    for (const file of jsonFiles) {
      const platform = file.replace('.json', '');
      const cookies = await fs.readJson(path.join(SESSIONS_DIR, file));
      payload[platform] = cookies;
    }

    const jsonString = JSON.stringify(payload);
    const base64 = Buffer.from(jsonString).toString('base64');

    console.log('\n╔════════════════════════════════════════════════════════════════════╗');
    console.log('║                DUBAI5 SESSION PAYLOAD GENERATOR 🔮                 ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝\n');
    console.log('Copy the string below and paste it into your .env as SESSION_PAYLOAD:\n');
    console.log('--- START PAYLOAD ---');
    console.log(base64);
    console.log('--- END PAYLOAD ---\n');
    console.log('Total characters:', base64.length);
    console.log('\nInstructions:');
    console.log('1. Copy the long string.');
    console.log('2. Open your server .env file.');
    console.log('3. Add: SESSION_PAYLOAD="<YOUR_STRING_HERE>"');
    console.log('4. Save and start the bot.\n');

  } catch (err) {
    console.error('❌ Failed to generate payload:', err.message);
  }
}

generatePayload();
