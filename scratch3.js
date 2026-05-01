const { BrowserLauncher } = require('./out/browser/browserLauncher.js');
const { BrowserSession } = require('./out/browser/browserSession.js');
const fs = require('fs');

async function test() {
  try {
    const session = await BrowserSession.create({
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      screenshotFormat: 'jpeg',
      jpegQuality: 80
    });
    await session.navigate('https://google.com');
    // Wait a bit to ensure it renders
    await new Promise(r => setTimeout(r, 2000));
    
    // Try fromSurface: false
    const shot = await session.client.send("Page.captureScreenshot", {
      format: 'jpeg',
      quality: 80,
      fromSurface: false
    });
    
    const base64Data = shot.data;
    fs.writeFileSync('screenshot_false.jpg', base64Data, 'base64');
    console.log('Saved screenshot_false.jpg, size:', base64Data.length);
    
    await session.close();
  } catch (err) {
    console.error('Error:', err);
  }
}
test();
