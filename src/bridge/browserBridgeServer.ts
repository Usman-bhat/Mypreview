import * as crypto from "node:crypto";
import * as http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

const JSON_CT = { "Content-Type": "application/json; charset=utf-8" };

export interface BrowserWorkbenchBridgeApi {
  bridgeNavigate(url: string): Promise<void>;
  bridgeScreenshot(): Promise<{ mime: string; base64: string }>;
  bridgeGetDom(): Promise<string>;
  bridgeClick(x: number, y: number): Promise<void>;
  bridgeGetCurrentUrl(): Promise<string | undefined>;
}

export interface BrowserBridgeServer extends vscode.Disposable {
  readonly port: number;
  readonly token: string;
  readonly configPath: string;
}

export async function startBrowserBridgeServer(
  context: vscode.ExtensionContext,
  api: BrowserWorkbenchBridgeApi,
): Promise<BrowserBridgeServer | undefined> {
  const configuration = vscode.workspace.getConfiguration("myPreview");
  if (!configuration.get<boolean>("enableBrowserBridge", true)) {
    return undefined;
  }

  let token = configuration.get<string>("browserBridgeToken", "").trim();
  if (!token) {
    const existing = context.globalState.get<string>("browserBridge.token");
    if (existing) {
      token = existing;
    } else {
      token = crypto.randomBytes(24).toString("hex");
      await context.globalState.update("browserBridge.token", token);
    }
  }

  const fixedPort = configuration.get<number>("browserBridgePort", 0);
  const server = http.createServer((req, res) => {
    void handleBridgeRequest(req, res, token, api);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(fixedPort > 0 ? fixedPort : 0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr?.port) {
        resolve(addr.port);
      } else {
        reject(new Error("Browser bridge: could not determine listening port."));
      }
    });
  });

  const base = context.globalStorageUri ?? context.storageUri;
  await mkdir(base.fsPath, { recursive: true });
  const configPath = path.join(base.fsPath, "browser-bridge.json");
  const payload = {
    port,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    createdAt: new Date().toISOString(),
    mcpEnv: {
      BROWSER_BRIDGE_URL: `http://127.0.0.1:${port}`,
      BROWSER_BRIDGE_TOKEN: token,
    },
  };
  await writeFile(configPath, JSON.stringify(payload, null, 2), "utf8");

  return {
    port,
    token,
    configPath,
    dispose: () => {
      server.close();
    },
  };
}

async function handleBridgeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  api: BrowserWorkbenchBridgeApi,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const auth = req.headers["x-browser-bridge-token"] ?? url.searchParams.get("token");
  if (auth !== token) {
    res.writeHead(401, JSON_CT);
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, JSON_CT);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/v1/url") {
      const current = await api.bridgeGetCurrentUrl();
      res.writeHead(200, JSON_CT);
      res.end(JSON.stringify({ url: current ?? null }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/screenshot") {
      const shot = await api.bridgeScreenshot();
      res.writeHead(200, JSON_CT);
      res.end(JSON.stringify(shot));
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/dom") {
      const html = await api.bridgeGetDom();
      res.writeHead(200, JSON_CT);
      res.end(JSON.stringify({ html }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/navigate") {
      const body = await readJsonBody(req);
      const rawUrl = typeof body.url === "string" ? body.url : "";
      await api.bridgeNavigate(rawUrl);
      res.writeHead(200, JSON_CT);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/click") {
      const body = await readJsonBody(req);
      const x = Number(body.x);
      const y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        res.writeHead(400, JSON_CT);
        res.end(JSON.stringify({ error: "expected numeric x, y" }));
        return;
      }
      await api.bridgeClick(x, y);
      res.writeHead(200, JSON_CT);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "bridge_error";
    res.writeHead(503, JSON_CT);
    res.end(JSON.stringify({ error: message }));
    return;
  }

  res.writeHead(404, JSON_CT);
  res.end(JSON.stringify({ error: "not_found" }));
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
