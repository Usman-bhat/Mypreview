const { BrowserLauncher } = require('./out/browser/browserLauncher.js');
const { BrowserSession } = require('./out/browser/browserSession.js');
const fs = require('fs');

async function test() {
  console.log('Starting...');
  try {
    const session = await BrowserSession.create({
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      screenshotFormat: 'jpeg',
      jpegQuality: 80
    });
    console.log('Session created');
    await session.navigate('https://google.com');
    console.log('Navigated');
    // Wait a bit to ensure it renders
    await new Promise(r => setTimeout(r, 2000));
    const shot = await session.captureScreenshot();
    const base64Data = shot.dataUrl.replace(/^data:image\/jpeg;base64,/, "");
    fs.writeFileSync('screenshot.jpg', base64Data, 'base64');
    console.log('Saved screenshot.jpg');
    await session.close();
  } catch (err) {
    console.error('Error:', err);
  }
}
test();
