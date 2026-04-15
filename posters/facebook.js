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

/** True if any frame has a usable composer field (often inside an iframe). */
async function hasWwwComposerTextbox(page) {
  for (const frame of page.frames()) {
    try {
      const ok = await frame.evaluate(() => {
        const bad = (el) => {
          const lab = (el.getAttribute('aria-label') || '').toLowerCase();
          if (lab.includes('search')) return true;
          return false;
        };
        const list = Array.from(
          document.querySelectorAll(
            '[role="textbox"][contenteditable="true"],' +
              'div[contenteditable="true"][data-testid],' +
              'div[contenteditable="true"][data-lexical-editor="true"],' +
              'div[contenteditable="true"]'
          )
        );
        for (const el of list) {
          if (bad(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width >= 60 && r.height >= 16 && r.bottom > 0 && r.right > 0) return true;
        }
        return false;
      });
      if (ok) return true;
    } catch (e) { /* cross-origin iframe */ }
  }
  return false;
}

/** Open Page composer — FB UI varies (aria-labels, composer links, plain text). */
async function openWwwPageComposer(page) {
  const tryOnce = () =>
    page.evaluate(() => {
      const h = (s) => (s || '').toLowerCase();

      const link = document.querySelector(
        'a[href*="composer"], a[href*="intent/post"], a[href*="/stories/composer"]'
      );
      if (link) {
        link.click();
        return 'composer-link';
      }

      for (const el of document.querySelectorAll('[aria-label]')) {
        const al = h(el.getAttribute('aria-label'));
        if (al.includes('what') && al.includes('mind')) {
          el.click();
          return 'aria-whats-on-mind';
        }
        if (al.includes('write something') || al.includes('write a post')) {
          el.click();
          return 'aria-write';
        }
      }

      const candidates = document.querySelectorAll(
        '[role="button"], [role="link"], span, div[role="button"], button'
      );
      for (const el of candidates) {
        const t = h((el.textContent || '').replace(/\s+/g, ' ').trim());
        if (t.includes('what') && t.includes('mind')) {
          el.click();
          return 'text-whats-on-mind';
        }
        if (t === 'create post' || t.startsWith('create post')) {
          el.click();
          return 'create-post';
        }
        if (t.includes('write something') || t.includes('write post')) {
          el.click();
          return 'write-something';
        }
      }
      return '';
    });

  for (let round = 1; round <= 4; round++) {
    const r = await tryOnce();
    if (r) {
      logger.info(`🖱️ Composer opened (${r})`);
      return true;
    }
    await delay(1200, 2000);
  }
  return false;
}

/** Some sessions only expose the composer after sk=create (or equivalent). */
async function openWwwPageComposerViaSkCreate(page, pageId) {
  const u = `https://www.facebook.com/profile.php?id=${encodeURIComponent(pageId)}&sk=create`;
  try {
    await page.goto(u, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(4000, 6000);
    if (await hasWwwComposerTextbox(page)) {
      logger.info('🖱️ Composer visible after sk=create URL');
      return true;
    }
    await openWwwPageComposer(page);
    return hasWwwComposerTextbox(page);
  } catch (e) {
    return false;
  }
}

/** Help debug wrong-profile posts (personal vs Page). */
async function logPostingIdentity(page) {
  const info = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    const m =
      body.match(/Posting as[^\n\r]{1,120}/i) ||
      body.match(/Post as[^\n\r]{1,120}/i);
    return m ? m[0].trim() : '';
  });
  if (info) logger.info(`ℹ️ ${info}`);
  else logger.info('ℹ️ Could not read “Posting as …” from composer (check screenshots).');
}

/**
 * After clicking Post, confirm the article title appears on the Page timeline.
 * Without this, logs can say “success” even if Meta rejected or posted elsewhere.
 */
