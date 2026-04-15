const { launchBrowser } = require('../browser');
const fs = require('fs');
const path = require('path');

async function serverSetup() {
  console.log('🚀 Launching Chrome for PHYSICAL SERVER SETUP...');
  console.log('⚠️ Note: This script requires a GUI (Desktop) on the server.');
  
  // Launch in non-headless mode (visible window)
  const { browser, page } = await launchBrowser(false); 

  try {
    await page.goto('https://business.facebook.com/latest/composer', { waitUntil: 'networkidle2' });
    
    console.log('\n--- SESSION CAPTURE INSTRUCTIONS ---');
    console.log('1. Log in to Facebook completely.');
    console.log('2. Navigate to the Dubai5 Business Suite composer.');
    console.log('3. Once you are on the "Create Post" screen, come back here and press ENTER.');
    console.log('------------------------------------\n');

    process.stdin.resume();
    await new Promise(resolve => process.stdin.once('data', resolve));

    // Save cookies
    const cookies = await page.cookies();
    const sessionDir = path.join(__dirname, '../logs/sessions');
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    fs.writeFileSync(path.join(sessionDir, 'facebook.json'), JSON.stringify(cookies, null, 2));
    console.log('✅ Facebook Session saved successfully on server!');

  } catch (err) {
    console.error('❌ Setup failed:', err.message);
  } finally {
    await browser.close();
    process.exit();
  }
}

serverSetup();
