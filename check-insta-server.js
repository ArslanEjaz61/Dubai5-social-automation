const { launchBrowser } = require('./browser');
const { loadCookies } = require('./setup');
const fs = require('fs-extra');
const path = require('path');

async function check() {
  let browser, page;
  try {
    ({ browser, page } = await launchBrowser(true));
    await loadCookies(page, 'instagram');
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));
    
    const url = page.url();
    console.log('Current URL:', url);
    
    const loggedIn = !url.includes('/login');
    console.log('Logged In:', loggedIn ? 'YES' : 'NO');
    
    await page.screenshot({ path: 'insta_check.png', fullPage: true });
    console.log('📸 Screenshot saved as insta_check.png');

    if (loggedIn) {
        // Try to find username
        const username = await page.evaluate(() => {
            const el = document.querySelector('a[href*="/"] img[alt*="profile" i]');
            return el ? el.closest('a').getAttribute('href') : 'unknown';
        });
        console.log('User Profile Path:', username);
    }

  } catch (err) {
    console.error('❌ Check failed:', err.message);
  } finally {
    if (browser) await browser.close();
  }
}

check();
