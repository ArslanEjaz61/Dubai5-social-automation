require('dotenv').config();
const cron = require('node-cron');
const logger = require('./logger');
const { scrapeArticles } = require('./scraper');
const { postToLinkedIn } = require('./posters/linkedin');
const { postToTwitter } = require('./posters/twitter');
const { postToFacebook } = require('./posters/facebook');
const { postToInstagram } = require('./posters/instagram');
const { getArticleByIndex, wasPosted, getStats } = require('./queue');
const { downloadSessionsFromSupabase } = require('./sessions_db');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Dubai';

// ── Platform feature flags (disable a platform by setting env to 'false') ──
const PLATFORMS = {
  linkedin:  process.env.ENABLE_LINKEDIN  !== 'false',
  twitter:   process.env.ENABLE_TWITTER   !== 'false',
  facebook:  process.env.ENABLE_FACEBOOK  !== 'false',
  instagram: process.env.ENABLE_INSTAGRAM !== 'false',
};

/**
 * Initialize Cloud Sessions
 */
async function initSessions() {
  logger.info('🔄 Checking for latest cloud sessions...');
  await downloadSessionsFromSupabase();
}

initSessions();

logger.info('╔══════════════════════════════════════════════════════╗');
logger.info('║      Dubai5 Social Automation — Started 🚀            ║');
logger.info(`║      Timezone : ${TIMEZONE.padEnd(37)}║`);
logger.info(`║      LinkedIn : ${(PLATFORMS.linkedin  ? '✅ Enabled' : '⛔ Disabled').padEnd(37)}║`);
logger.info(`║      Twitter  : ${(PLATFORMS.twitter   ? '✅ Enabled' : '⛔ Disabled').padEnd(37)}║`);
logger.info(`║      Facebook : ${(PLATFORMS.facebook  ? '✅ Enabled' : '⛔ Disabled').padEnd(37)}║`);
logger.info(`║      Instagram: ${(PLATFORMS.instagram ? '✅ Enabled' : '⛔ Disabled').padEnd(37)}║`);
logger.info('╚══════════════════════════════════════════════════════╝');

/**
 * Post a single article to all enabled platforms
 */
async function postArticle(articleIndex) {
  logger.info(`\n${'═'.repeat(52)}`);
  logger.info(`📣  Posting Article #${articleIndex + 1} to all platforms`);
  logger.info(`${'═'.repeat(52)}`);

  const article = await getArticleByIndex(articleIndex);
  if (!article) {
    logger.warn(`⚠️  No article at index ${articleIndex}. Skipping.`);
    return;
  }

  logger.info(`📰  "${article.title}"`);

  const results = {};

  // ── LinkedIn ─────────────────────────────────────────────────
  if (PLATFORMS.linkedin) {
    if (await wasPosted(articleIndex, 'linkedin')) {
      logger.info('⏭️  LinkedIn: already posted');
    } else {
      try { results.linkedin = await postToLinkedIn(article, articleIndex); }
      catch (e) { logger.error(`LinkedIn error: ${e.message}`); results.linkedin = false; }
    }
  }

  // ── Twitter/X ─────────────────────────────────────────────────
  if (PLATFORMS.twitter) {
    if (await wasPosted(articleIndex, 'twitter')) {
      logger.info('⏭️  Twitter: already posted');
    } else {
      try { results.twitter = await postToTwitter(article, articleIndex); }
      catch (e) { logger.error(`Twitter error: ${e.message}`); results.twitter = false; }
    }
  }

  // ── Facebook ──────────────────────────────────────────────────
  if (PLATFORMS.facebook) {
    if (await wasPosted(articleIndex, 'facebook')) {
      logger.info('⏭️  Facebook: already posted');
    } else {
      try { results.facebook = await postToFacebook(article, articleIndex); }
      catch (e) { logger.error(`Facebook error: ${e.message}`); results.facebook = false; }
    }
  }

  // ── Instagram ─────────────────────────────────────────────────
  if (PLATFORMS.instagram) {
    if (await wasPosted(articleIndex, 'instagram')) {
      logger.info('⏭️  Instagram: already posted');
    } else {
      try { results.instagram = await postToInstagram(article, articleIndex); }
      catch (e) { logger.error(`Instagram error: ${e.message}`); results.instagram = false; }
    }
  }

  // ── Summary ───────────────────────────────────────────────────
  const passed = Object.values(results).filter(Boolean).length;
  const total  = Object.keys(results).length;
  logger.info(`\n📊  Article #${articleIndex + 1} result: ${passed}/${total} platforms posted`);
  Object.entries(results).forEach(([p, ok]) =>
    logger.info(`     ${ok ? '✅' : '❌'}  ${p}`)
  );
}

