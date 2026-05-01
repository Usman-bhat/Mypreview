const { BrowserLauncher } = require('./out/browser/browserLauncher.js');
const { BrowserSession } = require('./out/browser/browserSession.js');

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
    const html = await session.getDocumentHtml();
    console.log('HTML length:', html.length);
    const shot = await session.captureScreenshot();
    console.log('Screenshot length:', shot.dataUrl.length);
    console.log('Screenshot prefix:', shot.dataUrl.substring(0, 50));
    await session.close();
  } catch (err) {
    console.error('Error:', err);
  }
}
test();
