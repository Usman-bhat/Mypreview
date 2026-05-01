"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.startBrowserBridgeServer = startBrowserBridgeServer;
const crypto = __importStar(require("node:crypto"));
const http = __importStar(require("node:http"));
const promises_1 = require("node:fs/promises");
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const JSON_CT = { "Content-Type": "application/json; charset=utf-8" };
async function startBrowserBridgeServer(context, api) {
    const configuration = vscode.workspace.getConfiguration("myPreview");
    if (!configuration.get("enableBrowserBridge", true)) {
        return undefined;
    }
    let token = configuration.get("browserBridgeToken", "").trim();
    if (!token) {
        const existing = context.globalState.get("browserBridge.token");
        if (existing) {
            token = existing;
        }
        else {
            token = crypto.randomBytes(24).toString("hex");
            await context.globalState.update("browserBridge.token", token);
        }
    }
    const fixedPort = configuration.get("browserBridgePort", 0);
    const server = http.createServer((req, res) => {
        void handleBridgeRequest(req, res, token, api);
    });
    const port = await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(fixedPort > 0 ? fixedPort : 0, "127.0.0.1", () => {
            const addr = server.address();
            if (typeof addr === "object" && addr?.port) {
                resolve(addr.port);
            }
            else {
                reject(new Error("Browser bridge: could not determine listening port."));
            }
        });
    });
    const base = context.globalStorageUri ?? context.storageUri;
    await (0, promises_1.mkdir)(base.fsPath, { recursive: true });
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
    await (0, promises_1.writeFile)(configPath, JSON.stringify(payload, null, 2), "utf8");
    return {
        port,
        token,
        configPath,
        dispose: () => {
            server.close();
        },
    };
}
async function handleBridgeRequest(req, res, token, api) {
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
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "bridge_error";
        res.writeHead(503, JSON_CT);
        res.end(JSON.stringify({ error: message }));
        return;
    }
    res.writeHead(404, JSON_CT);
    res.end(JSON.stringify({ error: "not_found" }));
}
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(Buffer.from(c)));
        req.on("end", () => {
            try {
                const raw = Buffer.concat(chunks).toString("utf8");
                if (!raw.trim()) {
                    resolve({});
                    return;
                }
                resolve(JSON.parse(raw));
            }
            catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}
//# sourceMappingURL=browserBridgeServer.js.map