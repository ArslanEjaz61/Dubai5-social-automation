require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const logger = require('../logger');
const { launchBrowser } = require('../browser');
const { loadCookies, saveCookies } = require('../setup');
const { markPosted } = require('../queue');

const FB_PAGE_URL = process.env.FACEBOOK_PAGE_URL || '';

/** Meta Business Suite “Create post” URL — set in .env to match your Page composer. */
function getComposerUrl() {
  const fromEnv =
    process.env.FACEBOOK_COMPOSER_URL ||
    process.env.FACEBOOK_SUITE_URL ||
    (FB_PAGE_URL.includes('business.facebook.com') ? FB_PAGE_URL : '');
  if (fromEnv && /^https?:\/\//i.test(fromEnv.trim())) return fromEnv.trim();
  const assetId = process.env.FACEBOOK_ASSET_ID || '970837422790775';
  return `https://business.facebook.com/latest/composer/?asset_id=${assetId}&nav_ref=internal_nav&ref=biz_web_home_create_post&context_ref=HOME`;
}

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

/** Check if logged in to Facebook */
async function isLoggedIn(page) {
  const url = page.url();
  return !url.includes('/login') && !url.includes('login.php') && !url.includes('/checkpoint');
}

/** Login to Facebook with credentials */
async function loginToFacebook(page) {
  const email = process.env.FACEBOOK_EMAIL;
  const password = process.env.FACEBOOK_PASSWORD;
  if (!email || !password) throw new Error('FACEBOOK_EMAIL/PASSWORD not set in .env');

  logger.info('🔐 Logging in to Facebook...');
  await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
  await delay(2000, 3000);

  // Accept cookies if dialog appears
  try {
    const acceptBtn = await page.$('[data-testid="cookie-policy-manage-dialog-accept-button"]')
      || await page.$('[aria-label*="Accept" i][role="button"]');
    if (acceptBtn) { await acceptBtn.click(); await delay(1000, 1500); }
  } catch (e) {}

  const emailInput = await waitForSafe(page, '#email', 10000);
  
  if (!emailInput) {
    // Check for "Profile Wall" during login (fb-login-fail.png)
    const profileWallClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
      const continueBtn = btns.find(b => {
        const t = b.textContent.trim().toLowerCase();
        return t === 'continue' || t.includes('continue as');
      });
      if (continueBtn) {
        continueBtn.click();
        return true;
      }
      return false;
    });

    if (profileWallClicked) {
      logger.info('🖱️ Handled Profile selection wall during login flow');
      await delay(3000, 5000);
      // After clicking continue, it might load the password field or the home page
      if (await isLoggedIn(page)) return;
      return loginToFacebook(page); // Recursive retry once profile is selected
    }
    
    throw new Error('Facebook login page did not load');
  }

  await emailInput.click();
  await page.keyboard.type(email, { delay: 40 });
  await delay(400, 700);

  const passInput = await waitForSafe(page, '#pass', 5000);
  if (!passInput) throw new Error('Facebook password field (#pass) not found');
  await passInput.click();
  await page.keyboard.type(password, { delay: 40 });
  await delay(400, 700);

  await page.click('[name="login"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

  const url = page.url();
  if (url.includes('/login') || url.includes('login.php')) {
    await screenshot(page, 'login-failed');
    throw new Error('Facebook login failed — check credentials');
  }

  await saveCookies(page, 'facebook');
  logger.info('✅ Facebook login successful!');
}

/**
 * Meta Suite composer often lives in an iframe; the first [role=textbox] on the page can be search.
 * Prefer a large, visible contenteditable / textbox in composer (e.g. “Text” field).
 */
