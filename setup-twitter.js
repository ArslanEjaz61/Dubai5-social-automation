/**
 * setup-twitter.js — Quick Twitter manual login
 * Opens a visible browser for you to log in manually, then saves cookies.
 * 
 * Usage: node setup-twitter.js
 * After logging in, press ENTER in terminal to save cookies.
 */
require('dotenv').config();
const { setupPlatformLogin } = require('./setup');

console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║     Twitter/X Manual Login — Cookie Saver            ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('\n📋 Steps:');
console.log('  1. A Chrome window will open with X login page');
console.log('  2. Log in manually with your credentials');
console.log('  3. Once you see the home feed, come back here');
console.log('  4. Press ENTER to save the session cookies\n');

setupPlatformLogin('twitter', 'https://x.com/login')
  .then(() => {
    console.log('\n✅ Twitter cookies saved! Now automated posting will work.');
    console.log('Run: node post-all-now.js --twitter-only\n');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
