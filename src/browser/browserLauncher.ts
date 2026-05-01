import { access, constants, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { BrowserLaunchConfiguration } from "./types";

export interface LaunchedBrowser {
  executablePath: string;
  pageWebSocketUrl: string;
  userDataDir: string;
  close(): Promise<void>;
}

interface DevtoolsVersionResponse {
  Browser: string;
  webSocketDebuggerUrl: string;
}

interface DevtoolsListEntry {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export class BrowserLauncher {
  public static async launch(configuration: BrowserLaunchConfiguration): Promise<LaunchedBrowser> {
    const executablePath = await resolveBrowserExecutable(configuration.executablePath);
    const persist = Boolean(configuration.persistUserDataDir && configuration.userDataDir);
    
    // Try launching with retry logic for singleton lock conflicts
    const maxRetries = 3;
    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.launchWithProfile(executablePath, configuration, persist);
      } catch (error) {
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
  
  private static async launchWithProfile(
    executablePath: string, 
    configuration: BrowserLaunchConfiguration, 
    persist: boolean
  ): Promise<LaunchedBrowser> {
    // Generate a unique profile directory to avoid singleton lock conflicts
    let userDataDir: string;
    if (configuration.userDataDir && configuration.persistUserDataDir) {
      userDataDir = configuration.userDataDir;
      await cleanupProfileDirectory(userDataDir);
    } else {
      const baseDir = path.join(os.tmpdir(), "vscode-browser-workbench-");
      userDataDir = await mkdtemp(baseDir + randomUUID() + "-");
    }
    
    const viewport = configuration.viewport;

    // Remove stale DevToolsActivePort and SingletonLock from a previous session
    const stalePortFile = path.join(userDataDir, "DevToolsActivePort");
    const singletonLockFile = path.join(userDataDir, "SingletonLock");
    await Promise.all([
      unlink(stalePortFile).catch(() => undefined),
      unlink(singletonLockFile).catch(() => undefined)
    ]);

    const processHandle = spawn(
      executablePath,
      [
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
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let stderrChunks = "";
    processHandle.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks += chunk.toString();
    });

    processHandle.on("exit", (code) => {
      if (code && code !== 0) {
        console.error(`[browser-launcher] Chrome exited with code ${code}. stderr:\n${stderrChunks}`);
      }
    });

    const cleanup = async (): Promise<void> => {
      if (!processHandle.killed) {
        processHandle.kill();
      }

      if (!persist) {
        await rm(userDataDir, { force: true, recursive: true });
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
    } catch (error) {
      await cleanup();
      const baseMsg = error instanceof Error ? error.message : String(error);
      const hint = stderrChunks.trim()
        ? `${baseMsg}\n\nChrome stderr:\n${stderrChunks.slice(0, 500)}`
        : `${baseMsg}\n\nChrome path: ${executablePath}\nProfile: ${userDataDir}`;
      throw new Error(hint);
    }
  }
}

async function resolveBrowserExecutable(configuredPath: string | undefined): Promise<string> {
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
      if (existsSync(candidate)) {
        await ensureExecutable(candidate);
        return candidate;
      }

      continue;
    }

    const result = spawnSync("which", [candidate], { encoding: "utf8" });
    if (result.status === 0) {
      const resolvedPath = result.stdout.trim();
      await ensureExecutable(resolvedPath);
      return resolvedPath;
    }
  }

  throw new Error(
    "Could not find Chrome, Chromium, or Edge. Set myPreview.browserExecutablePath to your browser executable.",
  );
}

function candidateExecutablePaths(): string[] {
  const candidates = new Set<string>();

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

async function ensureExecutable(targetPath: string): Promise<void> {
  await access(targetPath, constants.X_OK);
}

async function waitForDevToolsPort(userDataDir: string): Promise<{ port: number }> {
  const devtoolsFile = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const contents = await readFile(devtoolsFile, "utf8");
      const [portLine] = contents.split(/\r?\n/);
      const port = Number(portLine);

      if (Number.isFinite(port) && port > 0) {
        return { port };
      }
    } catch {
      // keep polling
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for the browser to expose a DevTools debugging port.");
}

async function waitForEndpointReady(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });

      if (response.ok) {
        const payload = (await response.json()) as DevtoolsVersionResponse;
        if (payload.webSocketDebuggerUrl) {
          return;
        }
      }
    } catch {
      // keep polling
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for the browser DevTools endpoint to become ready.");
}

async function waitForPageWebSocketUrl(port: number): Promise<string> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });

      if (response.ok) {
        const targets = (await response.json()) as DevtoolsListEntry[];
        const pageTarget = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);

        if (pageTarget?.webSocketDebuggerUrl) {
          return pageTarget.webSocketDebuggerUrl;
        }
      }
    } catch {
      // keep polling
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for a debuggable page target.");
}

async function cleanupProfileDirectory(userDataDir: string): Promise<void> {
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
    
    await Promise.all(
      filesToClean.map(file => 
        unlink(path.join(userDataDir, file)).catch(() => undefined)
      )
    );
  } catch (error) {
    // If cleanup fails, we'll try to continue with a unique directory
    console.warn("Failed to cleanup profile directory:", error);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