async function verifyArticleOnPageTimeline(page, pageUrl, article) {
  const raw = (article.title || '').trim();
  if (raw.length < 10) return true;
  const snippet = raw.substring(0, Math.min(40, raw.length)).toLowerCase();

  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await delay(4000, 6000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(800, 1500);

    const found = await page.evaluate((snip) => {
      return (document.body?.innerText || '').toLowerCase().includes(snip);
    }, snippet);

    if (found) {
      logger.info(`✅ Verified article title on Page timeline (attempt ${attempt})`);
      return true;
    }

    const errHint = await page.evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase();
      if (t.includes("couldn't post") || t.includes("could not post")) return 'Meta error toast';
      if (t.includes('try again')) return 'Try again';
      return '';
    });
    if (errHint) logger.warn(`⚠️ Possible publish error on page: ${errHint}`);

    logger.warn(`⚠️ Title not visible on Page yet (attempt ${attempt}/5)…`);
    await delay(5000, 7000);
  }
  return false;
}

function evaluateClickComposerSubmit() {
  const tryClick = (el) => {
    if (!el || el.getAttribute?.('aria-disabled') === 'true' || el.disabled) return false;
    el.click();
    return true;
  };
  const byTest = document.querySelector(
    '[data-testid="composer-post-button"],' +
      '[data-testid="post-creation-submit-button"],' +
      '[data-testid="composer-submit-button"],' +
      '[aria-label="Post"][role="button"],' +
      '[aria-label="Share to News Feed"][role="button"],' +
      '[aria-label="Share"][role="button"]'
  );
  if (byTest && tryClick(byTest)) return 'testid';

  for (const b of document.querySelectorAll('[role="button"][aria-label]')) {
    const lab = (b.getAttribute('aria-label') || '').toLowerCase();
    if (
      (lab.includes('post') || lab.includes('share')) &&
      !lab.includes('photo') &&
      !lab.includes('comment')
    ) {
      if (tryClick(b)) return 'aria-label';
    }
  }

  const spans = Array.from(document.querySelectorAll('span'));
  for (const s of spans) {
    const t = (s.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/^(Post|Share|Publish)$/i.test(t)) continue;
    let p = s;
    for (let i = 0; i < 8 && p; i++) {
      if (p.getAttribute?.('role') === 'button') {
        if (p.getAttribute('aria-disabled') !== 'true' && p.offsetParent !== null) {
          p.click();
          return 'span-parent';
        }
        break;
      }
      p = p.parentElement;
    }
  }

  const btns = Array.from(document.querySelectorAll('[role="button"], button'));
  for (const b of btns) {
    const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/^(Post|Share|Publish)$/i.test(t)) continue;
    if (b.getAttribute('aria-disabled') === 'true') continue;
    if (b.offsetParent === null) continue;
    b.click();
    return 'text';
  }
  return '';
}

/** Click Post / Share / composer submit (waits until enabled). Checks all frames (composer often in iframe). */
async function clickWwwPostSubmit(page, maxWaitMs) {
  const start = Date.now();
  let nextClicked = false;
  while (Date.now() - start < maxWaitMs) {
    let clicked = '';
    for (const frame of page.frames()) {
      try {
        clicked = await frame.evaluate(evaluateClickComposerSubmit);
        if (clicked) break;
      } catch (e) { /* cross-origin */ }
    }
    if (clicked) return true;

    // Some flows show "Next" before the final Post
    if (!nextClicked && Date.now() - start > 12000) {
      let nextOk = false;
      for (const frame of page.frames()) {
        try {
          nextOk = await frame.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('[role="button"], button'));
            const n = btns.find(b => /^Next$/i.test((b.textContent || '').trim()));
            if (n && n.getAttribute('aria-disabled') !== 'true') {
              n.click();
              return true;
            }
            return false;
          });
          if (nextOk) break;
        } catch (e) { /* cross-origin */ }
      }
      if (nextOk) {
        nextClicked = true;
        await delay(2000, 3500);
      }
    }

    await delay(500, 900);
  }
  return false;
}

/**
 * Find a visible composer on www.facebook.com and insert text (composer is often in an iframe).
 */