async function findComposerTextBox(page) {
  const scoreNode = async (frame, el) => {
    try {
      const vis = await el.isVisible().catch(() => false);
      if (!vis) return -1;
      const box = await el.boundingBox();
      if (!box || box.width < 100 || box.height < 36) return -1;
      const meta = await frame.evaluate(
        (node) => {
          const lab = (node.getAttribute('aria-label') || '').toLowerCase();
          const ph = (node.getAttribute('placeholder') || '').toLowerCase();
          const role = node.getAttribute('role') || '';
          let score = 0;
          if (lab.includes('text') && !lab.includes('search')) score += 40;
          if (lab.includes('post') || lab.includes('write')) score += 25;
          if (ph.includes('write') || ph.includes('text')) score += 20;
          if (role === 'textbox') score += 15;
          if (node.isContentEditable) score += 10;
          if (node.tagName === 'TEXTAREA') score += 8;
          if (lab.includes('search')) score -= 100;
          const r = node.getBoundingClientRect();
          score += Math.min((r.width * r.height) / 8000, 25);
          return score;
        },
        el
      ).catch(() => -1);
      return meta;
    } catch (e) {
      return -1;
    }
  };

  const tryFrame = async (frame) => {
    const sels = [
      'div[role="textbox"][contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"][spellcheck="true"]',
      'div[data-lexical-editor="true"]',
      'textarea:not([readonly]):not([disabled])',
      '[role="textbox"]',
      'div[contenteditable="true"]',
    ];
    let best = null;
    let bestScore = -Infinity;
    for (const sel of sels) {
      const nodes = await frame.$$(sel).catch(() => []);
      for (const node of nodes) {
        const s = await scoreNode(frame, node);
        if (s > bestScore) {
          bestScore = s;
          best = node;
        }
      }
    }
    return best != null && bestScore >= 5 ? best : null;
  };

  let el = await tryFrame(page.mainFrame());
  if (el) return el;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if (frame.url() === 'about:blank') continue;
    el = await tryFrame(frame);
    if (el) return el;
  }
  return null;
}

async function waitForComposerTextBox(page, maxWaitMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const el = await findComposerTextBox(page);
    if (el) return el;
    await delay(1500, 2500);
  }
  return null;
}

/** Paste long text on the given editor node (works when editor is inside an iframe). */
async function typeIntoFacebookEditor(editorHandle, text) {
  if (text.length > 80) {
    await editorHandle.evaluate((node, t) => {
      node.focus();
      if (node.isContentEditable || node.getAttribute('role') === 'textbox') {
        document.execCommand('insertText', false, t);
      }
    }, text);
  } else {
    await editorHandle.type(text, { delay: 18 });
  }
}

async function clickPublishWhenReady(page, maxWaitMs = 90000) {
  const tryClick = async (frame) => {
    return frame.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
      const pub = btns.find((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        if (t !== 'publish') return false;
        if (b.getAttribute('aria-disabled') === 'true') return false;
        if (b.disabled) return false;
        return true;
      });
      if (pub) {
        pub.click();
        return true;
      }
      return false;
    }).catch(() => false);
  };

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await tryClick(page.mainFrame())) return true;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (await tryClick(frame)) return true;
    }
    await delay(600, 1000);
  }
  return false;
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

const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v21.0';

function graphErrorMessage(err) {
  return err.response?.data?.error?.message || err.message;
}

