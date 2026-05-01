"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pickCuratedStyles = pickCuratedStyles;
exports.buildInspectorData = buildInspectorData;
exports.buildElementReference = buildElementReference;
exports.hashComputedStyles = hashComputedStyles;
const node_crypto_1 = require("node:crypto");
const selectorUtils_1 = require("./selectorUtils");
const CURATED_STYLE_NAMES = [
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "display",
    "position",
];
function pickCuratedStyles(styles) {
    const curated = {};
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
function buildInspectorData(raw, maxOuterHtmlLength) {
    const outerHtml = (0, selectorUtils_1.sanitizeHtmlSnippet)(raw.outerHtml, maxOuterHtmlLength);
    const computedStyles = pickCuratedStyles(raw.computedStyles);
    return {
        nodeId: raw.nodeId,
        backendNodeId: raw.backendNodeId,
        url: raw.url,
        tagName: raw.tagName,
        selector: raw.selector,
        outerHtml,
        textSnippet: (0, selectorUtils_1.truncateText)(raw.textSnippet, 240),
        box: raw.box,
        computedStyles,
        computedStylesHash: hashComputedStyles(computedStyles),
        attributes: raw.attributes,
    };
}
function buildElementReference(inspector) {
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
function hashComputedStyles(styles) {
    const stablePayload = JSON.stringify({
        backgroundColor: styles.backgroundColor ?? "",
        color: styles.color ?? "",
        display: styles.display ?? "",
        fontFamily: styles.fontFamily ?? "",
        fontSize: styles.fontSize ?? "",
        fontWeight: styles.fontWeight ?? "",
        position: styles.position ?? "",
    });
    return (0, node_crypto_1.createHash)("sha256").update(stablePayload).digest("hex").slice(0, 12);
}
//# sourceMappingURL=inspectorModel.js.map