/**
 * scraper.js — Supabase Direct Fetch (replaces Puppeteer scraper)
 *
 * Fetches today's 5 published articles from Supabase, downloads their
 * hero images, and saves everything to the local queue for the scheduler.
 *
 * Table: articles
 * Key columns used:
 *   id, headline, summary, social_caption, hero_image,
 *   brief_date, status, tags, category, signal_tag, impact_score
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const path = require('path');
const fs = require('fs-extra');
const logger = require('./logger');
const { saveQueue } = require('./queue');

// ── Supabase client ────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  logger.error('❌ SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const IMAGES_DIR = path.join(__dirname, 'state', 'images');
fs.ensureDirSync(IMAGES_DIR);

/** Max wall-clock wait for a full image stream (axios timeout may not cover slow bodies). */
const IMAGE_DOWNLOAD_MS = 45_000;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Get today's date in Dubai timezone (YYYY-MM-DD) */
function getTodayDubai() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TIMEZONE || 'Asia/Dubai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()); // returns YYYY-MM-DD
}

/** Download image from URL and cache locally */
async function downloadImage(imageUrl, filename) {
  if (!imageUrl) return null;
  try {
    const filePath = path.join(IMAGES_DIR, filename);
    if (await fs.pathExists(filePath)) {
      const stats = await fs.stat(filePath);
      if (stats.size > 100 * 1024) {
        logger.info(`📷 Image cached: ${filename} (${Math.round(stats.size/1024)}KB)`);
        return filePath;
      }
      logger.warn(`⚠️ Cached image for ${filename} is too small (${stats.size} bytes). Re-downloading...`);
      await fs.remove(filePath);
    }
    const response = await axios({
      method: 'GET',
      url: imageUrl,
      responseType: 'stream',
      timeout: 30000,
      headers: { 'User-Agent': 'Dubai5-SocialBot/1.0' }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { response.data.destroy(); } catch (_) {}
        reject(new Error(`image stream exceeded ${IMAGE_DOWNLOAD_MS}ms`));
      }, IMAGE_DOWNLOAD_MS);
      const writer = fs.createWriteStream(filePath);
      const done = (fn) => (arg) => {
        clearTimeout(timer);
        fn(arg);
      };
      response.data.pipe(writer);
      writer.on('finish', done(resolve));
      writer.on('error', done(reject));
      response.data.on('error', done(reject));
    });
    logger.info(`✅ Image downloaded: ${filename}`);
    return filePath;
  } catch (err) {
    try { await fs.remove(filePath); } catch (_) {}
    logger.warn(`⚠️ Image download failed (${imageUrl}): ${err.message}`);
    return null;
  }
}

/** Get the real article URL — prefer article_url from Supabase DB */
function getArticleUrl(article) {
  if (article.article_url && article.article_url.length > 10) {
    return article.article_url;
  }
  const base = process.env.WEBSITE_URL || 'https://dubai5.space';
  return `${base}/article/${article.id}`;
}

/** Build a rich social caption using Supabase data */
function buildSocialCaption(article) {
  const realUrl = getArticleUrl(article);

  if (article.social_caption && article.social_caption.length > 20) {
    let caption = article.social_caption;
    // Replace any existing URLs with the real article_url from DB
    caption = caption.replace(/https?:\/\/\S+/g, '').trim();
    caption += `\n\n🔗 ${realUrl}`;
    return caption;
  }

  const { headline, summary, tags } = article;
  let caption = `🔮 ${headline}\n\n`;
  if (summary) caption += `${summary.substring(0, 400)}\n\n`;
  caption += `🌆 Dubai's Future, Decoded Daily.\n`;
  caption += `🔗 ${realUrl}\n\n`;

  const hashTags = (tags || [])
    .map(t => `#${t.replace(/\s+/g, '')}`)
    .join(' ');
  caption += `${hashTags} #Dubai #DubaiFuture #UAE`;

  return caption;
}

// ── Main fetch function ────────────────────────────────────────────────────

/**
 * Fetch today's articles from Supabase and save to local queue.
 * Falls back to yesterday if today has no published articles yet
 * (e.g. run at 6AM but articles were published at 5:55AM UTC+4).
 */
async function scrapeArticles() {
  const today = getTodayDubai();
  logger.info(`📅 Fetching articles for ${today} from Supabase...`);

  // ── Query Supabase ─────────────────────────────────────────────
  // Fetch latest 5 published articles regardless of specific date (gives the newest)
  let { data: articles, error } = await supabase
    .from('articles')
    .select('id, headline, summary, social_caption, hero_image, og_image, brief_date, tags, category, signal_tag, impact_score, status, article_url')
    .eq('status', 'published')
    .order('brief_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    logger.error(`❌ Supabase query error: ${error.message}`);
    return [];
  }

  // Because order is descending (newest to oldest), but we want to process sequentially,
  // we could optionally reverse them, but descending ensures we ALWAYS have data.
  if (!articles || articles.length === 0) {
    logger.warn(`⚠️ No published articles found universally.`);
    return [];
  }

  logger.info(`📰 Found ${articles.length} latest articles from Supabase`);

  // ── Build queue rows first (no image I/O) so today's date is on disk before 7 AM posts ──
  const processed = [];
  const dateStr = today;

  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    const imageToUse = art.og_image || art.hero_image;

    logger.info(`  [${i + 1}] "${art.headline?.substring(0, 65)}..."`);
    processed.push({
      index: i,
      id: art.id,
      title: art.headline,
      description: art.summary,
      socialCaption: buildSocialCaption(art),
      imageUrl: imageToUse,
      localImagePath: null,
      articleUrl: getArticleUrl(art),
      category: art.category,
      tags: art.tags || [],
      signalTag: art.signal_tag,
      impactScore: art.impact_score,
      briefDate: art.brief_date,
      scrapedAt: new Date().toISOString()
    });
  }

  await saveQueue(processed);
  logger.info(`✅ Queue saved (${processed.length} articles for ${today}) — downloading images…`);

  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    const imageToUse = art.og_image || art.hero_image;
    if (!imageToUse) continue;

    const ext = imageToUse.split('.').pop().split('?')[0] || 'png';
    const filename = `${dateStr}-${art.id}.${ext}`;
    processed[i].localImagePath = await downloadImage(imageToUse, filename);
  }

  await saveQueue(processed);
  logger.info(`\n🎉 Supabase fetch complete! ${processed.length} articles ready in queue.\n`);
  return processed;
}

// ── Run directly ───────────────────────────────────────────────────────────
if (require.main === module) {
  scrapeArticles()
    .then(articles => {
      if (articles.length > 0) {
        console.log('\n── Article Summary ──────────────────────────────────');
        articles.forEach((a, i) =>
          console.log(`  ${i + 1}. [${a.briefDate}] ${a.title}`)
        );
        console.log(`\n✅ ${articles.length} articles saved to state/queue.json`);
      }
      setTimeout(() => process.exit(0), 500); // Wait out any dangling async TLS handles to avoid assertion panic
    })
    .catch(err => {
      console.error('Fatal error:', err);
      setTimeout(() => process.exit(1), 500);
    });
}

module.exports = { scrapeArticles };
