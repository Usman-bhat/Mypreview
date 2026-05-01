"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserSession = void 0;
const node_events_1 = require("node:events");
const browserLauncher_1 = require("./browserLauncher");
const cdpClient_1 = require("./cdpClient");
class BrowserSession extends node_events_1.EventEmitter {
    browser;
    client;
    configuration;
    constructor(browser, client, configuration) {
        super();
        this.browser = browser;
        this.client = client;
        this.configuration = configuration;
    }
    static async create(configuration) {
        const browser = await browserLauncher_1.BrowserLauncher.launch(configuration);
        const client = new cdpClient_1.CdpClient(browser.pageWebSocketUrl);
        await client.connect();
        const session = new BrowserSession(browser, client, configuration);
        await session.bootstrap();
        return session;
    }
    async navigate(url) {
        const response = await this.client.send("Page.navigate", { url });
        if (response?.errorText) {
            throw new Error(response.errorText);
        }
        await this.waitForLoadState();
    }
    async reload(ignoreCache = false) {
        await this.client.send("Page.reload", { ignoreCache });
        await this.waitForLoadState();
    }
    async goBack() {
        const history = await this.getNavigationHistory();
        if (history.currentIndex > 0) {
            await this.client.send("Page.navigateToHistoryEntry", {
                entryId: history.entries[history.currentIndex - 1]?.id,
            });
            await this.waitForLoadState();
        }
    }
    async goForward() {
        const history = await this.getNavigationHistory();
        if (history.currentIndex < history.entries.length - 1) {
            await this.client.send("Page.navigateToHistoryEntry", {
                entryId: history.entries[history.currentIndex + 1]?.id,
            });
            await this.waitForLoadState();
        }
    }
    async captureScreenshot() {
        const format = this.configuration.screenshotFormat ?? "jpeg";
        const params = {
            captureBeyondViewport: false,
            format,
        };
        if (format === "jpeg") {
            const quality = clampInt(this.configuration.jpegQuality ?? 82, 40, 100);
            params.quality = quality;
        }
        await this.client.send("Page.bringToFront").catch(() => undefined);
        const response = await this.client.send("Page.captureScreenshot", params);
        if (!response?.data) {
            throw new Error("No screenshot data received from Chrome.");
        }
        const mime = format === "jpeg" ? "image/jpeg" : "image/png";
        return {
            dataUrl: `data:${mime};base64,${response.data}`,
            width: this.configuration.viewport.width,
            height: this.configuration.viewport.height,
            capturedAt: new Date().toISOString(),
        };
    }
    async clickPoint(x, y) {
        await this.client.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x,
            y,
            button: "none",
        });
        await this.client.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x,
            y,
            button: "left",
            clickCount: 1,
        });
        await this.client.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x,
            y,
            button: "left",
            clickCount: 1,
        });
        // Do not block up to 500ms on every click: most clicks do not navigate. Prefer a fast
        // paint window; if navigation occurs, loadEventFired usually wins first.
        await Promise.race([waitForEvent(this.client, "Page.loadEventFired", 8_000), delay(120)]);
    }
    async scrollBy(deltaX, deltaY) {
        await this.client.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: Math.round(this.configuration.viewport.width / 2),
            y: Math.round(this.configuration.viewport.height / 2),
            deltaX,
            deltaY,
        });
        await delay(120);
    }
    async getNavigationState() {
        const history = await this.getNavigationHistory();
        const currentEntry = history.entries[history.currentIndex];
        return {
            currentUrl: currentEntry?.url ?? "about:blank",
            title: currentEntry?.title || currentEntry?.url || "Browser Workbench",
            canGoBack: history.currentIndex > 0,
            canGoForward: history.currentIndex < history.entries.length - 1,
        };
    }
    async evaluateJson(expression) {
        const response = await this.client.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
        });
        return response.result?.value;
    }
    async getDocumentHtml() {
        const html = await this.evaluateJson(`(() => { try { return document.documentElement ? document.documentElement.outerHTML : ''; } catch (e) { return ''; } })()`);
        return html ?? "";
    }
    async sendKey(type, key, text) {
        await this.client.send("Input.dispatchKeyEvent", {
            type,
            key,
            text,
            unmodifiedText: text,
        });
    }
    async clearCache() {
        await this.client.send("Network.clearBrowserCache");
    }
    async clearCookies() {
        await this.client.send("Network.clearBrowserCookies");
    }
    /**
     * Clears cache, cookies, and origin storage for the current page. True global
     * “history” is not exposed for a single CDP tab; we clear site data and caches.
     */
    async clearBrowsingHistory(currentUrl) {
        await this.clearCache();
        await this.clearCookies();
        if (currentUrl && /^https?:/i.test(currentUrl)) {
            try {
                const origin = new URL(currentUrl).origin;
                await this.client.send("Storage.clearDataForOrigin", {
                    origin,
                    storageTypes: "all",
                });
            }
            catch {
                // Older Chromium may reject some storageTypes; fall through to Runtime clear.
            }
        }
        try {
            await this.evaluateJson(`(() => {
        try { sessionStorage.clear(); } catch (e) {}
        try { localStorage.clear(); } catch (e) {}
        return true;
      })()`);
        }
        catch {
            // Page may not be ready; cache/cookies/storage origin clear still applied when possible.
        }
    }
    async setZoom(scale) {
        await this.client.send("Emulation.setDeviceMetricsOverride", {
            width: this.configuration.viewport.width,
            height: this.configuration.viewport.height,
            deviceScaleFactor: this.configuration.viewport.deviceScaleFactor * scale,
            mobile: false,
        });
    }
    async updateViewport(width, height) {
        this.configuration.viewport.width = width;
        this.configuration.viewport.height = height;
        await this.client.send("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: this.configuration.viewport.deviceScaleFactor,
            mobile: false,
        });
    }
    async send(method, params) {
        return this.client.send(method, params);
    }
    /**
     * Listen for a CDP push-event (e.g. "Runtime.bindingCalled").
     * Returns an unsubscribe function.
     */
    onCdpEvent(eventName, handler) {
        this.client.on(eventName, handler);
        return () => this.client.off(eventName, handler);
    }
    async close() {
        await this.client.close().catch(() => undefined);
        await this.browser.close();
    }
    async bootstrap() {
        await this.client.send("Page.enable");
        await this.client.send("DOM.enable");
        await this.client.send("CSS.enable");
        await this.client.send("Runtime.enable");
        await this.client.send("Overlay.enable");
        await this.client.send("Network.enable");
        await this.client.send("Storage.enable").catch(() => undefined);
        await this.client.send("Emulation.setDeviceMetricsOverride", {
            width: this.configuration.viewport.width,
            height: this.configuration.viewport.height,
            deviceScaleFactor: this.configuration.viewport.deviceScaleFactor,
            mobile: false,
        });
    }
    async getNavigationHistory() {
        return this.client.send("Page.getNavigationHistory");
    }
    async waitForLoadState(timeoutMs = 4_000) {
        await waitForEvent(this.client, "Page.loadEventFired", timeoutMs);
    }
}
exports.BrowserSession = BrowserSession;
function waitForEvent(emitter, eventName, timeoutMs) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            emitter.off(eventName, handler);
            resolve();
        }, timeoutMs);
        const handler = () => {
            clearTimeout(timeout);
            emitter.off(eventName, handler);
            resolve();
        };
        emitter.on(eventName, handler);
    });
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function clampInt(value, min, max) {
    return Math.min(max, Math.max(min, Math.round(value)));
}
//# sourceMappingURL=browserSession.js.map