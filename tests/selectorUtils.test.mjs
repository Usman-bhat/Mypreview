import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { formatSelectorLabel, sanitizeHtmlSnippet } = require("../out/browser/selectorUtils.js");

test("formatSelectorLabel preserves short selectors", () => {
  const selector = "main > section.hero > button.cta";
  assert.equal(formatSelectorLabel(selector, 60), selector);
});

test("formatSelectorLabel shortens long selectors deterministically", () => {
  const selector =
    "html > body > div.app-shell > main.page-root > section.content-area > div.card-grid > article.card:nth-of-type(4) > button.primary-action";
  const formatted = formatSelectorLabel(selector, 64);

  assert.equal(formatted.length, 64);
  assert.match(formatted, /^html > body/);
  assert.match(formatted, /primary-action$/);
});

test("sanitizeHtmlSnippet strips scripts and inline handlers", () => {
  const html = '<div onclick="alert(1)"><script>alert(1)</script><button>Save</button></div>';
  const sanitized = sanitizeHtmlSnippet(html, 120);

  assert.equal(sanitized.includes("<script"), false);
  assert.equal(sanitized.includes("onclick"), false);
  assert.match(sanitized, /<button>Save<\/button>/);
});
