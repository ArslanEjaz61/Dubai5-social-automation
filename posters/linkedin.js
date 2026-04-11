require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const logger = require('../logger');
const { launchBrowser } = require('../browser');
const { loadCookies, saveCookies, isLoggedIn } = require('../setup');
const { markPosted, getArticleByIndex } = require('../queue');

const LINKEDIN_URL = 'https://www.linkedin.com';
const COMPANY_PAGE_URL = process.env.LINKEDIN_COMPANY_URL || 'https://www.linkedin.com/company/dubai5-foresight/';
const COMPANY_SHARE_URL = process.env.LINKEDIN_SHARE_URL || 'https://www.linkedin.com/company/113101023/admin/page-posts/published/?share=true';
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'logs', 'screenshots', 'linkedin');

fs.ensureDirSync(SCREENSHOTS_DIR);

/** Random human-like delay */
function delay(min = 800, max = 2500) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Type text — uses clipboard paste for long content to avoid memory issues */
async function humanType(page, text) {
  if (text.length > 100) {
    // Paste via clipboard for long text (avoids heap OOM on char-by-char typing)
    await page.evaluate(async (t) => {
      const el = document.activeElement || document.querySelector('.ql-editor, [role="textbox"], [contenteditable="true"]');
      if (el) {
        el.focus();
        document.execCommand('insertText', false, t);
      }
    }, text);
  } else {
    await page.keyboard.type(text, { delay: Math.floor(Math.random() * 40) + 25 });
  }
}

