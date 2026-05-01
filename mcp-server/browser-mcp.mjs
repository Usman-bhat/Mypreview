#!/usr/bin/env node
/**
 * MCP stdio server that proxies to the extension's HTTP browser bridge.
 *
 * Prerequisites:
 * 1. Install/run the VS Code extension so the bridge starts (see globalStorage .../browser-bridge.json).
 * 2. Point Cursor MCP at this file, with env BROWSER_BRIDGE_CONFIG set to that JSON path.
 *
 * Example Cursor MCP config:
 * {
 *   "mcpServers": {
 *     "editor-browser": {
 *       "command": "node",
 *       "args": ["/ABS/PATH/TO/extension/mcp-server/browser-mcp.mjs"],
 *       "env": { "BROWSER_BRIDGE_CONFIG": "/ABS/PATH/TO/browser-bridge.json" }
 *     }
 *   }
 * }
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

function loadBridge() {
  const configPath = process.env.BROWSER_BRIDGE_CONFIG;
  if (configPath) {
    const raw = readFileSync(configPath, "utf8");
    const j = JSON.parse(raw);
    const baseUrl = (j.baseUrl ?? "").replace(/\/$/, "");
    const token = j.token ?? "";
    if (!baseUrl || !token) {
      throw new Error("browser-bridge.json must include baseUrl and token.");
    }
    return { baseUrl, token };
  }
  const baseUrl = (process.env.BROWSER_BRIDGE_URL ?? "").replace(/\/$/, "");
  const token = process.env.BROWSER_BRIDGE_TOKEN ?? "";
  if (!baseUrl || !token) {
    throw new Error(
      "Set BROWSER_BRIDGE_CONFIG to the path written by the extension (browser-bridge.json), or set BROWSER_BRIDGE_URL and BROWSER_BRIDGE_TOKEN.",
    );
  }
  return { baseUrl, token };
}

async function bridgeFetch(bridge, pathname, { method = "GET", jsonBody } = {}) {
  const url = `${bridge.baseUrl}${pathname}`;
  const headers = {
    "X-Browser-Bridge-Token": bridge.token,
  };
  if (jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    method,
    headers,
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data.error ?? res.statusText ?? "request_failed";
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

const bridge = loadBridge();

const mcpServer = new McpServer({
  name: "inside-editor-browser-bridge",
  version: "0.2.0",
});

mcpServer.registerTool(
  "browser_navigate",
  {
    description: "Navigate the embedded workbench browser to a URL (extension must have Browser Workbench open).",
    inputSchema: {
      url: z.string().url().describe("Full http(s) URL"),
    },
  },
  async ({ url }) => {
    await bridgeFetch(bridge, "/v1/navigate", { method: "POST", jsonBody: { url } });
    return {
      content: [{ type: "text", text: `Navigated to ${url}` }],
    };
  },
);

mcpServer.registerTool(
  "browser_screenshot",
  {
    description: "Capture a screenshot of the current page as base64 (mime + data).",
    inputSchema: z.object({}),
  },
  async () => {
    const shot = await bridgeFetch(bridge, "/v1/screenshot");
    const summary = JSON.stringify({ mime: shot.mime, base64Length: shot.base64?.length ?? 0 });
    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: `data:${shot.mime};base64,${shot.base64}` },
      ],
    };
  },
);

mcpServer.registerTool(
  "browser_get_dom",
  {
    description: "Get the current page documentElement outerHTML from the embedded browser.",
    inputSchema: z.object({}),
  },
  async () => {
    const { html } = await bridgeFetch(bridge, "/v1/dom");
    const text = typeof html === "string" ? html : "";
    const clipped = text.length > 120_000 ? `${text.slice(0, 120_000)}\n… [truncated]` : text;
    return {
      content: [{ type: "text", text: clipped }],
    };
  },
);

mcpServer.registerTool(
  "browser_click",
  {
    description: "Dispatch a click at viewport coordinates (same space as screenshots).",
    inputSchema: {
      x: z.number().describe("X in device pixels"),
      y: z.number().describe("Y in device pixels"),
    },
  },
  async ({ x, y }) => {
    await bridgeFetch(bridge, "/v1/click", { method: "POST", jsonBody: { x, y } });
    return {
      content: [{ type: "text", text: `Clicked at (${x}, ${y})` }],
    };
  },
);

mcpServer.registerTool(
  "browser_get_url",
  {
    description: "Return the current URL of the embedded browser session.",
    inputSchema: z.object({}),
  },
  async () => {
    const { url } = await bridgeFetch(bridge, "/v1/url");
    return {
      content: [{ type: "text", text: url ?? "" }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
