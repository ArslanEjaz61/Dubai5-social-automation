const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = './sessions';
const ENV_FILE = '.env';

try {
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.error('❌ sessions directory not found.');
    process.exit(1);
  }

  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const payload = {};

  for (const file of files) {
    const platform = file.replace('.json', '');
    const cookies = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
    payload[platform] = cookies;
    console.log(`📦 Loaded ${platform}`);
  }

  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  let envContent = '';
  
  if (fs.existsSync(ENV_FILE)) {
    envContent = fs.readFileSync(ENV_FILE, 'utf8');
  }

  const payloadLine = `SESSION_PAYLOAD="${b64}"`;

  if (envContent.includes('SESSION_PAYLOAD=')) {
    // Replace existing line
    envContent = envContent.replace(/SESSION_PAYLOAD=".*?"/g, payloadLine);
  } else {
    // Append to end
    envContent += `\n${payloadLine}\n`;
  }

  fs.writeFileSync(ENV_FILE, envContent);
  console.log('✅ Server .env updated with new SESSION_PAYLOAD');
  process.exit(0);

} catch (err) {
  console.error('❌ Failed to update .env:', err.message);
  process.exit(1);
}
