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

/** Build Facebook post content */
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
//  APPROACH 1 — Graph API (most reliable on any server)
// ════════════════════════════════════════════════════════════════════════════

const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v21.0';

function graphErrorMessage(err) {
  return err.response?.data?.error?.message || err.message;
}

async function postToFacebookGraph(article, articleIndex) {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const titlePreview = (article.title || '').substring(0, 50);
  logger.info(`\n📘 Facebook (Graph API) → Article ${articleIndex + 1}: "${titlePreview}..."`);

  const message = buildPostContent(article);
  const base = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}`;

  try {
    const imageUrl = article.imageUrl && String(article.imageUrl).trim();
    const canPhoto = imageUrl && /^https?:\/\//i.test(imageUrl);

    if (canPhoto) {
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
//  APPROACH 2 — mbasic.facebook.com (plain HTML, no React / Business Suite)
//  Works on AWS / datacenter IPs where business.facebook.com blocks the UI.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Login via mbasic, then immediately navigate to the Page in the same session.
 * Returns true if we land on the Page with a working session.
 */
async function loginAndGoToPage(page, pageId) {
  const email = process.env.FACEBOOK_EMAIL;
  const password = process.env.FACEBOOK_PASSWORD;
  if (!email || !password) throw new Error('FACEBOOK_EMAIL/PASSWORD not set in .env');

  const pageUrl = `https://mbasic.facebook.com/${pageId}`;

  // Go to the page URL directly — if not logged in, mbasic redirects to login with next=pageUrl
  logger.info('🔐 Opening mbasic page (will login if needed)…');
  await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(1500, 2500);

  // Check if we need to login
  const needsLogin = page.url().includes('login') || !!(await page.$('#m_login_email'))
    || !!(await page.$('input[name="email"]'));

  if (!needsLogin) {
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').substring(0, 500));
    if (!bodyText.includes('Log in to Facebook') && !bodyText.includes('Log In')) {
      logger.info('✅ Already logged in — on Page');
      await saveCookies(page, 'facebook');
      return true;
    }
  }

  logger.info('🔐 Filling login form on mbasic…');
  await page.evaluate(() => {
    const el = document.querySelector('#m_login_email') || document.querySelector('input[name="email"]');
    if (el) { el.value = ''; el.focus(); }
  });
  await page.keyboard.type(email, { delay: 25 });
  await delay(300, 600);

  await page.evaluate(() => {
    const el = document.querySelector('input[name="pass"]');
    if (el) { el.value = ''; el.focus(); }
  });
  await page.keyboard.type(password, { delay: 25 });
  await delay(300, 600);

  await page.evaluate(() => {
    const btn = document.querySelector('input[name="login"]')
      || document.querySelector('button[name="login"]')
      || document.querySelector('input[type="submit"]');
    if (btn) btn.click();
  });
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000, 3000);

  const afterUrl = page.url();

  if (afterUrl.includes('checkpoint')) {
    await screenshot(page, 'mbasic-checkpoint');
    throw new Error('Facebook checkpoint — verify identity at facebook.com first');
  }

  // "Save device" prompt
  if (afterUrl.includes('save-device') || afterUrl.includes('login_save')) {
    logger.info('📱 "Save device" prompt — skipping…');
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const skip = links.find(a => /not now|skip|ok/i.test(a.textContent));
      if (skip) skip.click();
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await delay(1500, 2500);
  }

  await saveCookies(page, 'facebook');
  logger.info('✅ mbasic login successful!');

  // After login, mbasic should redirect to next=pageUrl; if not, navigate explicitly
  const currentUrl = page.url();
  if (!currentUrl.includes(pageId)) {
    logger.info('🔗 Navigating to Page after login…');
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000, 3000);
  }

  const bodyText = await page.evaluate(() => (document.body?.innerText || '').substring(0, 500));
  if (bodyText.includes('Log in to Facebook') || bodyText.includes('Log In')) {
    throw new Error('mbasic: still on login page after successful login');
  }

  return true;
}

