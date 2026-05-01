import { EventEmitter } from "node:events";

import { BrowserLauncher, LaunchedBrowser } from "./browserLauncher";
import { CdpClient } from "./cdpClient";
import { BrowserLaunchConfiguration, BrowserNavigationState, BrowserScreenshot } from "./types";

interface NavigationHistoryEntry {
  id: number;
  title: string;
  url: string;
  userTypedURL: string;
}

interface NavigationHistoryResponse {
  currentIndex: number;
  entries: NavigationHistoryEntry[];
}

interface CaptureScreenshotResponse {
  data: string;
}

interface NavigateResponse {
  errorText?: string;
}

interface EvaluateResponse {
  result?: {
    type?: string;
    value?: unknown;
  };
}

export class BrowserSession extends EventEmitter {
  private constructor(
    private readonly browser: LaunchedBrowser,
    private readonly client: CdpClient,
    private readonly configuration: BrowserLaunchConfiguration,
  ) {
    super();
  }

  public static async create(configuration: BrowserLaunchConfiguration): Promise<BrowserSession> {
    const browser = await BrowserLauncher.launch(configuration);

    const client = new CdpClient(browser.pageWebSocketUrl);
    await client.connect();

    const session = new BrowserSession(browser, client, configuration);
    await session.bootstrap();

    return session;
  }

  public async navigate(url: string): Promise<void> {
    const response = await this.client.send<NavigateResponse>("Page.navigate", { url });
    if (response?.errorText) {
      throw new Error(response.errorText);
    }
    await this.waitForLoadState();
  }

  public async reload(ignoreCache = false): Promise<void> {
    await this.client.send("Page.reload", { ignoreCache });
    await this.waitForLoadState();
  }

  public async goBack(): Promise<void> {
    const history = await this.getNavigationHistory();
    if (history.currentIndex > 0) {
      await this.client.send("Page.navigateToHistoryEntry", {
        entryId: history.entries[history.currentIndex - 1]?.id,
      });
      await this.waitForLoadState();
    }
  }

  public async goForward(): Promise<void> {
    const history = await this.getNavigationHistory();
    if (history.currentIndex < history.entries.length - 1) {
      await this.client.send("Page.navigateToHistoryEntry", {
        entryId: history.entries[history.currentIndex + 1]?.id,
      });
      await this.waitForLoadState();
    }
  }

  public async captureScreenshot(): Promise<BrowserScreenshot> {
    const format = this.configuration.screenshotFormat ?? "jpeg";
    const params: Record<string, unknown> = {
      captureBeyondViewport: false,
      format,
    };

    if (format === "jpeg") {
      const quality = clampInt(this.configuration.jpegQuality ?? 82, 40, 100);
      params.quality = quality;
    }

    await this.client.send("Page.bringToFront").catch(() => undefined);
    const response = await this.client.send<CaptureScreenshotResponse>("Page.captureScreenshot", params);

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

  public async clickPoint(x: number, y: number): Promise<void> {
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

  public async scrollBy(deltaX: number, deltaY: number): Promise<void> {
    await this.client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round(this.configuration.viewport.width / 2),
      y: Math.round(this.configuration.viewport.height / 2),
      deltaX,
      deltaY,
    });
    await delay(120);
  }

  public async getNavigationState(): Promise<BrowserNavigationState> {
    const history = await this.getNavigationHistory();
    const currentEntry = history.entries[history.currentIndex];

    return {
      currentUrl: currentEntry?.url ?? "about:blank",
      title: currentEntry?.title || currentEntry?.url || "Browser Workbench",
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex < history.entries.length - 1,
    };
  }

  public async evaluateJson<T>(expression: string): Promise<T | undefined> {
    const response = await this.client.send<EvaluateResponse>("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });

    return response.result?.value as T | undefined;
  }

  public async getDocumentHtml(): Promise<string> {
    const html = await this.evaluateJson<string>(
      `(() => { try { return document.documentElement ? document.documentElement.outerHTML : ''; } catch (e) { return ''; } })()`,
    );
    return html ?? "";
  }

  public async sendKey(type: "keyDown" | "keyUp" | "char", key: string, text?: string): Promise<void> {
    await this.client.send("Input.dispatchKeyEvent", {
      type,
      key,
      text,
      unmodifiedText: text,
    });
  }

  public async clearCache(): Promise<void> {
    await this.client.send("Network.clearBrowserCache");
  }

  public async clearCookies(): Promise<void> {
    await this.client.send("Network.clearBrowserCookies");
  }

  /**
   * Clears cache, cookies, and origin storage for the current page. True global
   * “history” is not exposed for a single CDP tab; we clear site data and caches.
   */
  public async clearBrowsingHistory(currentUrl: string): Promise<void> {
    await this.clearCache();
    await this.clearCookies();

    if (currentUrl && /^https?:/i.test(currentUrl)) {
      try {
        const origin = new URL(currentUrl).origin;
        await this.client.send("Storage.clearDataForOrigin", {
          origin,
          storageTypes: "all",
        });
      } catch {
        // Older Chromium may reject some storageTypes; fall through to Runtime clear.
      }
    }

    try {
      await this.evaluateJson(`(() => {
        try { sessionStorage.clear(); } catch (e) {}
        try { localStorage.clear(); } catch (e) {}
        return true;
      })()`);
    } catch {
      // Page may not be ready; cache/cookies/storage origin clear still applied when possible.
    }
  }

  public async setZoom(scale: number): Promise<void> {
    await this.client.send("Emulation.setDeviceMetricsOverride", {
      width: this.configuration.viewport.width,
      height: this.configuration.viewport.height,
      deviceScaleFactor: this.configuration.viewport.deviceScaleFactor * scale,
      mobile: false,
    });
  }

  public async updateViewport(width: number, height: number): Promise<void> {
    this.configuration.viewport.width = width;
    this.configuration.viewport.height = height;
    await this.client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: this.configuration.viewport.deviceScaleFactor,
      mobile: false,
    });
  }

  public async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.client.send<T>(method, params);
  }

  /**
   * Listen for a CDP push-event (e.g. "Runtime.bindingCalled").
   * Returns an unsubscribe function.
   */
  public onCdpEvent(eventName: string, handler: (params: unknown) => void): () => void {
    this.client.on(eventName, handler);
    return () => this.client.off(eventName, handler);
  }

  public async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    await this.browser.close();
  }

  private async bootstrap(): Promise<void> {
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

  private async getNavigationHistory(): Promise<NavigationHistoryResponse> {
    return this.client.send<NavigationHistoryResponse>("Page.getNavigationHistory");
  }

  private async waitForLoadState(timeoutMs = 4_000): Promise<void> {
    await waitForEvent(this.client, "Page.loadEventFired", timeoutMs);
  }
}

function waitForEvent(emitter: EventEmitter, eventName: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      emitter.off(eventName, handler);
      resolve();
    }, timeoutMs);

    const handler = (): void => {
      clearTimeout(timeout);
      emitter.off(eventName, handler);
      resolve();
    };

    emitter.on(eventName, handler);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
