/**
 * post-all-now.js — Post all 5 queued articles immediately
 * Usage: node post-all-now.js [--linkedin-only] [--twitter-only]
 */
require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');
const { postToLinkedIn } = require('./posters/linkedin');
const { postToTwitter } = require('./posters/twitter');
const { getArticleByIndex, wasPosted } = require('./queue');

const DELAY_BETWEEN_ARTICLES = 20000;
const args = process.argv.slice(2);
const linkedinOnly = args.includes('--linkedin-only');
const twitterOnly = args.includes('--twitter-only');

const doLinkedIn = !twitterOnly && process.env.ENABLE_LINKEDIN !== 'false';
const doTwitter = !linkedinOnly && process.env.ENABLE_TWITTER !== 'false';

const twitterCookiesExist = fs.pathExistsSync(path.join(__dirname, 'sessions', 'twitter.json'));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function postAllNow() {
  logger.info('╔══════════════════════════════════════════════════════╗');
  logger.info('║        POST ALL NOW — 5 articles immediately        ║');
  logger.info('╚══════════════════════════════════════════════════════╝');
  logger.info(`LinkedIn: ${doLinkedIn ? '✅' : '⛔'} | Twitter: ${doTwitter ? '✅' : '⛔'}`);

  if (doTwitter && !twitterCookiesExist) {
    logger.warn('⚠️ No Twitter cookies found! Run "node setup.js" to log in manually first.');
  }

  const results = { linkedin: [], twitter: [] };

  for (let i = 0; i < 5; i++) {
    const article = await getArticleByIndex(i);
    if (!article) {
      logger.warn(`⚠️ No article at index ${i} — skipping`);
      continue;
    }

    logger.info(`\n${'═'.repeat(60)}`);
    logger.info(`📣 Article ${i + 1}/5: "${article.title.substring(0, 55)}..."`);
    logger.info(`🔗 ${article.articleUrl}`);
    logger.info(`${'═'.repeat(60)}`);

    // LinkedIn
    if (doLinkedIn) {
      if (await wasPosted(i, 'linkedin')) {
        logger.info(`⏭️ LinkedIn Article ${i + 1}: already posted`);
      } else {
        try {
          const ok = await postToLinkedIn(article, i);
          results.linkedin.push({ index: i, success: ok });
        } catch (e) {
          logger.error(`LinkedIn Article ${i + 1}: ${e.message}`);
          results.linkedin.push({ index: i, success: false });
        }
        await sleep(5000);
      }
    }

    // Twitter
    if (doTwitter) {
      if (await wasPosted(i, 'twitter')) {
        logger.info(`⏭️ Twitter Article ${i + 1}: already posted`);
      } else {
        try {
          const ok = await postToTwitter(article, i);
          results.twitter.push({ index: i, success: ok });
        } catch (e) {
          logger.error(`Twitter Article ${i + 1}: ${e.message}`);
          results.twitter.push({ index: i, success: false });
        }
        await sleep(5000);
      }
    }

    if (i < 4) {
      logger.info(`\n⏳ Waiting ${DELAY_BETWEEN_ARTICLES / 1000}s before next article...`);
      await sleep(DELAY_BETWEEN_ARTICLES);
    }
  }

  logger.info('\n╔══════════════════════════════════════════════════════╗');
  logger.info('║                   FINAL SUMMARY                      ║');
  logger.info('╚══════════════════════════════════════════════════════╝');
  
  if (doLinkedIn) {
    const ok = results.linkedin.filter(r => r.success).length;
    logger.info(`LinkedIn: ${ok}/${results.linkedin.length} posted`);
  }
  if (doTwitter) {
    const ok = results.twitter.filter(r => r.success).length;
    logger.info(`Twitter:  ${ok}/${results.twitter.length} posted`);
  }

  setTimeout(() => process.exit(0), 1000);
}

postAllNow().catch(err => {
  logger.error('Fatal error:', err);
  setTimeout(() => process.exit(1), 500);
});
