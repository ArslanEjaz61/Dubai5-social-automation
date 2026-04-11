require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const logger = require('../logger');
const { launchBrowser } = require('../browser');
const { loadCookies, saveCookies } = require('../setup');
const { markPosted } = require('../queue');

const FB_PAGE_URL = process.env.FACEBOOK_PAGE_URL || '';
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
  if (!emailInput) throw new Error('Facebook login page did not load');

  await emailInput.click();
  await page.keyboard.type(email, { delay: 40 });
  await delay(400, 700);

  const passInput = await waitForSafe(page, '#pass', 5000);
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

/**
 * Post article to Facebook Page via Meta Business Suite
 */
async function postToFacebook(article, articleIndex) {
  logger.info(`\n📘 Facebook (Meta Suite) → Article ${articleIndex + 1}: "${article.title.substring(0, 50)}..."`);

  const FB_SUITE_URL = `https://business.facebook.com/latest/composer/?asset_id=970837422790775&nav_ref=internal_nav&ref=biz_web_home_create_post&context_ref=HOME`;

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser(true));

    // Load session
    await loadCookies(page, 'facebook');
    
    logger.info('🔗 Navigating to Meta Business Suite Composer...');
    await page.goto(FB_SUITE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(5000, 8000); // Suite is heavy, wait for it to settle

    if (!await isLoggedIn(page)) {
      logger.warn('⚠️ Facebook session expired — logging in...');
      await loginToFacebook(page);
      await page.goto(FB_SUITE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      await delay(5000, 8000);
    }
    
    logger.info('✅ Logged in to Meta Business Suite');
    await screenshot(page, `${articleIndex}-1-suite-loaded`);

    // ── Meta Suite can show overlays/popups ─────────────────────
    try {
      const closePopup = await page.$('[aria-label="Close"]');
      if (closePopup) { await closePopup.click(); await delay(1000, 1500); }
    } catch (e) {}

    // ── Step 1: Upload image ────────────────────────────────────
    if (article.localImagePath && await fs.pathExists(article.localImagePath)) {
      logger.info(`🖼️ Uploading image (${article.localImagePath})...`);
      try {
        // Find "Add photo/video" button
        const addBtn = await page.evaluateHandle(() => {
          return Array.from(document.querySelectorAll('div[role="button"], button')).find(el => {
            const t = (el.textContent || '').toLowerCase();
            return t.includes('add photo') || t.includes('add photo/video');
          });
        });

        if (addBtn) {
          const [fileChooser] = await Promise.all([
            page.waitForFileChooser({ timeout: 15000 }),
            page.evaluate(el => el.click(), addBtn),
          ]);
          await fileChooser.accept([article.localImagePath]);
          logger.info('✅ Image selected via file chooser');
          await delay(6000, 10000); // Business Suite needs time to process media
          await screenshot(page, `${articleIndex}-2-image-attached`);
        } else {
          logger.warn('⚠️ Could not find "Add photo" button in Business Suite');
        }
      } catch (imgErr) {
        logger.warn(`⚠️ FB media upload error: ${imgErr.message}`);
      }
    }

    // ── Step 2: Type content ────────────────────────────────────
    logger.info('⌨️ Typing post content...');
    const content = buildPostContent(article);

    // Meta Suite uses an ARIA textbox
    const textArea = await waitForSafe(page, '[role="textbox"]', 10000)
      || await waitForSafe(page, 'div[contenteditable="true"]', 5000);

    if (!textArea) throw new Error('Could not find Facebook Suite text editor');

    await textArea.focus();
    await delay(500, 1000);
    await page.keyboard.type(content, { delay: 20 });
    logger.info(`✅ Typed ${content.length} chars`);
    await delay(2000, 3000);
    await screenshot(page, `${articleIndex}-3-content-ready`);

    // ── Step 3: Publish ─────────────────────────────────────────
    logger.info('🚀 Publishing Facebook post...');
    
    // Find the Publish button (it's often a div with text "Publish")
    const publishBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('div[role="button"]'));
      return btns.find(b => {
        const t = (b.textContent || '').trim().toLowerCase();
        return t === 'publish' && !b.getAttribute('aria-disabled');
      });
    });

    if (publishBtn) {
      await page.evaluate(el => el.click(), publishBtn);
      logger.info('✅ Clicked Publish button');
      await delay(10000, 15000); // Wait for feedback
      await screenshot(page, `${articleIndex}-4-published`);
      logger.info(`🎉 Facebook (Meta Suite) post published! Article ${articleIndex + 1}`);
      await markPosted(articleIndex, 'facebook', true);
      return true;
    } else {
      await screenshot(page, `${articleIndex}-ERR-no-publish-btn`);
      throw new Error('Could not find available Facebook Publish button');
    }

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
