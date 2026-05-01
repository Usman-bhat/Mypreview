import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeUrl, validatePreviewUrl } = require("../out/utils/url.js");

test("normalizeUrl adds http scheme when missing", () => {
  const normalized = normalizeUrl("example.com/path");
  assert.equal(normalized.toString(), "http://example.com/path");
});

test("validatePreviewUrl allows localhost when enabled", () => {
  const result = validatePreviewUrl("http://localhost:3000", {
    allowLocalhost: true,
    allowPrivateHosts: false,
    allowedHosts: [],
  });

  assert.equal(result.url.toString(), "http://localhost:3000/");
  assert.equal(result.warnings.length, 1);
});

test("validatePreviewUrl blocks localhost when disabled", () => {
  assert.throws(() =>
    validatePreviewUrl("http://127.0.0.1:3000", {
      allowLocalhost: false,
      allowPrivateHosts: false,
      allowedHosts: [],
    }),
  );
});

test("validatePreviewUrl blocks private hosts by default", () => {
  assert.throws(() =>
    validatePreviewUrl("http://192.168.1.25", {
      allowLocalhost: true,
      allowPrivateHosts: false,
      allowedHosts: [],
    }),
  );
});

test("validatePreviewUrl enforces allowed hostnames", () => {
  assert.throws(() =>
    validatePreviewUrl("https://example.org", {
      allowLocalhost: true,
      allowPrivateHosts: true,
      allowedHosts: ["example.com"],
    }),
  );
});