async function fillWwwPostComposer(page, text, maxWaitMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    for (const frame of page.frames()) {
      try {
        const ok = await frame.evaluate((t) => {
          const bad = (el) => {
            const lab = (el.getAttribute('aria-label') || '').toLowerCase();
            if (lab.includes('search')) return true;
            const ph = (el.getAttribute('placeholder') || '').toLowerCase();
            if (ph.includes('search')) return true;
            return false;
          };
          const candidates = Array.from(
            document.querySelectorAll(
              '[role="textbox"][contenteditable="true"],' +
                'div[contenteditable="true"][data-testid],' +
                'div[contenteditable="true"][data-lexical-editor="true"],' +
                'div[contenteditable="true"][spellcheck="true"],' +
                'div[contenteditable="true"]'
            )
          );
          for (const el of candidates) {
            if (bad(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 60 || r.height < 14) continue;
            if (r.bottom <= 0 || r.right <= 0) continue;
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
      } catch (e) { /* cross-origin */ }
    }
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
    await delay(5000, 8000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(800, 1200);
    await screenshot(page, `${articleIndex}-2-page-loaded`);

    // ── Step 3: Open Page composer (many FB UI variants) ─────────
    logger.info('🖱️ Opening Page composer…');
    const opened = await openWwwPageComposer(page);
    if (!opened) {
      logger.warn('⚠️ Standard composer openers missed — trying numeric Page URL…');
      const alt = `https://www.facebook.com/${FB_PAGE_ID}`;
      if (pageUrl !== alt) {
        await page.goto(alt, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000, 7000);
        await openWwwPageComposer(page);
      }
    }
    await delay(3000, 5000);

    if (!(await hasWwwComposerTextbox(page))) {
      logger.warn('⚠️ No composer field yet — trying profile.php?…&sk=create…');
      await openWwwPageComposerViaSkCreate(page, FB_PAGE_ID);
      await delay(2000, 4000);
    }
    if (!(await hasWwwComposerTextbox(page))) {
      await openWwwPageComposer(page);
      await delay(3000, 5000);
    }

    await screenshot(page, `${articleIndex}-3-composer-open`);
    await logPostingIdentity(page);

    // ── Step 4: Type content (avoid long waitForSelector hangs on www) ──
    const content = buildPostContent(article);
    logger.info('⌨️ Filling post composer…');

    const filled = await fillWwwPostComposer(page, content, 70000);
    if (!filled) {
      await screenshot(page, `${articleIndex}-ERR-no-textbox`);
      throw new Error('Could not find Facebook post composer. Run `node setup.js` and re-login.');
    }
    logger.info(`✅ Entered ${content.length} chars`);
    await delay(2000, 3000);
    await screenshot(page, `${articleIndex}-4-content-ready`);

    // ── Step 5: Click Post / Share (composer enables button after text) ──
    logger.info('🚀 Looking for Post / Share button…');
    await delay(3000, 5000);

    const posted = await clickWwwPostSubmit(page, 120000);
    if (!posted) {
      await screenshot(page, `${articleIndex}-ERR-no-post-btn`);
      throw new Error('Could not find Post/Share button');
    }

    logger.info('✅ Clicked Post button');
    await delay(8000, 12000);
    await screenshot(page, `${articleIndex}-5-after-post-click`);

    const verified = await verifyArticleOnPageTimeline(page, pageUrl, article);
    if (!verified) {
      await screenshot(page, `${articleIndex}-ERR-not-on-timeline`);
      throw new Error(
        'Post was clicked but the article did not appear on the Page timeline. ' +
        'Common causes: posting as personal profile (see “Posting as …” in composer), Meta blocked silently, ' +
        'or wrong Page URL. Re-run setup.js while ensuring you open Dubai5 Page and “Post as Page”.'
      );
    }

    await screenshot(page, `${articleIndex}-6-published-verified`);
    await saveCookies(page, 'facebook');
    logger.info(`🎉 Facebook post published and verified on Page! Article ${articleIndex + 1}`);
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
