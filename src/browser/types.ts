export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface CuratedComputedStyles {
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  display?: string;
  position?: string;
}

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface BrowserScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: string;
}

export interface ElementInspectorData {
  nodeId: number;
  backendNodeId?: number;
  url: string;
  tagName: string;
  selector: string;
  outerHtml: string;
  textSnippet: string;
  box: ElementBox;
  computedStyles: CuratedComputedStyles;
  computedStylesHash: string;
  attributes: Record<string, string>;
}

export interface ElementReference {
  id: string;
  url: string;
  tagName: string;
  selector: string;
  outerHtml: string;
  textSnippet: string;
  computedStyles: CuratedComputedStyles;
  computedStylesHash: string;
  box: ElementBox;
  pinnedAt: string;
}

export interface BrowserNavigationState {
  currentUrl: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserWorkbenchState {
  url: string;
  title: string;
  loading: boolean;
  browserReady: boolean;
  pinned: boolean;
  pickMode: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  screenshot?: BrowserScreenshot;
  hoveredElement?: ElementInspectorData;
  pinnedElements: ElementReference[];
  warning?: string;
  error?: string;
  statusLine?: string;
}

export interface PreviewSecuritySettings {
  allowLocalhost: boolean;
  allowPrivateHosts: boolean;
  allowedHosts: string[];
}

export type BrowserScreenshotFormat = "jpeg" | "png";

export interface BrowserLaunchConfiguration {
  executablePath?: string;
  viewport: BrowserViewport;
  /** CDP capture format. JPEG is much smaller and faster over the webview bridge. */
  screenshotFormat?: BrowserScreenshotFormat;
  /** 0–100 when format is jpeg. Ignored for png. */
  jpegQuality?: number;
  /** When set, Chromium uses this user-data directory (workspace persistence). */
  userDataDir?: string;
  /** When true, closing the browser does not delete `userDataDir` from disk. */
  persistUserDataDir?: boolean;
}
