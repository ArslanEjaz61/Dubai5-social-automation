/**
 * Browser launcher utility — uses puppeteer-core with your installed Chrome
 * No need to download Chromium (~300MB saved!)
 */
const puppeteerCore = require('puppeteer-core');
const fs = require('fs');

// Common Chrome/Edge installation paths on Windows
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  (process.env.PROGRAMFILES || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

/**
 * Find the installed browser executable path
 */
function findBrowserPath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  for (const p of CHROME_PATHS) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
  }
  throw new Error(
    'Chrome/Edge not found! Add CHROME_PATH to your .env:\n' +
    'CHROME_PATH=C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe'
  );
}

/**
 * Launch Puppeteer with system Chrome (no Chromium download needed)
 * @param {boolean} headless - true=background, false=visible window
 */
async function launchBrowser(headless = true) {
  const executablePath = findBrowserPath();

  const browser = await puppeteerCore.launch({
    executablePath,
    headless,
    protocolTimeout: 300000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--disable-infobars',
      '--window-size=1280,900'
    ],
    defaultViewport: headless ? { width: 1280, height: 900 } : null,
    ignoreDefaultArgs: ['--enable-automation']
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  return { browser, page };
}

module.exports = { launchBrowser, findBrowserPath };
