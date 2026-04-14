require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

const QUEUE_FILE = path.join(__dirname, 'state', 'queue.json');
const POSTED_FILE = path.join(__dirname, 'state', 'posted.json');

fs.ensureDirSync(path.join(__dirname, 'state'));

/** Get today's date in Dubai timezone (YYYY-MM-DD) — consistent with scraper.js */
function getTodayDubai() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TIMEZONE || 'Asia/Dubai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

/**
 * Save scraped articles to the daily queue
 * @param {Array} articles - Array of article objects
 */
async function saveQueue(articles) {
  const today = getTodayDubai();
  const queue = {
    date: today,
    articles: articles,
    createdAt: new Date().toISOString()
  };
  await fs.writeJson(QUEUE_FILE, queue, { spaces: 2 });
  logger.info(`✅ Queue saved: ${articles.length} articles for ${today}`);
}

/**
 * Get today's article queue
 * @returns {Array} articles or empty array
 */
async function getQueue() {
  try {
    if (!await fs.pathExists(QUEUE_FILE)) {
      logger.warn('No queue file found');
      return [];
    }
    const queue = await fs.readJson(QUEUE_FILE);
    const today = getTodayDubai();
    
    if (queue.date !== today) {
      logger.warn(`Queue is from ${queue.date}, not today (${today})`);
      return [];
    }
    return queue.articles;
  } catch (err) {
    logger.error('Failed to read queue:', err);
    return [];
  }
}

/**
 * Get article at a specific index from today's queue
 * @param {number} index - 0-based index
 * @returns {Object|null} article or null
 */
async function getArticleByIndex(index) {
  const articles = await getQueue();
  if (index >= articles.length) {
    logger.warn(`Article index ${index} out of range (queue has ${articles.length})`);
    return null;
  }
  return articles[index];
}

/**
 * Mark an article as posted on a specific platform
 * @param {number} index - article index
 * @param {string} platform - platform name (linkedin, instagram, etc.)
 * @param {boolean} success - whether posting was successful
 */
async function markPosted(index, platform, success = true, errorMsg = null) {
  let posted = {};
  const today = getTodayDubai();
  
  try {
    if (await fs.pathExists(POSTED_FILE)) {
      posted = await fs.readJson(POSTED_FILE);
    }
  } catch (e) {}

  if (!posted[today]) posted[today] = {};
  if (!posted[today][index]) posted[today][index] = {};
  
  posted[today][index][platform] = {
    success,
    timestamp: new Date().toISOString(),
    error: errorMsg
  };

  await fs.writeJson(POSTED_FILE, posted, { spaces: 2 });
  logger.info(`📝 Marked article ${index} as ${success ? 'POSTED' : 'FAILED'} on ${platform}`);
}

/**
 * Check if article was already posted on a platform today
 * @param {number} index - article index
 * @param {string} platform - platform name
 * @returns {boolean}
 */
async function wasPosted(index, platform) {
  try {
    if (!await fs.pathExists(POSTED_FILE)) return false;
    const posted = await fs.readJson(POSTED_FILE);
    const today = getTodayDubai();
    return posted[today]?.[index]?.[platform]?.success === true;
  } catch (e) {
    return false;
  }
}

/**
 * Get full posting stats for dashboard
 */
async function getStats() {
  const articles = await getQueue();
  let posted = {};
  const today = getTodayDubai();
  
  try {
    if (await fs.pathExists(POSTED_FILE)) {
      const data = await fs.readJson(POSTED_FILE);
      posted = data[today] || {};
    }
  } catch (e) {}

  return {
    date: today,
    total: articles.length,
    articles: articles.map((article, i) => ({
      index: i,
      id: article.id,
      title: article.title,
      socialCaption: article.socialCaption,
      category: article.category,
      impactScore: article.impactScore,
      signalTag: article.signalTag,
      localImagePath: article.localImagePath ? path.basename(article.localImagePath) : null,
      postedOn: posted[i] || {}
    }))
  };
}

module.exports = { saveQueue, getQueue, getArticleByIndex, markPosted, wasPosted, getStats };
