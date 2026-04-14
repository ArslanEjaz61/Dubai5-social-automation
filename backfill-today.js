require('dotenv').config();
const { getQueue, markPosted, wasPosted } = require('./queue');
const { postToLinkedIn } = require('./posters/linkedin');
const { postToTwitter } = require('./posters/twitter');
const { postToFacebook } = require('./posters/facebook');
const { postToInstagram } = require('./posters/instagram');
const logger = require('./logger');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Returns current Dubai hour and minute
 */
function getDubaiTime() {
    const now = new Date();
    const dubaiDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
    return {
        h: dubaiDate.getHours(),
        m: dubaiDate.getMinutes(),
        totalMinutes: dubaiDate.getHours() * 60 + dubaiDate.getMinutes()
    };
}

async function runBackfill() {
    console.log('🔄 Loading today\'s queue for backfill...');
    const articles = await getQueue();
    
    if (!articles || !articles.length) {
        console.error('❌ No articles found in today\'s queue. Did you run the scraper?');
        return;
    }

    // Wait until 5:30 PM (17:30) Dubai time
    const targetMinutes = 17 * 60 + 30; // 5:30 PM
    let currentTime = getDubaiTime();

    if (currentTime.totalMinutes < targetMinutes) {
        const waitMins = targetMinutes - currentTime.totalMinutes;
        console.log(`\n⏳ It's ${currentTime.h}:${currentTime.m} Dubai. Waiting ${waitMins} minutes until 5:30 PM...`);
        await delay(waitMins * 60000);
    }

    console.log(`\n🚀 Starting Power-Backfill for ${articles.length} articles at 10-min intervals...`);

    const platforms = [
        { id: 'linkedin', post: postToLinkedIn },
        { id: 'twitter', post: postToTwitter },
        { id: 'facebook', post: postToFacebook },
        { id: 'instagram', post: postToInstagram }
    ];

    for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        logger.info(`\n📅 [BACKFILL] Article ${i+1}/${articles.length}: "${article.title}"`);

        for (const platform of platforms) {
            try {
                // We'll trust wasPosted to prevent double posting if it partially worked.
                const alreadyDone = await wasPosted(i, platform.id);
                if (alreadyDone) {
                    logger.info(`⏩ Already posted on ${platform.id}, skipping.`);
                    continue;
                }
                
                logger.info(`📤 Posting to ${platform.id}...`);
                const success = await platform.post(article, i);
                await markPosted(i, platform.id, success);
                
                // Human-like delay between platforms (5-10s)
                if (success) await delay(5000 + Math.random() * 5000);

            } catch (err) {
                logger.error(`❌ Failed on ${platform.id}: ${err.message}`);
                await markPosted(i, platform.id, false, err.message);
            }
        }

        if (i < articles.length - 1) {
            console.log(`\n⏳ Finalizing Article ${i+1}. Next post in 10 minutes...`);
            await delay(10 * 60 * 1000); // Strict 10 minutes
        }
    }

    console.log('\n✅ Backfill project completed! Bot is catching up.');
}

runBackfill().catch(err => {
    console.error('💥 Backfill process crashed:', err);
});