async function postViaMbasic(article, articleIndex) {
  const pageId = process.env.FACEBOOK_ASSET_ID || '970837422790775';
  const titlePreview = (article.title || '').substring(0, 50);
  logger.info(`\n📘 Facebook (mbasic) → Article ${articleIndex + 1}: "${titlePreview}..."`);

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser(true));
    // ── Step 1+2: Login directly on the Page URL (same session, no redirect loss) ──
    await loginAndGoToPage(page, pageId);
    await screenshot(page, `${articleIndex}-1-mbasic-loggedin`);
    await screenshot(page, `${articleIndex}-2-mbasic-page`);

    // mbasic page may show "Write Post" link or have a composer form
    const writePostLink = await page.evaluateHandle(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.find(a => /write post|create post|write something/i.test(a.textContent || ''));
    });
    if (writePostLink && await writePostLink.asElement()) {
      logger.info('🖱️ Clicking "Write Post"…');
      await writePostLink.asElement().click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await delay(2000, 3000);
    }

    // ── Step 3: Fill post content ────────────────────────────────
    const content = buildPostContent(article);
    logger.info('⌨️ Looking for post textarea…');

    const textarea = await waitForSafe(page, 'textarea[name="xc_message"]', 10000)
      || await waitForSafe(page, 'textarea', 5000);

    if (!textarea) {
      await screenshot(page, `${articleIndex}-ERR-no-textarea`);

      const bodyText = await page.evaluate(() => (document.body?.innerText || '').substring(0, 2000));
      logger.error(`❌ No textarea found on mbasic page. Body preview: ${bodyText.substring(0, 300)}`);
      throw new Error('Could not find mbasic post textarea');
    }

    await textarea.click();
    await delay(300, 500);
    await textarea.type(content, { delay: 12 });
    logger.info(`✅ Typed ${content.length} chars`);
    await delay(1000, 2000);
    await screenshot(page, `${articleIndex}-3-mbasic-content`);

    // ── Step 4: Image upload (if available) ──────────────────────
    if (article.localImagePath && await fs.pathExists(article.localImagePath)) {
      try {
        const fileInput = await page.$('input[type="file"][name="file1"]')
          || await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.uploadFile(article.localImagePath);
          logger.info('🖼️ Image attached via mbasic file input');
          await delay(2000, 4000);
        }
      } catch (imgErr) {
        logger.warn(`⚠️ mbasic image upload skipped: ${imgErr.message}`);
      }
    }

    // ── Step 5: Submit the post ──────────────────────────────────
    logger.info('🚀 Submitting post…');
    const postBtn = await page.$('input[name="view_post"]')
      || await page.$('input[type="submit"][value*="Post"]')
      || await page.$('button[type="submit"]');

    if (!postBtn) {
      const submitFallback = await page.evaluateHandle(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="submit"]'));
        return inputs.find(i => /post/i.test(i.value || ''));
      });
      if (submitFallback && await submitFallback.asElement()) {
        await submitFallback.asElement().click();
      } else {
        await screenshot(page, `${articleIndex}-ERR-no-submit`);
        throw new Error('Could not find mbasic submit/post button');
      }
    } else {
      await postBtn.click();
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await delay(3000, 5000);
    await screenshot(page, `${articleIndex}-4-mbasic-posted`);

    const afterUrl = page.url();
    const afterBody = await page.evaluate(() => (document.body?.innerText || '').substring(0, 500));
    if (afterUrl.includes('/composer') || afterBody.includes('error') || afterBody.includes('try again')) {
      logger.warn(`⚠️ Post may have failed — URL: ${afterUrl}`);
      throw new Error('mbasic post submission may have failed');
    }

    logger.info(`🎉 Facebook post published via mbasic! Article ${articleIndex + 1}`);
    await saveCookies(page, 'facebook');
    await markPosted(articleIndex, 'facebook', true);
    return true;

  } catch (err) {
    logger.error(`❌ Facebook (mbasic) posting failed (article ${articleIndex}): ${err.message}`);
    if (page) await screenshot(page, `${articleIndex}-FATAL-ERROR`);
    await markPosted(articleIndex, 'facebook', false, err.message);
    return false;
  } finally {
    if (browser) await browser.close();
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Main entry: Graph API → mbasic browser
// ════════════════════════════════════════════════════════════════════════════

async function postToFacebook(article, articleIndex) {
  if (process.env.FACEBOOK_PAGE_ACCESS_TOKEN && process.env.FACEBOOK_PAGE_ID) {
    return postToFacebookGraph(article, articleIndex);
  }
  return postViaMbasic(article, articleIndex);
}

// ── Direct test ──────────────────────────────────────────────
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
