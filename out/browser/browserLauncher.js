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
exports.BrowserLauncher = void 0;
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_child_process_1 = require("node:child_process");
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
class BrowserLauncher {
    static async launch(configuration) {
        const executablePath = await resolveBrowserExecutable(configuration.executablePath);
        const persist = Boolean(configuration.persistUserDataDir && configuration.userDataDir);
        // Try launching with retry logic for singleton lock conflicts
        const maxRetries = 3;
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this.launchWithProfile(executablePath, configuration, persist);
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                // If it's a singleton lock error and we have retries left, try again
                if (lastError.message.includes("SingletonLock") && attempt < maxRetries) {
                    console.warn(`[browser-launcher] Singleton lock conflict (attempt ${attempt}/${maxRetries}), retrying...`);
                    await delay(500 * attempt); // Exponential backoff
                    continue;
                }
                // For other errors or if we've exhausted retries, throw the last error
                break;
            }
        }
        throw lastError || new Error("Failed to launch browser after multiple attempts");
    }
    static async launchWithProfile(executablePath, configuration, persist) {
        // Generate a unique profile directory to avoid singleton lock conflicts
        let userDataDir;
        if (configuration.userDataDir && configuration.persistUserDataDir) {
            userDataDir = configuration.userDataDir;
            await cleanupProfileDirectory(userDataDir);
        }
        else {
            const baseDir = path.join(os.tmpdir(), "vscode-browser-workbench-");
            userDataDir = await (0, promises_1.mkdtemp)(baseDir + (0, node_crypto_1.randomUUID)() + "-");
        }
        const viewport = configuration.viewport;
        // Remove stale DevToolsActivePort and SingletonLock from a previous session
        const stalePortFile = path.join(userDataDir, "DevToolsActivePort");
        const singletonLockFile = path.join(userDataDir, "SingletonLock");
        await Promise.all([
            (0, promises_1.unlink)(stalePortFile).catch(() => undefined),
            (0, promises_1.unlink)(singletonLockFile).catch(() => undefined)
        ]);
        const processHandle = (0, node_child_process_1.spawn)(executablePath, [
            "--headless=new",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--disable-background-networking",
            "--disable-default-apps",
            "--disable-features=Translate,BackForwardCache",
            "--disable-sync",
            "--hide-scrollbars",
            "--mute-audio",
            "--no-default-browser-check",
            "--no-first-run",
            "--remote-debugging-port=0",
            `--user-data-dir=${userDataDir}`,
            `--window-size=${viewport.width},${viewport.height}`,
            "about:blank",
        ], {
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderrChunks = "";
        processHandle.stderr?.on("data", (chunk) => {
            stderrChunks += chunk.toString();
        });
        processHandle.on("exit", (code) => {
            if (code && code !== 0) {
                console.error(`[browser-launcher] Chrome exited with code ${code}. stderr:\n${stderrChunks}`);
            }
        });
        const cleanup = async () => {
            if (!processHandle.killed) {
                processHandle.kill();
            }
            if (!persist) {
                await (0, promises_1.rm)(userDataDir, { force: true, recursive: true });
            }
        };
        try {
            const { port } = await waitForDevToolsPort(userDataDir);
            await waitForEndpointReady(port);
            const pageWebSocketUrl = await waitForPageWebSocketUrl(port);
            return {
                executablePath,
                pageWebSocketUrl,
                userDataDir,
                close: cleanup,
            };
        }
        catch (error) {
            await cleanup();
            const baseMsg = error instanceof Error ? error.message : String(error);
            const hint = stderrChunks.trim()
                ? `${baseMsg}\n\nChrome stderr:\n${stderrChunks.slice(0, 500)}`
                : `${baseMsg}\n\nChrome path: ${executablePath}\nProfile: ${userDataDir}`;
            throw new Error(hint);
        }
    }
}
exports.BrowserLauncher = BrowserLauncher;
async function resolveBrowserExecutable(configuredPath) {
    if (configuredPath?.trim()) {
        const explicitPath = configuredPath.trim();
        await ensureExecutable(explicitPath);
        return explicitPath;
    }
    for (const candidate of candidateExecutablePaths()) {
        if (!candidate) {
            continue;
        }
        if (candidate.includes(path.sep) || path.isAbsolute(candidate)) {
            if ((0, node_fs_1.existsSync)(candidate)) {
                await ensureExecutable(candidate);
                return candidate;
            }
            continue;
        }
        const result = (0, node_child_process_1.spawnSync)("which", [candidate], { encoding: "utf8" });
        if (result.status === 0) {
            const resolvedPath = result.stdout.trim();
            await ensureExecutable(resolvedPath);
            return resolvedPath;
        }
    }
    throw new Error("Could not find Chrome, Chromium, or Edge. Set myPreview.browserExecutablePath to your browser executable.");
}
function candidateExecutablePaths() {
    const candidates = new Set();
    switch (process.platform) {
        case "darwin":
            candidates.add("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
            candidates.add("/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary");
            candidates.add("/Applications/Chromium.app/Contents/MacOS/Chromium");
            candidates.add("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
            break;
        case "win32":
            candidates.add(path.join(process.env["PROGRAMFILES"] ?? "", "Google/Chrome/Application/chrome.exe"));
            candidates.add(path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"));
            candidates.add(path.join(process.env["LOCALAPPDATA"] ?? "", "Google/Chrome/Application/chrome.exe"));
            candidates.add(path.join(process.env["PROGRAMFILES"] ?? "", "Microsoft/Edge/Application/msedge.exe"));
            candidates.add(path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft/Edge/Application/msedge.exe"));
            break;
        default:
            candidates.add("google-chrome");
            candidates.add("google-chrome-stable");
            candidates.add("chromium");
            candidates.add("chromium-browser");
            candidates.add("microsoft-edge");
            break;
    }
    return [...candidates];
}
async function ensureExecutable(targetPath) {
    await (0, promises_1.access)(targetPath, promises_1.constants.X_OK);
}
async function waitForDevToolsPort(userDataDir) {
    const devtoolsFile = path.join(userDataDir, "DevToolsActivePort");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            const contents = await (0, promises_1.readFile)(devtoolsFile, "utf8");
            const [portLine] = contents.split(/\r?\n/);
            const port = Number(portLine);
            if (Number.isFinite(port) && port > 0) {
                return { port };
            }
        }
        catch {
            // keep polling
        }
        await delay(100);
    }
    throw new Error("Timed out waiting for the browser to expose a DevTools debugging port.");
}
async function waitForEndpointReady(port) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
                signal: AbortSignal.timeout(1_000),
            });
            if (response.ok) {
                const payload = (await response.json());
                if (payload.webSocketDebuggerUrl) {
                    return;
                }
            }
        }
        catch {
            // keep polling
        }
        await delay(100);
    }
    throw new Error("Timed out waiting for the browser DevTools endpoint to become ready.");
}
async function waitForPageWebSocketUrl(port) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
                signal: AbortSignal.timeout(1_000),
            });
            if (response.ok) {
                const targets = (await response.json());
                const pageTarget = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
                if (pageTarget?.webSocketDebuggerUrl) {
                    return pageTarget.webSocketDebuggerUrl;
                }
            }
        }
        catch {
            // keep polling
        }
        await delay(100);
    }
    throw new Error("Timed out waiting for a debuggable page target.");
}
async function cleanupProfileDirectory(userDataDir) {
    try {
        // Clean up Chrome singleton lock and other stale files
        const filesToClean = [
            "SingletonLock",
            "SingletonCookie",
            "SingletonSocket",
            "DevToolsActivePort",
            "ChromeSetup",
            "lockfile"
        ];
        await Promise.all(filesToClean.map(file => (0, promises_1.unlink)(path.join(userDataDir, file)).catch(() => undefined)));
    }
    catch (error) {
        // If cleanup fails, we'll try to continue with a unique directory
        console.warn("Failed to cleanup profile directory:", error);
    }
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
//# sourceMappingURL=browserLauncher.js.map