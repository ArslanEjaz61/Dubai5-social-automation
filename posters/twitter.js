require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const logger = require('../logger');
const { launchBrowser } = require('../browser');
const { loadCookies, saveCookies } = require('../setup');
const { markPosted } = require('../queue');

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'logs', 'screenshots', 'twitter');
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

/** Check if logged in to X */
async function isLoggedIn(page) {
  const url = page.url();
  return !url.includes('/login') && !url.includes('/i/flow');
}

/** Login to X with credentials */
async function loginToTwitter(page) {
  const username = process.env.TWITTER_USERNAME?.replace(/^@/, '') || '';
  const password = process.env.TWITTER_PASSWORD;
  if (!username || !password) throw new Error('TWITTER_USERNAME/PASSWORD not set in .env');

  logger.info('🔐 Logging in to X (Twitter)...');
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'load', timeout: 60000 });
  await delay(5000, 8000);
  await screenshot(page, 'login-page-loaded');

  // Step 1: Wait for the username input — use multiple selectors
  const USERNAME_SELECTORS = ['input[autocomplete="username"]', 'input[name="text"]', 'input[type="text"]'];
  let usernameInput = null;

  for (let attempt = 0; attempt < 3 && !usernameInput; attempt++) {
    for (const sel of USERNAME_SELECTORS) {
      usernameInput = await waitForSafe(page, sel, 10000);
      if (usernameInput) break;
    }
    if (!usernameInput && attempt < 2) {
      logger.info(`🔄 Login form attempt ${attempt + 2}...`);
      await page.reload({ waitUntil: 'load', timeout: 45000 });
      await delay(6000, 10000);
    }
  }

  if (!usernameInput) {
    await screenshot(page, 'login-no-username-field');
    throw new Error('X login page did not load correctly');
  }

  // Focus, clear, and type username
  await usernameInput.click({ clickCount: 3 });
  await delay(300, 500);
  await usernameInput.type(username, { delay: 50 });
  await delay(800, 1200);
  await screenshot(page, 'login-username-typed');

  // Click Next using native mouse click
  const nextBox = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const nextBtn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'next');
    if (nextBtn) {
      const rect = nextBtn.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    return null;
  });
  if (nextBox) {
    await page.mouse.click(nextBox.x, nextBox.y);
    logger.info('✅ Clicked Next button');
  } else {
    await page.keyboard.press('Enter');
    logger.info('⌨️ Pressed Enter as fallback');
  }
  await delay(3000, 5000);
  await screenshot(page, 'login-after-next');

  // Handle "unusual activity" / verification screen
  const unusualInput = await page.$('input[data-testid="ocfEnterTextTextInput"]');
  if (unusualInput) {
    logger.info('⚠️ Unusual activity challenge — entering username...');
    await unusualInput.click({ clickCount: 3 });
    await unusualInput.type(username, { delay: 50 });
    await delay(500, 800);
    const ocfNext = await page.$('[data-testid="ocfEnterTextNextButton"]');
    if (ocfNext) await ocfNext.click();
    await delay(3000, 4000);
  }

  // Step 2: Enter password
  let passwordInput = await waitForSafe(page, 'input[name="password"]', 10000);
  if (!passwordInput) passwordInput = await waitForSafe(page, 'input[type="password"]', 5000);
  if (!passwordInput) {
    await screenshot(page, 'login-no-password-field');
    throw new Error('Password input not found');
  }
  await passwordInput.click({ clickCount: 3 });
  await delay(300, 500);
  await passwordInput.type(password, { delay: 50 });
  await delay(500, 800);
  await screenshot(page, 'login-password-typed');

  // Click Login button
  const loginBtn = await page.$('[data-testid="LoginForm_Login_Button"]');
  if (loginBtn) {
    await loginBtn.click();
    logger.info('✅ Clicked Login button');
  } else {
    await page.keyboard.press('Enter');
  }
  await delay(6000, 10000);

  const url = page.url();
  await screenshot(page, 'login-result');
  if (url.includes('/i/flow/login')) {
    await screenshot(page, 'login-failed');
    throw new Error('X login failed — check credentials in .env');
  }

  await saveCookies(page, 'twitter');
  logger.info('✅ X (Twitter) login successful!');
}

