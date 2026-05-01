import { PreviewSecuritySettings } from "../browser/types";

export interface ValidatedPreviewUrl {
  url: URL;
  warnings: string[];
}

export function normalizeUrl(rawValue: string): URL {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    throw new Error("A URL is required.");
  }

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  const url = new URL(candidate);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http:// and https:// URLs are supported.");
  }

  return url;
}

export function looksLikeUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    normalizeUrl(value);
    return true;
  } catch {
    return false;
  }
}

export function hostnameLabel(rawValue: string): string {
  try {
    return normalizeUrl(rawValue).hostname || "local";
  } catch {
    return "invalid-url";
  }
}

export function validatePreviewUrl(rawValue: string, securitySettings: PreviewSecuritySettings): ValidatedPreviewUrl {
  const url = normalizeUrl(rawValue);
  const warnings: string[] = [];
  const hostname = url.hostname.toLowerCase();

  if (url.protocol === "file:") {
    throw new Error("file:// URLs are blocked for security reasons.");
  }

  if (securitySettings.allowedHosts.length > 0 && !securitySettings.allowedHosts.includes(hostname)) {
    throw new Error(`Navigation to ${hostname} is not allowed by myPreview.allowedHosts.`);
  }

  if (isLocalhost(hostname)) {
    if (!securitySettings.allowLocalhost) {
      throw new Error("Localhost URLs are disabled. Enable myPreview.allowLocalhost to use local servers.");
    }

    warnings.push("You are browsing a localhost target. Keep SSRF risk in mind when sharing captured context.");
    return { url, warnings };
  }

  if (isPrivateHost(hostname)) {
    if (!securitySettings.allowPrivateHosts) {
      throw new Error(
        "Private-network hosts are blocked by default. Enable myPreview.allowPrivateHosts if you trust this target.",
      );
    }

    warnings.push("This host appears to be on a private network. Verify the target before sharing AI context.");
  }

  return { url, warnings };
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isPrivateHost(hostname: string): boolean {
  if (hostname.endsWith(".local")) {
    return true;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const parts = hostname.split(".").map((part) => Number(part));
    const [a, b] = parts;

    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  return hostname.startsWith("fc") || hostname.startsWith("fd");
}