/**
 * Daily scrape job — runs at 6:05 AM Dubai time
 * Retries every 5 minutes if fewer than 5 articles are found
 */
async function dailyScrape(retryCount = 0) {
  const MAX_RETRIES = 6;
  const RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

  logger.info(`\n🌅  6:05 AM (Try ${retryCount + 1}) — Starting daily scrape of dubai5.space`);

  try {
    const articles = await scrapeArticles();
    
    if (articles.length >= 5) {
      logger.info(`✅  Scrape successful: ${articles.length} articles queued`);
      return articles;
    }

    if (retryCount < MAX_RETRIES) {
      logger.warn(`⚠️  Only found ${articles.length} articles. Retrying in 5 minutes... (${retryCount + 1}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      return dailyScrape(retryCount + 1);
    } else {
      logger.error(`❌  Failed to reach 5 articles after ${MAX_RETRIES} retries. Proceeding with ${articles.length} articles.`);
      return articles;
    }
  } catch (err) {
    logger.error(`Daily scrape attempt ${retryCount + 1} failed:`, err);
    if (retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      return dailyScrape(retryCount + 1);
    }
  }
}

// ============================================================
//  CRON SCHEDULES  (Dubai Time = UTC+4)
// ============================================================
cron.schedule('5 6  * * *', () => dailyScrape(0),   { timezone: TIMEZONE }); // 6:05 AM scrape
cron.schedule('0 7  * * *', () => postArticle(0),   { timezone: TIMEZONE }); // 7:00 AM article 1
cron.schedule('0 8  * * *', () => postArticle(1),   { timezone: TIMEZONE }); // 8:00 AM article 2
cron.schedule('0 9  * * *', () => postArticle(2),   { timezone: TIMEZONE }); // 9:00 AM article 3
cron.schedule('0 10 * * *', () => postArticle(3),   { timezone: TIMEZONE }); // 10:00 AM article 4
cron.schedule('0 11 * * *', () => postArticle(4),   { timezone: TIMEZONE }); // 11:00 AM article 5
// ============================================================

logger.info('\n📅  Schedule (Dubai Time / UTC+4):');
logger.info('     6:05 AM  → Scrape dubai5.space (with retries)');
logger.info('     7:00 AM  → Post Article 1 → All platforms');
logger.info('     8:00 AM  → Post Article 2 → All platforms');
logger.info('     9:00 AM  → Post Article 3 → All platforms');
logger.info('    10:00 AM  → Post Article 4 → All platforms');
logger.info('    11:00 AM  → Post Article 5 → All platforms');
logger.info('\n🟢  Scheduler running. Ctrl+C to stop.\n');

// Start dashboard
try { require('./dashboard-server'); }
catch (e) { logger.warn('Dashboard not started:', e.message); }

// Graceful shutdown & error handling
process.on('SIGINT', () => { logger.info('\n👋 Shutting down...'); process.exit(0); });
process.on('uncaughtException',   err => logger.error('Uncaught exception:', err));
process.on('unhandledRejection',  err => logger.error('Unhandled rejection:', err));
