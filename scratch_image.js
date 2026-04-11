const puppeteer = require('C:\\Users\\Arslan Malik\\Desktop\\Dubai5 social automation\\node_modules\\puppeteer-core');
const {launchBrowser} = require('./browser');
const {loadCookies} = require('./setup');

async function run() {
  const {browser, page} = await launchBrowser(true);
  await loadCookies(page, 'linkedin');
  
  await page.goto('https://www.linkedin.com/company/dubai5-foresight/', {waitUntil: 'domcontentloaded'});
  await new Promise(r => setTimeout(r, 4000));
  
  // Click start a post
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('a, button')).find(x => x.textContent && x.textContent.trim().toLowerCase() === 'start a post');
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 4000));
  
  // Try to click Add media
  try {
    await page.click('[aria-label="Add media"]');
    console.log('Clicked Add Media button');
  } catch(e) {
    console.log('Could not click Add Media Button by exact label, trying query selector..');
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(el => el.getAttribute('aria-label') && el.getAttribute('aria-label').includes('media'));
      if (btn) btn.click();
    });
  }
  
  await new Promise(r => setTimeout(r, 4000));
  await page.screenshot({path: 'logs/screenshots/linkedin/modal.png'});
  
  const numFileInputs = await page.evaluate(() => document.querySelectorAll('input[type="file"]').length);
  console.log('File inputs in DOM:', numFileInputs);
  
  const fileInputHtml = await page.evaluate(() => { return Array.from(document.querySelectorAll('input[type="file"]')).map(el => el.outerHTML).join('\n') });
  console.log('File inputs HTML:\n', fileInputHtml);
  
  await browser.close();
}

run();
