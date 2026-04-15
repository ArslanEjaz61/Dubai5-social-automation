require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const logger = require('../logger');
const { launchBrowser } = require('../browser');
const { loadCookies, saveCookies } = require('../setup');
const { markPosted } = require('../queue');

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'logs', 'screenshots', 'facebook');
fs.ensureDirSync(SCREENSHOTS_DIR);

function delay(min = 800, max = 2500) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function screenshot(page, name) {
  try {
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `${Date.now()}-${name}.png`),
      fullPage: false
    });
    logger.info(`📸 Screenshot: ${name}`);
  } catch (e) {}
}

async function waitForSafe(page, selector, timeout = 8000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return await page.$(selector);
  } catch (e) { return null; }
}

function buildPostContent(article) {
  const { title, description, articleUrl } = article;
  let content = `🔮 ${title}\n\n`;
  if (description && description.length > 20) {
    content += `${description.substring(0, 500)}\n\n`;
  }
  content += `🌆 Dubai's Future, Decoded Daily.\n`;
  content += `🔗 ${articleUrl || process.env.WEBSITE_URL || 'https://dubai5.space'}\n\n`;
  content += `#Dubai #DubaiFuture #UAE #Innovation #DubaiTech #SmartCity`;
  return content;
}

// ════════════════════════════════════════════════════════════════════════════
//  APPROACH 1 — Graph API (most reliable, if token set)
// ════════════════════════════════════════════════════════════════════════════

const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v21.0';

function graphErrorMessage(err) {
  return err.response?.data?.error?.message || err.message;
}

async function postToFacebookGraph(article, articleIndex) {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  logger.info(`\n📘 Facebook (Graph API) → Article ${articleIndex + 1}: "${(article.title || '').substring(0, 50)}..."`);

  const message = buildPostContent(article);
  const base = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}`;

  try {
    const imageUrl = article.imageUrl && String(article.imageUrl).trim();
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
      try {
        const { data } = await axios.post(`${base}/photos`, null, {
          params: { url: imageUrl, caption: message, access_token: token, published: true },
          timeout: 60000
        });
        logger.info(`✅ Facebook photo post created id=${data.id}`);
        await markPosted(articleIndex, 'facebook', true);
        return true;
      } catch (photoErr) {
        logger.warn(`⚠️ FB Graph photo failed (${graphErrorMessage(photoErr)}), trying link post…`);
      }
    }
    const link = article.articleUrl || process.env.WEBSITE_URL || 'https://dubai5.space';
    const { data } = await axios.post(`${base}/feed`, null, {
      params: { message, link, access_token: token },
      timeout: 60000
    });
    logger.info(`✅ Facebook feed post created id=${data.id}`);
    await markPosted(articleIndex, 'facebook', true);
    return true;
  } catch (err) {
    const msg = graphErrorMessage(err);
    logger.error(`❌ Facebook Graph API failed: ${msg}`);
    await markPosted(articleIndex, 'facebook', false, msg);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  APPROACH 2 — www.facebook.com with saved cookies (like LinkedIn/Twitter)
//  Requires: `node setup.js` → manual login once → cookies saved → bot reuses
// ════════════════════════════════════════════════════════════════════════════

const FB_PAGE_ID = process.env.FACEBOOK_ASSET_ID || '970837422790775';

/**
 * Find a visible composer on www.facebook.com and insert text (no fragile waitForSelector).
 */
async function fillWwwPostComposer(page, text, maxWaitMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ok = await page.evaluate((t) => {
      const candidates = Array.from(
        document.querySelectorAll(
          '[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-testid], div[contenteditable="true"]'
        )
      );
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 20) continue;
        const lab = (el.getAttribute('aria-label') || '').toLowerCase();
        if (lab.includes('search')) continue;
        el.focus();
        try {
          el.click();
        } catch (e) { /* ignore */ }
        if (el.isContentEditable || el.getAttribute('role') === 'textbox') {
          document.execCommand('insertText', false, t);
          return true;
        }
      }
      return false;
    }, text);
    if (ok) return true;
    await delay(800, 1500);
  }
  return false;
}

/** www timeline URL for posting — NOT business.facebook.com (different product). */
function getWwwFacebookPageUrl() {
  const wwwExplicit = (process.env.FACEBOOK_WWW_PAGE_URL || '').trim();
  if (wwwExplicit && /^https?:\/\/(www\.|m\.)?facebook\.com/i.test(wwwExplicit)) {
    return wwwExplicit;
  }
  const pageUrl = (process.env.FACEBOOK_PAGE_URL || '').trim();
  if (pageUrl && !/business\.facebook\.com/i.test(pageUrl)) {
    if (/^https?:\/\/(www\.|m\.)?facebook\.com/i.test(pageUrl)) return pageUrl;
  }
  if (pageUrl && /business\.facebook\.com/i.test(pageUrl)) {
    logger.info('ℹ️ FACEBOOK_PAGE_URL is Business Suite — using www Page timeline instead.');
  }
  return `https://www.facebook.com/profile.php?id=${FB_PAGE_ID}`;
}

