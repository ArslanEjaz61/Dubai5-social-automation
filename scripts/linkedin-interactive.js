const { launchBrowser } = require('../browser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = (query) => new Promise((resolve) => rl.question(query, resolve));

async function linkedinInteractive() {
  console.log('🚀 Launching LINKEDIN INTERACTIVE SETUP on server...');
  
  const { browser, page } = await launchBrowser(true); // Headless for server
  const screenshotDir = path.join(__dirname, '../logs/interactive_linkedin');
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

  try {
    // 1. Load existing cookies to start from a logged-in state if possible
    const cookiePath = path.join(__dirname, '../logs/sessions/linkedin.json');
    if (fs.existsSync(cookiePath)) {
      const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
      await page.setCookie(...cookies);
      console.log('🍪 Loaded existing LinkedIn cookies');
    }

    // 2. Navigate to the problematic page (Analytics or Company Feed)
    await page.goto('https://www.linkedin.com/company/113101023/admin/page-posts/published/?share=true', { waitUntil: 'networkidle2' });
    
    let step = 0;
    while (true) {
      step++;
      const shotPath = path.join(screenshotDir, `step-${step}.png`);
      await page.screenshot({ path: shotPath });
      
      console.log(`\n📸 [STEP ${step}] Screenshot saved to logs/interactive_linkedin/step-${step}.png`);
      console.log('--- COMMANDS: type "<text>", click <x> <y>, wait <ms>, save, exit ---');
      
      const cmd = await ask('Enter command: ');
      
      if (cmd.startsWith('type ')) {
        const text = cmd.replace('type ', '');
        await page.keyboard.type(text);
        console.log(`⌨️ Typed: ${text}`);
      } else if (cmd.startsWith('click ')) {
        const [_, x, y] = cmd.split(' ');
        await page.mouse.click(parseInt(x), parseInt(y));
        console.log(`🖱️ Clicked: ${x}, ${y}`);
      } else if (cmd.startsWith('wait ')) {
        const ms = parseInt(cmd.replace('wait ', ''));
        await new Promise(r => setTimeout(r, ms));
        console.log(`⏳ Waited ${ms}ms`);
      } else if (cmd === 'save') {
        const cookies = await page.cookies();
        const sessionDir = path.join(__dirname, '../logs/sessions');
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'linkedin.json'), JSON.stringify(cookies, null, 2));
        console.log('✅ LinkedIn Session saved successfully!');
      } else if (cmd === 'exit') {
        break;
      }
      
      await new Promise(r => setTimeout(r, 1000));
    }

  } catch (err) {
    console.error('❌ LinkedIn Interactive setup failed:', err.message);
  } finally {
    await browser.close();
    process.exit();
  }
}

linkedinInteractive();
