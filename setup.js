require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const logger = require('./logger');
const { launchBrowser } = require('./browser');

const SESSIONS_DIR = path.join(__dirname, 'sessions');
fs.ensureDirSync(SESSIONS_DIR);

/** Save browser cookies to file */
async function saveCookies(page, platform) {
  const cookies = await page.cookies();
  const filePath = path.join(SESSIONS_DIR, `${platform}.json`);
  await fs.writeJson(filePath, cookies, { spaces: 2 });
  logger.info(`💾 Session saved for ${platform}`);
}

/** Load cookies for a platform */
async function loadCookies(page, platform) {
  const filePath = path.join(SESSIONS_DIR, `${platform}.json`);
  if (!await fs.pathExists(filePath)) return false;
  const cookies = await fs.readJson(filePath);
  if (cookies.length === 0) return false;
  await page.setCookie(...cookies);
  logger.info(`🍪 Session loaded for ${platform}`);
  return true;
}

/** Check if logged in */
async function isLoggedIn(page, platform) {
  const url = page.url();
  if (platform === 'linkedin') {
    if (url.includes('/login') || url.includes('/checkpoint') || url.includes('/authwall')) return false;
    if (url.includes('/feed')) return true; // Definitely logged in!
    // Real check: look for the global nav or profile icon or the feed
    try {
      await page.waitForSelector('#global-nav, .global-nav, .profile-rail-card', { timeout: 10000 });
      return true;
    } catch(e) { return false; }
  }
  if (platform === 'twitter') return !url.includes('/login') && !url.includes('/i/flow');
  if (platform === 'facebook') return !url.includes('/login') && !url.includes('login.php');
  if (platform === 'instagram') return !url.includes('/accounts/login');
  return false;
}

/**
 * Open browser VISIBLY for manual login — called once during setup
 */
async function setupPlatformLogin(platform, loginUrl) {
  logger.info(`\n🔐 Opening ${platform} for manual login...`);
  logger.info('👉 Log in manually in the browser window.');
  logger.info('👉 After FULLY logged in, press ENTER in this terminal.\n');

  const { browser, page } = await launchBrowser(false); // visible
  await page.goto(loginUrl, { waitUntil: 'networkidle2' });

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdout.write(`\n✅ Press ENTER after logging in to ${platform}: `);
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });

  await saveCookies(page, platform);
  logger.info(`✅ ${platform} session saved!`);
  await browser.close();
  return true;
}

/** Helper: ask yes/no in terminal */
async function askYesNo(question) {
  return new Promise(resolve => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdout.write(question + ' (y/N): ');
    process.stdin.once('data', data => {
      process.stdin.pause();
      resolve(data.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Main setup flow — configure platforms one by one
 */
async function runSetup() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║    Dubai5 Social Automation — Platform Setup 🔮   ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const platforms = [
    { name: 'linkedin',  url: 'https://www.linkedin.com/login',            label: 'LinkedIn' },
    { name: 'twitter',   url: 'https://x.com/login',                       label: 'X (Twitter)' },
    { name: 'facebook',  url: 'https://www.facebook.com/',                  label: 'Facebook' },
    { name: 'instagram', url: 'https://www.instagram.com/accounts/login/',  label: 'Instagram' },
  ];

  for (const platform of platforms) {
    const sessionFile = path.join(SESSIONS_DIR, `${platform.name}.json`);
    const exists = await fs.pathExists(sessionFile);

    console.log(`\n── ${platform.label} ───────────────────────────`);

    if (exists) {
      const relogin = await askYesNo(`  Session exists. Re-login to ${platform.label}?`);
      if (!relogin) { console.log(`  ⏭️  Skipping ${platform.label}`); continue; }
    } else {
      const doLogin = await askYesNo(`  Setup ${platform.label} now?`);
      if (!doLogin) { console.log(`  ⏭️  Skipping ${platform.label}`); continue; }
    }

    await setupPlatformLogin(platform.name, platform.url);
  }

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║              Setup Complete! 🎉                    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  
  const pushToCloud = await askYesNo('☁️  Upload all verified sessions to Supabase?');
  if (pushToCloud) {
    const { uploadSessionsToSupabase } = require('./sessions_db');
    await uploadSessionsToSupabase();
  }

  console.log('\nCommands:');
  console.log('  npm start               → Start full scheduler');
  console.log('  node scraper.js         → Test article scraper');
  console.log('  npm run post:linkedin   → Test LinkedIn post');
  console.log('  npm run post:twitter    → Test X post');
  console.log('  npm run post:facebook   → Test Facebook post');
  console.log('  npm run post:instagram  → Test Instagram post\n');
  process.exit(0);
}

if (require.main === module) {
  runSetup().catch(err => { console.error('Setup failed:', err); process.exit(1); });
}

module.exports = { saveCookies, loadCookies, isLoggedIn, setupPlatformLogin };
