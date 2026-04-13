require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const logger = require('../logger');
const { launchBrowser } = require('../browser');
const { loadCookies, saveCookies } = require('../setup');
const { markPosted } = require('../queue');

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'logs', 'screenshots', 'instagram');
fs.ensureDirSync(SCREENSHOTS_DIR);

function delay(min = 1000, max = 3000) {
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

async function waitForSafe(page, selector, timeout = 10000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return await page.$(selector);
  } catch (e) { return null; }
}

/** Check if logged in to Instagram */
async function isLoggedIn(page) {
  const url = page.url();
  return !url.includes('/accounts/login') && !url.includes('/accounts/emailsignup');
}

/** Login to Instagram with credentials */
async function loginToInstagram(page) {
  const username = process.env.INSTAGRAM_USERNAME;
  const password = process.env.INSTAGRAM_PASSWORD;
  if (!username || !password) throw new Error('INSTAGRAM_USERNAME/PASSWORD not set in .env');

  logger.info('🔐 Logging in to Instagram...');
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2' });
  await delay(2000, 3000);

  // Dismiss cookie popups
  try {
    const allowBtn = await page.$('[role="dialog"] button:first-of-type');
    if (allowBtn) { await allowBtn.click(); await delay(800, 1200); }
  } catch (e) {}

  const usernameInput = await waitForSafe(page, 'input[name="username"]', 10000);
  if (!usernameInput) throw new Error('Instagram login page did not load');

  await usernameInput.click();
  await page.keyboard.type(username, { delay: 45 });
  await delay(400, 700);

  const passInput = await waitForSafe(page, 'input[name="password"]', 5000);
  await passInput.click();
  await page.keyboard.type(password, { delay: 45 });
  await delay(400, 700);

  // Click Log in
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (btn) btn.click();
  });

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await delay(2000, 3000);

  const url = page.url();
  if (url.includes('/accounts/login')) {
    await screenshot(page, 'login-failed');
    throw new Error('Instagram login failed — check credentials');
  }

  // Dismiss "Save login info?" dialog
  try {
    const notNowBtn = await waitForSafe(page, 'button._acan._acap._acas', 3000)
      || await waitForSafe(page, '[role="dialog"] button', 3000);
    if (notNowBtn) {
      const txt = await notNowBtn.evaluate(el => el.textContent.trim());
      if (txt === 'Not Now' || txt === 'Not now') await notNowBtn.click();
    }
  } catch (e) {}

  // Dismiss notification dialog
  try {
    await delay(1500, 2500);
    const notNow2 = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent.trim() === 'Not Now');
      if (btn) { btn.click(); return true; }
      return false;
    });
  } catch (e) {}

  await saveCookies(page, 'instagram');
  logger.info('✅ Instagram login successful!');
}

/** Build Instagram caption */
function buildCaption(article) {
  if (article.socialCaption && article.socialCaption.trim().length > 30) {
    let c = article.socialCaption.trim();
    if (c.length > 2100) c = `${c.slice(0, 2097)}…`;
    return c;
  }
  const { title, description, articleUrl } = article;
  let caption = `🔮 ${title}\n\n`;
  if (description && description.length > 20) {
    caption += `${description.substring(0, 400)}\n\n`;
  }
  caption += `🌆 Dubai's Future, Decoded Daily.\n`;
  caption += `🔗 Link in bio → dubai5.space\n\n`;
  caption += `#Dubai #DubaiFuture #UAE #Innovation #DubaiTech #FutureDubai #Dubai5 `;
  caption += `#SmartCity #DubaiBusiness #UAEInnovation #DubaiLife #FutureOfDubai`;
  return caption;
}

/**
 * Post article to Instagram
 * Note: Instagram requires an image — if no image, post is skipped
 */