/**
 * Post to Facebook Page via Graph API (server-safe: no Business Suite / headless).
 * Requires FACEBOOK_PAGE_ID + FACEBOOK_PAGE_ACCESS_TOKEN (Page token with pages_manage_posts).
 */
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
          params: {
            url: imageUrl,
            caption: message,
            access_token: token,
            published: true
          },
          timeout: 60000
        });
        logger.info(`✅ Facebook photo post created id=${data.id}`);
        await markPosted(articleIndex, 'facebook', true);
        return true;
      } catch (photoErr) {
        logger.warn(`⚠️ FB Graph photo failed (${graphErrorMessage(photoErr)}), trying link post…`);
      }
    }

    const link =
      article.articleUrl ||
      process.env.WEBSITE_URL ||
      'https://dubai5.space';
    const { data } = await axios.post(`${base}/feed`, null, {
      params: {
        message,
        link,
        access_token: token
      },
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

/**
 * Post article to Facebook Page via Meta Business Suite (browser) unless Graph API env is set.
 */
async function postToFacebook(article, articleIndex) {
  if (process.env.FACEBOOK_PAGE_ACCESS_TOKEN && process.env.FACEBOOK_PAGE_ID) {
    return postToFacebookGraph(article, articleIndex);
  }

  logger.info(`\n📘 Facebook (Meta Suite) → Article ${articleIndex + 1}: "${article.title.substring(0, 50)}..."`);

  const FB_SUITE_URL = getComposerUrl();
  logger.info(`🔗 Composer URL: ${FB_SUITE_URL.substring(0, 80)}…`);

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser(true));

    // Load session
    await loadCookies(page, 'facebook');
    
    logger.info('🔗 Navigating to Meta Business Suite Composer...');
    await page.goto(FB_SUITE_URL, { waitUntil: 'networkidle2', timeout: 90000 });
    await delay(6000, 10000); // Suite is heavy, wait for it to settle

    if (!await isLoggedIn(page)) {
      logger.warn('⚠️ Facebook session expired — logging in...');
      await loginToFacebook(page);
      await page.goto(FB_SUITE_URL, { waitUntil: 'networkidle2', timeout: 90000 });
      await delay(6000, 10000);
    }
    
    logger.info('✅ Logged in to Meta Business Suite');
    await screenshot(page, `${articleIndex}-1-suite-loaded`);
 
    // ── Meta Suite can show overlays, Profile Selection, or Get Started walls ──
    try {
      // 1. Check for Meta Business Tools "Log in with Facebook" wall (fb-composer-fail.png)
      const loginWallInfo = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const btn = btns.find(b => b.textContent.trim().toLowerCase() === 'log in with facebook');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });

      if (loginWallInfo) {
        logger.info(`🖱️ Handled Meta "Log in with Facebook" wall (Force Click + Asset Nav)`);
        await page.mouse.click(loginWallInfo.x, loginWallInfo.y);
        await delay(3000, 5000);
        // Force navigate to SPECIFIC composer as ultimate fallback
        await page.goto(getComposerUrl(), { waitUntil: 'networkidle2', timeout: 90000 });
        await delay(10000, 15000); // Suite login is slow
        await screenshot(page, `${articleIndex}-1b-after-suite-login`);
      }

      // 2. Check for the "Continue" profile wall (as seen in fb-login-fail.png)
      const profileWallInfo = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('div[role="button"], button, a'));
        const btn = btns.find(b => {
          const t = b.textContent.trim().toLowerCase();
          return t === 'continue' || t.includes('continue as');
        });
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      
      if (profileWallInfo) {
        logger.info(`🖱️ Handled Facebook Profile Selection Wall (Force Click at ${Math.round(profileWallInfo.x)},${Math.round(profileWallInfo.y)})`);
        await page.mouse.click(profileWallInfo.x, profileWallInfo.y);
        await delay(6000, 10000);
      }

      const closePopup = await page.$('[aria-label="Close"]');
      if (closePopup) { await closePopup.click(); await delay(1000, 1500); }
    } catch (e) {}

    // ── Step 1: Upload image ────────────────────────────────────
    if (article.localImagePath && await fs.pathExists(article.localImagePath)) {
      logger.info(`🖼️ Uploading image (${article.localImagePath})...`);
      try {
        // Find "Add photo/video" button
        const addBtnHandle = await page.evaluateHandle(() => {
          return Array.from(document.querySelectorAll('div[role="button"], button')).find(el => {
            const t = (el.textContent || '').toLowerCase();
            return t.includes('add photo') || t.includes('add photo/video');
          });
        });

        const addBtn = await addBtnHandle.asElement();
        if (addBtn) {
          const [fileChooser] = await Promise.all([
            page.waitForFileChooser({ timeout: 15000 }),
            addBtn.click(),
          ]);
          await fileChooser.accept([article.localImagePath]);
          logger.info('✅ Image selected via file chooser');
          await delay(8000, 12000); // Business Suite needs time to process media
          await screenshot(page, `${articleIndex}-2-image-attached`);
        } else {
          logger.warn('⚠️ Could not find "Add photo" button in Business Suite');
        }
      } catch (imgErr) {
        logger.warn(`⚠️ FB media upload error: ${imgErr.message}`);
      }
    }

    // ── Step 2: Type content ────────────────────────────────────
    logger.info('⌨️ Finding Meta Suite text editor (may be inside iframe)…');
    const content = buildPostContent(article);

    const textArea = await waitForComposerTextBox(page, 90000);
    if (!textArea) throw new Error('Could not find Facebook Suite text editor');

    await textArea.evaluate((n) => n.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await textArea.click({ delay: 50 });
    await delay(400, 800);
    await typeIntoFacebookEditor(textArea, content);
    logger.info(`✅ Entered ${content.length} chars in composer`);
    await delay(2500, 4000);
    await screenshot(page, `${articleIndex}-3-content-ready`);

    // ── Step 3: Publish (enabled after text; scan main + iframes) ─
    logger.info('🚀 Waiting for Publish to become enabled…');
    const published = await clickPublishWhenReady(page, 90000);
    if (!published) {
      await screenshot(page, `${articleIndex}-ERR-no-publish-btn`);
      throw new Error('Could not find enabled Facebook Publish button');
    }
    logger.info('✅ Clicked Publish');
    await delay(10000, 15000);
    await screenshot(page, `${articleIndex}-4-published`);
    logger.info(`🎉 Facebook (Meta Suite) post published! Article ${articleIndex + 1}`);
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