/** Build tweet content — uses Supabase caption, truncated to X's limits */
function buildTweetContent(article) {
  const url = article.articleUrl || process.env.WEBSITE_URL || 'https://dubai5.space';

  // Use Supabase social_caption if available — trim to ~250 chars + URL
  if (article.socialCaption && article.socialCaption.length > 20) {
    const maxLen = 250; // leave room for URL (~23 chars auto-shortened by X)
    let caption = article.socialCaption.substring(0, maxLen);
    // Remove any existing URLs from caption to avoid duplication
    caption = caption.replace(/https?:\/\/\S+/g, '').trim();
    return `${caption}\n\n🔗 ${url}`;
  }

  // Fallback
  const hashtags = '#Dubai #UAE #DubaiFuture #Innovation';
  const maxTitle = 280 - 23 - hashtags.length - 10;
  const truncatedTitle = article.title.length > maxTitle
    ? article.title.substring(0, maxTitle - 3) + '...'
    : article.title;
  return `🔮 ${truncatedTitle}\n\n${url}\n\n${hashtags}`;
}

/**
 * Post article to X (Twitter)
 */
async function postToTwitter(article, articleIndex) {
  logger.info(`\n🐦 X (Twitter) → Article ${articleIndex + 1}: "${article.title.substring(0, 50)}..."`);

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser(true));

    // Load session
    await loadCookies(page, 'twitter');
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(3000, 5000);

    if (!await isLoggedIn(page)) {
      logger.warn('⚠️ X session expired — logging in with credentials...');
      await loginToTwitter(page);
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(3000, 5000);
    }
    logger.info('✅ Logged in to X');
    await screenshot(page, `${articleIndex}-1-home`);

    // ── Open compose ────────────────────────────────────────────
    logger.info('🖊️ Opening tweet composer...');
    
    // Wait for the page to be stable (hide spinners if any)
    await page.waitForFunction(() => !document.querySelector('svg[viewBox="0 0 24 24"] circle'), { timeout: 15000 }).catch(() => {});

    // Try multiple ways to open the modal
    const sidebarPostBtn = await waitForSafe(page, '[data-testid="SideNav_NewTweet_Button"]', 10000)
      || await page.evaluateHandle(() => {
           return Array.from(document.querySelectorAll('a, div[role="button"]')).find(el => {
             const t = el.textContent ? el.textContent.trim().toLowerCase() : '';
             return t === 'post' || t === 'tweet';
           });
         });

    let composerOpened = false;

    if (sidebarPostBtn) {
      await page.evaluate(el => el.click(), sidebarPostBtn); // JS click is sometimes more reliable for sidebar
      await delay(2500, 4000);
      
      // Check for modal presence (modal has role="dialog")
      const modal = await page.$('[role="dialog"]');
      const textArea = await page.$('[role="textbox"]') || await page.$('[data-testid="tweetTextarea_0"]');
      
      if (modal || textArea) {
        composerOpened = true;
        logger.info('✅ Opened composer (modal/direct)');
      }
    }

    if (!composerOpened) {
      logger.info('🔄 Trying to find any available text box...');
      const fallbackTextArea = await waitForSafe(page, '[role="textbox"]', 5000)
        || await waitForSafe(page, '[data-testid="tweetTextarea_0"]', 5000);
      
      if (fallbackTextArea) {
        await fallbackTextArea.click();
        composerOpened = true;
      }
    }

    if (!composerOpened) {
      await screenshot(page, `${articleIndex}-ERR-no-compose`);
      throw new Error('Could not find or open X tweet composer');
    }

    await screenshot(page, `${articleIndex}-2-composer-ready`);

    // ── Step 1: Upload image ────────────────────────────────────
    if (article.localImagePath && await fs.pathExists(article.localImagePath)) {
      logger.info(`🖼️ Uploading image (${article.localImagePath})...`);
      try {
        // Find the "Add photos or video" button
        const mediaButton = await page.$('[aria-label*="Add photos"]') 
           || await page.$('[data-testid="fileInput"]')
           || await page.evaluateHandle(() => {
              return Array.from(document.querySelectorAll('div[role="button"]')).find(el => {
                const label = el.getAttribute('aria-label') || '';
                return label.toLowerCase().includes('add photos') || label.toLowerCase().includes('media');
              });
           });

        if (mediaButton) {
          try {
            const [fileChooser] = await Promise.all([
              page.waitForFileChooser({ timeout: 15000 }),
              page.evaluate(el => el.click(), mediaButton),
            ]);
            await fileChooser.accept([article.localImagePath]);
            logger.info('✅ Image selected via file chooser');
          } catch (chooserErr) {
            // Fallback to direct upload if chooser fails
            const fileInput = await page.$('input[type="file"]') || await page.$('input[data-testid="fileInput"]');
            if (fileInput) {
              await fileInput.uploadFile(article.localImagePath);
              logger.info('✅ Image uploaded via direct input fallback');
            } else {
              throw chooserErr;
            }
          }
          await delay(5000, 8000); // Wait for upload processing
          await screenshot(page, `${articleIndex}-3-image-attached`);
        } else {
          logger.warn('⚠️ No media button or file input found for X');
        }
      } catch (imgErr) {
        logger.warn(`⚠️ X image upload error: ${imgErr.message}`);
      }
    }

    // ── Step 2: Type tweet content ──────────────────────────────
    logger.info('⌨️ Typing tweet content...');
    const tweetContent = buildTweetContent(article);

    // Re-find textarea
    const textArea = await waitForSafe(page, '[role="textbox"]', 8000)
      || await waitForSafe(page, '[data-testid="tweetTextarea_0"]', 5000);
      
    if (!textArea) throw new Error('Tweet text area not found after image upload');

    await textArea.click();
    await delay(1000, 1500);
    
    // Use focus and keyboard.type for better React support
    await textArea.focus();
    await page.keyboard.type(tweetContent, { delay: 30 });
    
    logger.info(`✅ Typed ${tweetContent.length} chars`);
    await delay(2000, 3000);
    await screenshot(page, `${articleIndex}-4-content-ready`);

    await delay(1500, 2500);

    // ── Post tweet ──────────────────────────────────────────────
    logger.info('🚀 Posting tweet...');
    const POST_SELECTORS = [
      '[data-testid="tweetButton"]',
      '[data-testid="tweetButtonInline"]',
    ];

    let posted = false;
    for (const sel of POST_SELECTORS) {
      const btn = await waitForSafe(page, sel, 5000);
      if (btn) {
        const disabled = await btn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
        if (!disabled) {
          await btn.click();
          posted = true;
          break;
        }
      }
    }

    if (!posted) throw new Error('Could not find or click X Post button');

    await delay(5000, 7000);
    await screenshot(page, `${articleIndex}-5-posted`);
    logger.info(`🎉 X (Twitter) post published! Article ${articleIndex + 1}`);
    await markPosted(articleIndex, 'twitter', true);
    return true;

  } catch (err) {
    logger.error(`❌ X posting failed (article ${articleIndex}): ${err.message}`);
    if (page) await screenshot(page, `${articleIndex}-FATAL-ERROR`);
    await markPosted(articleIndex, 'twitter', false, err.message);
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
        title: 'Dubai Smart City Initiative Sets Global Benchmark for Urban AI',
        description: 'New initiative transforming urban life.',
        imageUrl: null, localImagePath: null,
        articleUrl: 'https://dubai5.space'
      };
    }
    const ok = await postToTwitter(article, idx);
    process.exit(ok ? 0 : 1);
  }).catch(err => { logger.error(err); process.exit(1); });
}

module.exports = { postToTwitter };