async function postToInstagram(article, articleIndex) {
  logger.info(`\n📸 Instagram → Article ${articleIndex + 1}: "${article.title.substring(0, 50)}..."`);

  // Instagram requires an image
  if (!article.localImagePath || !await fs.pathExists(article.localImagePath)) {
    logger.warn('⚠️ Instagram requires an image. No image available — skipping.');
    await markPosted(articleIndex, 'instagram', false, 'No image available');
    return false;
  }

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser(true));

    // Load session
    await loadCookies(page, 'instagram');
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2500, 4000);

    if (!await isLoggedIn(page)) {
      logger.warn('⚠️ Instagram session expired — logging in...');
      await loginToInstagram(page);
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
      await delay(2000, 3000);
    }
    logger.info('✅ Logged in to Instagram');
    await screenshot(page, `${articleIndex}-1-home`);

    // ── Click "Create" (+ button) ───────────────────────────────
    logger.info('🖊️ Opening Instagram create post...');

    const CREATE_SELECTORS = [
      'svg[aria-label="New post"]',
      '[aria-label="New post"]',
      '[aria-label="Create"]',
      'svg[aria-label="Create"]',
    ];

    let createClicked = false;
    for (const sel of CREATE_SELECTORS) {
      const el = await waitForSafe(page, sel, 3000);
      if (el) {
        // Click the parent anchor/button
        await page.evaluate(s => {
          const el = document.querySelector(s);
          const clickable = el?.closest('a, button, [role="button"]') || el;
          if (clickable) clickable.click();
        }, sel);
        createClicked = true;
        break;
      }
    }

    // Fallback: find by text
    if (!createClicked) {
      createClicked = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('span, a'));
        const el = spans.find(s => s.textContent.trim() === 'Create');
        if (el) { (el.closest('a, button') || el).click(); return true; }
        return false;
      });
    }

    if (!createClicked) {
      await screenshot(page, `${articleIndex}-ERR-no-create-btn`);
      throw new Error('Could not find Instagram Create/+ button');
    }

    await delay(2000, 3000);
    await screenshot(page, `${articleIndex}-2-create-menu`);

    // ── Select "Post" from menu (not Story/Reel) ────────────────
    await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('[role="menuitem"], [role="dialog"] li, [role="option"], [role="button"], button, span')
      );
      const postItem = candidates.find((i) => {
        const t = (i.textContent || '').replace(/\s+/g, ' ').trim();
        return t === 'Post';
      });
      if (postItem) postItem.click();
    });
    await delay(2500, 4000);

    // ── Upload image ────────────────────────────────────────────
    logger.info('🖼️ Uploading image to Instagram...');

    // File inputs are often hidden; they can appear a few seconds after "Post"
    let fileInput = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && !fileInput) {
      const handles = await page.$$('input[type="file"]');
      for (const h of handles) {
        const usable = await h.evaluate((el) => {
          const a = (el.getAttribute('accept') || '').toLowerCase();
          return !a || a.includes('image') || a.includes('video') || a.includes('*');
        });
        if (usable) {
          fileInput = h;
          break;
        }
      }
      if (!fileInput) await delay(400, 700);
    }
    if (!fileInput) throw new Error('Instagram file input not found');

    await fileInput.uploadFile(article.localImagePath);
    logger.info('✅ Image selected');
    await delay(3000, 5000);
    await screenshot(page, `${articleIndex}-3-image-selected`);

    // ── Click "Next" (crop screen) ──────────────────────────────
    logger.info('▶️ Clicking Next (past crop)...');
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const nextBtn = btns.find(b => b.textContent.trim() === 'Next');
        if (nextBtn) nextBtn.click();
      });
      await delay(2000, 3000);
    }
    await screenshot(page, `${articleIndex}-4-caption-screen`);

    // ── Write caption ───────────────────────────────────────────
    logger.info('⌨️ Writing caption...');
    const caption = buildCaption(article);

    const captionBox = await waitForSafe(page, 'textarea[aria-label*="caption" i]', 5000)
      || await waitForSafe(page, '[contenteditable][aria-label*="caption" i]', 5000)
      || await waitForSafe(page, 'div[role="textbox"]', 5000);

    if (captionBox) {
      await captionBox.click();
      await delay(400, 700);
      await page.keyboard.type(caption, { delay: 20 });
      logger.info(`✅ Caption typed (${caption.length} chars)`);
    } else {
      logger.warn('⚠️ Caption box not found — posting without caption');
    }

    await delay(10000, 15000); // 👈 Increased delay: Instagram needs time to process the image/metadata
    await screenshot(page, `${articleIndex}-5-caption`);

    // ── Share ───────────────────────────────────────────────────
    logger.info('🚀 Sharing Instagram post...');
    let shared = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const buttonInfo = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const shareBtn = btns.find(b => b.textContent.trim() === 'Share');
        if (!shareBtn) return { found: false };
        return { 
          found: true, 
          disabled: shareBtn.disabled || shareBtn.getAttribute('aria-disabled') === 'true',
          text: shareBtn.textContent 
        };
      });

      if (!buttonInfo.found) {
        logger.warn(`⚠️ Share button not found (Attempt ${attempt}/3)`);
      } else if (buttonInfo.disabled) {
        logger.warn(`⚠️ Share button is DISABLED (Attempt ${attempt}/3). Still processing?`);
      } else {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          const shareBtn = btns.find(b => b.textContent.trim() === 'Share');
          if (shareBtn) shareBtn.click();
        });
        logger.info(`🚀 Clicked Share button (Attempt ${attempt}/3)`);
      }
      
      logger.info(`⏳ Waiting for share confirmation (Attempt ${attempt}/3)...`);
      try {
        await page.waitForFunction(() => {
          const text = document.body.innerText;
          return text.includes('Your post has been shared') || text.includes('Post shared');
        }, { timeout: 20000 });
        shared = true;
        logger.info('✅ Share confirmed! "Your post has been shared" detected.');
        break;
      } catch (e) {
        const stillHasDialog = await page.$('[role="dialog"]');
        if (!stillHasDialog) {
          logger.info('✅ Share confirmed! Dialog vanished (assuming success)');
          shared = true;
          break;
        }
        logger.warn(`⚠️ Share attempt ${attempt} timed out. Dialog still open.`);
        await screenshot(page, `${articleIndex}-DEBUG-ATTEMPT-${attempt}`);
      }
    }

    if (!shared) {
      throw new Error('Instagram Share failed or timed out after 3 attempts');
    }

    await delay(3000, 5000); // Final buffer for safety
    await screenshot(page, `${articleIndex}-6-shared`);
    logger.info(`🎉 Instagram post shared! Article ${articleIndex + 1}`);
    await markPosted(articleIndex, 'instagram', true);
    return true;

  } catch (err) {
    logger.error(`❌ Instagram posting failed (article ${articleIndex}): ${err.message}`);
    if (page) await screenshot(page, `${articleIndex}-FATAL-ERROR`);
    await markPosted(articleIndex, 'instagram', false, err.message);
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
    const ok = await postToInstagram(article, idx);
    process.exit(ok ? 0 : 1);
  }).catch(err => { logger.error(err); process.exit(1); });
}

module.exports = { postToInstagram };
