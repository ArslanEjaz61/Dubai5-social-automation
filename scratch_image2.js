const puppeteer = require('C:\\Users\\Arslan Malik\\Desktop\\Dubai5 social automation\\node_modules\\puppeteer-core');
const {launchBrowser} = require('./browser');
const {loadCookies} = require('./setup');
const fs = require('fs');

async function run() {
  // Create dummy image
  fs.writeFileSync('test.png', 'fake image data');

  const {browser, page} = await launchBrowser(true);
  await loadCookies(page, 'linkedin');
  
  await page.goto('https://www.linkedin.com/company/dubai5-foresight/', {waitUntil: 'domcontentloaded'});
  await new Promise(r => setTimeout(r, 4000));
  
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('a, button')).find(x => x.textContent && x.textContent.trim().toLowerCase() === 'start a post');
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 4000));
  
  console.log('Clicking media button and waiting for file chooser...');
  let chooserFound = false;
  try {
    const [fileChooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 10000 }),
      page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(el => el.getAttribute('aria-label') && (el.getAttribute('aria-label').includes('media') || el.getAttribute('aria-label').includes('photo') || el.getAttribute('aria-label').includes('image')));
        if (btn) btn.click();
      })
    ]);
    
    await fileChooser.accept([__dirname + '\\test.png']);
    console.log('Successfully intercepted file chooser and injected image!');
    chooserFound = true;
  } catch (e) {
    console.error('File chooser failed:', e.message);
  }
  
  await new Promise(r => setTimeout(r, 4000));
  await page.screenshot({path: 'logs/screenshots/linkedin/modal2.png'});
  
  await browser.close();
}

run();
