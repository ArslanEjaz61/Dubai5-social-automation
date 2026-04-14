const { postToInstagram } = require('./posters/instagram');
const fs = require('fs-extra');
const path = require('path');

async function test() {
    console.log('🚀 Starting Final Instagram Test...');
    
    // Find a real image on the server first
    const imageDir = './state/images';
    let testImage = '';
    
    if (fs.existsSync(imageDir)) {
        const files = fs.readdirSync(imageDir).filter(f => f.endsWith('.png'));
        if (files.length > 0) {
            testImage = path.join(imageDir, files[0]);
            console.log('🖼️ Found test image:', testImage);
        }
    }

    if (!testImage) {
        console.error('❌ No images found in state/images to test with!');
        process.exit(1);
    }

    const article = {
        title: 'Dubai Smart City Test',
        description: 'This is a test post to verify the automated Instagram pipeline on the AWS server.',
        localImagePath: testImage,
        articleURL: 'https://dubai5.space'
    };

    try {
        const ok = await postToInstagram(article, 999);
        console.log('\n==========================================');
        console.log(ok ? '✅ TEST SUCCESSFUL!' : '❌ TEST FAILED');
        console.log('==========================================\n');
        process.exit(ok ? 0 : 1);
    } catch (err) {
        console.error('💥 CRITICAL TEST ERROR:', err);
        process.exit(1);
    }
}

test();