/** Save a debug screenshot */
async function screenshot(page, name) {
  try {
    const filePath = path.join(SCREENSHOTS_DIR, `${Date.now()}-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    logger.info(`📸 Screenshot saved: ${name}`);
  } catch (e) { /* non-fatal */ }
}

/** Wait for selector safely, return null if timeout */
async function waitForSafe(page, selector, timeout = 8000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return await page.$(selector);
  } catch (e) { return null; }
}

/** Login with credentials (fallback when cookies expire) */
async function loginWithCredentials(page) {
  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  if (!email || !password) {
    throw new Error('LinkedIn credentials not in .env — run "npm run setup" first.');
  }

  logger.info('🔐 Logging in with credentials...');
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  await delay(1000, 2000);

  const emailFocused = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="email"], #username, #session_key'));
    const visibleInput = inputs.find(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    if (visibleInput) { visibleInput.focus(); return true; }
    return false;
  });
  if (!emailFocused) throw new Error('Could not find visible email input');

  await humanType(page, email);
  await delay(500, 900);

  const passFocused = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
    const visibleInput = inputs.find(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    if (visibleInput) { visibleInput.focus(); return true; }
    return false;
  });
  if (!passFocused) throw new Error('Could not find visible password input');

  await humanType(page, password);
  await delay(400, 800);

  // Submit form
  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });

  const url = page.url();
  if (url.includes('/checkpoint') || url.includes('/challenge')) {
    throw new Error('LinkedIn needs 2FA/captcha — run "npm run setup" and log in manually.');
  }
  if (url.includes('/login')) {
    await screenshot(page, 'credential-login-failed');
    throw new Error('LinkedIn login failed — check credentials in .env');
  }

  await saveCookies(page, 'linkedin');
  logger.info('✅ Credential login successful!');
}

/** Ensure session is active */
async function ensureLoggedIn(page) {
  await loadCookies(page, 'linkedin');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delay(2000, 3000);

  const loggedIn = await isLoggedIn(page, 'linkedin');
  if (!loggedIn) {
    logger.warn('⚠️ Session expired — trying credential login...');
    await loginWithCredentials(page);
  } else {
    logger.info('✅ LinkedIn session active');
  }
}

/** Build the LinkedIn post caption — uses Supabase social_caption if available */
function buildPostContent(article) {
  // Use pre-built Supabase caption if available (best quality)
  if (article.socialCaption && article.socialCaption.length > 30) {
    return article.socialCaption;
  }

  // Fallback: build manually
  const { title, description, articleUrl, tags } = article;
  let content = `🔮 ${title}\n\n`;
  if (description && description.length > 20) {
    content += `${description.substring(0, 600)}\n\n`;
  }
  content += `🌆 Dubai's Future, Decoded Daily.\n\n`;
  content += `🔗 ${articleUrl || process.env.WEBSITE_URL || 'https://dubai5.space'}\n\n`;

  // Use article tags if available
  const tagStr = (tags || []).map(t => `#${t.replace(/\s+/g, '')}`).join(' ');
  content += tagStr || '#Dubai #DubaiFuture #UAE #Innovation #DubaiTech #Dubai5';
  return content;
}

/**
 * Post article to LinkedIn Company Page
 */
async function postToLinkedIn(article, articleIndex) {
  logger.info(`\n🔷 LinkedIn → Article ${articleIndex + 1}: "${article.title.substring(0, 55)}..."`);

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser(true));

    // ── Step 1: Login ──────────────────────────────────────────
    await ensureLoggedIn(page);
    await screenshot(page, `${articleIndex}-1-logged-in`);

    // ── Step 2: Go directly to Company Share URL ─────────────────────
    logger.info(`🏠 Navigating to direct share URL...`);
    await page.goto(COMPANY_SHARE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {
      logger.warn('⚠️ Page load slow — continuing anyway');
    });
    await delay(5000, 7000);
    await screenshot(page, `${articleIndex}-2-share-page`);

    // ── Step 3: Wait for the composer to appear ────────────────────────
    logger.info('🖊️ Waiting for post composer...');

    let composerReady = false;
    const EDITOR_SELECTORS = ['.ql-editor', '[role="textbox"]', '[contenteditable="true"]'];
    for (const sel of EDITOR_SELECTORS) {
      const el = await waitForSafe(page, sel, 15000);
      if (el) { composerReady = true; break; }
    }

    if (!composerReady) {
      // Fallback: try clicking "Start a post" if the share param didn't auto-open composer
      logger.info('🔄 Composer not auto-opened — trying to click Start a post...');
      const clickedStart = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, a, div[role="button"], li, span'));
        for (const el of els) {
          const text = (el.textContent || '').trim();
          if (text.startsWith('Start a post') && text.length < 80) {
            const target = el.closest('li') || el.closest('a') || el.closest('button') || el;
            const rect = target.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              target.click();
              return true;
            }
          }
        }
        return false;
      });

      if (clickedStart) {
        await delay(3000, 5000);
        const retryReady = await page.evaluate(() => {
          return !!document.querySelector('.ql-editor, [role="textbox"], [contenteditable="true"]');
        });
        if (!retryReady) {
          await screenshot(page, `${articleIndex}-ERR-no-composer`);
          throw new Error('Composer did not open after clicking Start a post');
        }
      } else {
        await screenshot(page, `${articleIndex}-ERR-no-composer`);
        throw new Error('Could not open post composer on company page');
      }
    }

    await screenshot(page, `${articleIndex}-3-composer`);
    logger.info('✅ Composer opened as company identity');

    // ── Step 5: Upload image FIRST ──────────────────────────────
    if (article.localImagePath && await fs.pathExists(article.localImagePath)) {
      logger.info(`🖼️ Uploading image: ${path.basename(article.localImagePath)}`);

      try {
        // Click the media/photo button in the composer and intercept the file chooser
        const [fileChooser] = await Promise.all([
          page.waitForFileChooser({ timeout: 15000 }),
          page.evaluate(() => {
            // Try aria-label based search first
            const btns = Array.from(document.querySelectorAll('button'));
            let mediaBtn = btns.find(el => {
              const label = (el.getAttribute('aria-label') || '').toLowerCase();
              return label.includes('media') || label.includes('photo') || label.includes('image');
            });
            // Fallback: find buttons with SVG icons in the composer toolbar area
            if (!mediaBtn) {
              const composerBtns = btns.filter(b => {
                const rect = b.getBoundingClientRect();
                return rect.y > 350 && rect.width > 20 && rect.width < 60 && b.querySelector('svg, li-icon');
              });
              if (composerBtns.length > 0) mediaBtn = composerBtns[0];
            }
            if (mediaBtn) { mediaBtn.click(); return true; }
            return false;
          })
        ]);

        await fileChooser.accept([article.localImagePath]);
        logger.info('✅ Image uploaded!');
        await delay(5000, 7000);

        // Click Next/Done on image editor if it appears
        const editorClosed = await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(el => {
            const t = (el.textContent || '').trim().toLowerCase();
            return t === 'next' || t === 'done';
          });
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (editorClosed) {
          logger.info('✅ Closed image editor');
          await delay(3000, 4000);
        } else {
          await delay(2000, 3000);
        }
        await screenshot(page, `${articleIndex}-6-image`);
      } catch (imgErr) {
        logger.warn(`⚠️ Image upload failed: ${imgErr.message}`);
        await screenshot(page, `${articleIndex}-ERR-image`);
      }
    } else {
      logger.warn(`⚠️ No image file for this article`);
    }

    await delay(2000, 3000);

    // ── Step 6: Type post content ──────────────────────────────
    logger.info('⌨️ Typing post content...');
    const content = buildPostContent(article);

    const TEXT_AREA_SELECTORS = [
      '.ql-editor',
      '[role="textbox"]',
      '[contenteditable="true"]',
      'div[data-placeholder]',
    ];

    let typed = false;
    for (const sel of TEXT_AREA_SELECTORS) {
      const el = await waitForSafe(page, sel, 5000);
      if (el) {
        await el.click();
        await delay(400, 700);
        await humanType(page, content);
        typed = true;
        logger.info(`✅ Typed content (${content.length} chars)`);
        break;
      }
    }

    if (!typed) {
      await screenshot(page, `${articleIndex}-ERR-no-textarea`);
      throw new Error('Could not find text area in composer');
    }

    await delay(1500, 2500);
    await screenshot(page, `${articleIndex}-5-content`);

    // ── Step 7: Publish ────────────────────────────────────────
    logger.info('🚀 Clicking Publish...');

    const PUBLISH_SELECTORS = [
      'button.share-actions__primary-action',
      'button[aria-label="Post"]',
      '[data-control-name="share.post"]',
      'button.share-box-footer__primary-btn',
    ];

    let published = false;
    for (const sel of PUBLISH_SELECTORS) {
      const btn = await waitForSafe(page, sel, 3000);
      if (btn) {
        const txt = await btn.evaluate(el => el.textContent.trim());
        if (['post', 'share', 'publish'].some(w => txt.toLowerCase().includes(w))) {
          await btn.click();
          published = true;
          logger.info(`✅ Publish clicked ("${txt}")`);
          break;
        }
      }
    }

    // Fallback: find by text
    if (!published) {
      published = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => {
            const t = b.textContent.trim().toLowerCase();
            return (t === 'post' || t === 'share') && !b.disabled;
          });
        if (btn) { btn.click(); return true; }
        return false;
      });
    }

    if (!published) {
      await screenshot(page, `${articleIndex}-ERR-no-publish-btn`);
      throw new Error('Could not find Publish button');
    }

    await delay(5000, 8000);
    await screenshot(page, `${articleIndex}-7-done`);

    logger.info(`🎉 LinkedIn post #${articleIndex + 1} published successfully!`);
    await markPosted(articleIndex, 'linkedin', true);
    return true;

  } catch (err) {
    logger.error(`❌ LinkedIn post failed (article ${articleIndex}): ${err.message}`);
    if (page) await screenshot(page, `${articleIndex}-FATAL-ERROR`);
    await markPosted(articleIndex, 'linkedin', false, err.message);
    return false;
  } finally {
    if (browser) await browser.close();
  }
}