async function postViaWwwFacebook(article, articleIndex) {
  logger.info(`\n📘 Facebook (www + cookies) → Article ${articleIndex + 1}: "${(article.title || '').substring(0, 50)}..."`);

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser(true));
    await loadCookies(page, 'facebook');

    // ── Step 1: Go to Facebook and verify session ────────────────
    logger.info('🔗 Navigating to facebook.com…');
    await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000, 5000);

    const url = page.url();
    if (url.includes('/login') || url.includes('login.php')) {
      throw new Error(
        'Facebook session expired! Run `node setup.js` locally → login to Facebook → ' +
        'then copy sessions/facebook.json to server.'
      );
    }
    logger.info('✅ Facebook session valid (cookies working)');
    await screenshot(page, `${articleIndex}-1-logged-in`);

    // ── Step 2: Navigate to Facebook Page ────────────────────────
    const pageUrl = getWwwFacebookPageUrl();
    logger.info(`🔗 Opening Facebook Page (www): ${pageUrl.substring(0, 72)}…`);
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(4000, 6000);
    await screenshot(page, `${articleIndex}-2-page-loaded`);

    // ── Step 3: Switch to posting as Page (if needed) ────────────
    // Click the "Create post" / "What's on your mind" area on the Page
    logger.info('🖱️ Looking for "Create post" on Page…');

    const createPostClicked = await page.evaluate(() => {
      // On a FB Page, there's usually a "Create post" button or "What's on your mind" prompt
      const allEls = Array.from(document.querySelectorAll(
        '[role="button"], span, div[role="button"], button'
      ));
      const target = allEls.find(el => {
        const t = (el.textContent || '').trim().toLowerCase();
        return (
          t === 'create post' ||
          t.includes("what's on your mind") ||
          t.includes('write something') ||
          t === 'write post'
        );
      });
      if (target) { target.click(); return true; }
      return false;
    });

    if (createPostClicked) {
      logger.info('✅ Opened "Create post" dialog');
      await delay(3000, 5000);
    } else {
      logger.warn('⚠️ "Create post" button not found — trying direct composer click…');
      // Try clicking the placeholder text area (gray box at top of page timeline)
      const placeholderClicked = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('span'));
        const ph = spans.find(s => {
          const t = (s.textContent || '').toLowerCase();
          return t.includes("what's on your mind") || t.includes('write something');
        });
        if (ph) { ph.click(); return true; }
        return false;
      });
      if (placeholderClicked) {
        await delay(3000, 5000);
      }
    }
    await screenshot(page, `${articleIndex}-3-composer-open`);

    // ── Step 4: Type content (avoid long waitForSelector hangs on www) ──
    const content = buildPostContent(article);
    logger.info('⌨️ Filling post composer…');

    const filled = await fillWwwPostComposer(page, content, 45000);
    if (!filled) {
      await screenshot(page, `${articleIndex}-ERR-no-textbox`);
      throw new Error('Could not find Facebook post composer. Run `node setup.js` and re-login.');
    }
    logger.info(`✅ Entered ${content.length} chars`);
    await delay(2000, 3000);
    await screenshot(page, `${articleIndex}-4-content-ready`);

    // ── Step 5: Click Post/Publish ───────────────────────────────
    logger.info('🚀 Looking for Post button…');
    await delay(2000, 3000);

    const posted = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('[role="button"], button'));
      // Facebook www uses "Post" not "Publish"
      const postBtn = btns.find(b => {
        const t = (b.textContent || '').trim();
        if (b.getAttribute('aria-disabled') === 'true') return false;
        return /^Post$/i.test(t) || /^Publish$/i.test(t) || /^Share$/i.test(t);
      });
      if (postBtn) { postBtn.click(); return true; }
      return false;
    });

    if (!posted) {
      await screenshot(page, `${articleIndex}-ERR-no-post-btn`);
      throw new Error('Could not find Post button');
    }

    logger.info('✅ Clicked Post button');
    await delay(10000, 15000);
    await screenshot(page, `${articleIndex}-5-published`);

    await saveCookies(page, 'facebook');
    logger.info(`🎉 Facebook post published! Article ${articleIndex + 1}`);
    await markPosted(articleIndex, 'facebook', true);
    return true;

  } catch (err) {
    logger.error(`❌ Facebook posting failed (article ${articleIndex}): ${err.message}`);
    if (page) await screenshot(page, `${articleIndex}-FATAL-ERROR`);
    await markPosted(articleIndex, 'facebook', false, err.message);
    return false;
  } finally {
    if (browser) await browser.close();
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Main entry
// ════════════════════════════════════════════════════════════════════════════

async function postToFacebook(article, articleIndex) {
  if (process.env.FACEBOOK_PAGE_ACCESS_TOKEN && process.env.FACEBOOK_PAGE_ID) {
    return postToFacebookGraph(article, articleIndex);
  }
  return postViaWwwFacebook(article, articleIndex);
}

if (require.main === module) {
  const { getArticleByIndex } = require('../queue');
  const idx = parseInt((process.argv.find(a => a.startsWith('--index=')) || '--index=0').split('=')[1]);

  getArticleByIndex(idx).then(async article => {
    if (!article) {
      article = {
        index: idx,
        title: 'Dubai Smart City Initiative Sets Global Benchmark',
        description: 'Revolutionary initiative transforming urban infrastructure.',
        imageUrl: null, localImagePath: null,
        articleUrl: 'https://dubai5.space'
      };
    }
    const ok = await postToFacebook(article, idx);
    process.exit(ok ? 0 : 1);
  }).catch(err => { logger.error(err); process.exit(1); });
}

module.exports = { postToFacebook };
