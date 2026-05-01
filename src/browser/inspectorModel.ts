import { createHash } from "node:crypto";

import { CuratedComputedStyles, ElementBox, ElementInspectorData, ElementReference } from "./types";
import { sanitizeHtmlSnippet, truncateText } from "./selectorUtils";

const CURATED_STYLE_NAMES = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "display",
  "position",
] as const;

type CuratedStyleName = (typeof CURATED_STYLE_NAMES)[number];

interface RawInspectorPayload {
  nodeId: number;
  backendNodeId?: number;
  url: string;
  tagName: string;
  selector: string;
  outerHtml: string;
  textSnippet: string;
  attributes: Record<string, string>;
  computedStyles: Record<string, string>;
  box: ElementBox;
}

export function pickCuratedStyles(styles: Record<string, string>): CuratedComputedStyles {
  const curated: Partial<Record<CuratedStyleName, string>> = {};

  for (const styleName of CURATED_STYLE_NAMES) {
    if (styles[styleName]) {
      curated[styleName] = styles[styleName];
    }
  }

  return {
    color: curated["color"],
    backgroundColor: curated["background-color"],
    fontFamily: curated["font-family"],
    fontSize: curated["font-size"],
    fontWeight: curated["font-weight"],
    display: curated["display"],
    position: curated["position"],
  };
}

export function buildInspectorData(raw: RawInspectorPayload, maxOuterHtmlLength: number): ElementInspectorData {
  const outerHtml = sanitizeHtmlSnippet(raw.outerHtml, maxOuterHtmlLength);
  const computedStyles = pickCuratedStyles(raw.computedStyles);

  return {
    nodeId: raw.nodeId,
    backendNodeId: raw.backendNodeId,
    url: raw.url,
    tagName: raw.tagName,
    selector: raw.selector,
    outerHtml,
    textSnippet: truncateText(raw.textSnippet, 240),
    box: raw.box,
    computedStyles,
    computedStylesHash: hashComputedStyles(computedStyles),
    attributes: raw.attributes,
  };
}

export function buildElementReference(inspector: ElementInspectorData): ElementReference {
  return {
    id: `${inspector.selector}|${inspector.computedStylesHash}|${Math.round(inspector.box.x)}:${Math.round(inspector.box.y)}`,
    url: inspector.url,
    tagName: inspector.tagName,
    selector: inspector.selector,
    outerHtml: inspector.outerHtml,
    textSnippet: inspector.textSnippet,
    computedStyles: inspector.computedStyles,
    computedStylesHash: inspector.computedStylesHash,
    box: inspector.box,
    pinnedAt: new Date().toISOString(),
  };
}

export function hashComputedStyles(styles: CuratedComputedStyles): string {
  const stablePayload = JSON.stringify({
    backgroundColor: styles.backgroundColor ?? "",
    color: styles.color ?? "",
    display: styles.display ?? "",
    fontFamily: styles.fontFamily ?? "",
    fontSize: styles.fontSize ?? "",
    fontWeight: styles.fontWeight ?? "",
    position: styles.position ?? "",
  });

  return createHash("sha256").update(stablePayload).digest("hex").slice(0, 12);
}