// ── Direct test ─────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const articleIndex = parseInt(
    (args.find(a => a.startsWith('--index=')) || '--index=0').split('=')[1]
  );

  logger.info(`🧪 Test mode — posting article ${articleIndex} to LinkedIn...`);

  getArticleByIndex(articleIndex).then(async article => {
    if (!article) {
      logger.warn('No queued article found — generating dummy data mapping for test');
      const testImagePath = path.join(__dirname, '..', 'state', 'images', 'test-image.png');
      fs.ensureDirSync(path.dirname(testImagePath));

      // If no valid image exists, just write a basic dummy file so we can at least test file logic locally
      if (!fs.existsSync(testImagePath)) {
        fs.writeFileSync(testImagePath, 'R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=', 'base64');
      }

      article = {
        index: articleIndex,
        title: 'Dubai Unveils AI-Powered Urban Management System',
        description: 'A groundbreaking initiative that transforms how Dubai manages urban infrastructure using real-time AI decision-making.',
        imageUrl: null,
        localImagePath: testImagePath,
        articleUrl: 'https://dubai5.space'
      };
    }
    const ok = await postToLinkedIn(article, articleIndex);
    logger.info(ok ? '✅ Test passed!' : '❌ Test failed');
    process.exit(ok ? 0 : 1);
  }).catch(err => {
    logger.error(err);
    process.exit(1);
  });
}

module.exports = { postToLinkedIn };
