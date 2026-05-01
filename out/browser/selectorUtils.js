"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatSelectorLabel = formatSelectorLabel;
exports.truncateText = truncateText;
exports.sanitizeHtmlSnippet = sanitizeHtmlSnippet;
function formatSelectorLabel(selector, maxLength = 120) {
    const compact = selector.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength) {
        return compact;
    }
    const headLength = Math.max(24, Math.floor(maxLength * 0.55));
    const tailLength = Math.max(16, maxLength - headLength - 3);
    return `${compact.slice(0, headLength)}...${compact.slice(-tailLength)}`;
}
function truncateText(value, maxLength) {
    const compact = value.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength) {
        return compact;
    }
    return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}
function sanitizeHtmlSnippet(rawHtml, maxLength) {
    const strippedScripts = rawHtml
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/\son[a-z-]+="[^"]*"/gi, "")
        .replace(/\son[a-z-]+='[^']*'/gi, "")
        .replace(/\sjavascript:/gi, " ");
    return truncateText(strippedScripts, maxLength);
}
//# sourceMappingURL=selectorUtils.js.map