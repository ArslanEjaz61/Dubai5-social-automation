require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

const SESSIONS_DIR = path.join(__dirname, 'sessions');

/**
 * Sync sessions from the SESSION_PAYLOAD environment variable
 */
async function downloadSessionsFromSupabase() { // Keeping same name for compatibility
  const payload = process.env.SESSION_PAYLOAD;
  
  if (!payload) {
    logger.info('ℹ️  No SESSION_PAYLOAD found in .env. Skipping cloud sync.');
    return false;
  }

  logger.info('🔄 Extracting sessions from SESSION_PAYLOAD...');
  try {
    const jsonString = Buffer.from(payload, 'base64').toString('utf8');
    const sessions = JSON.parse(jsonString);

    await fs.ensureDir(SESSIONS_DIR);

    for (const [platform, cookies] of Object.entries(sessions)) {
      const filePath = path.join(SESSIONS_DIR, `${platform}.json`);
      await fs.writeJson(filePath, cookies, { spaces: 2 });
      logger.info(`  ✅ Restored session for ${platform}`);
    }

    logger.info('🎉 All sessions restored from environment variable!');
    return true;
  } catch (err) {
    logger.error('❌ Failed to extract session payload:', err.message);
    return false;
  }
}

/**
 * Placeholder for future upload sync
 */
async function uploadSessionsToSupabase() {
  logger.info('ℹ️  Base64 Sync is manual. Run "node sync-sessions.js" to get a new payload string.');
  return true;
}

module.exports = { 
  downloadSessionsFromSupabase, 
  uploadSessionsToSupabase 
};
