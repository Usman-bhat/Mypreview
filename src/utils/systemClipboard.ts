import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { platform } from "node:os";

/**
 * Writes an image file to the OS clipboard so the next paste produces the
 * image itself, not its file path. We use OS-native tools because VS Code's
 * `vscode.env.clipboard` only supports text.
 *
 * - macOS: `osascript` reads the file as a PNG/JPEG and sets the clipboard.
 * - Linux: `xclip` (X11) or `wl-copy` (Wayland) writes the bytes with the
 *   correct mime type.
 * - Windows: PowerShell `Set-Clipboard -Path` or `[Windows.Forms.Clipboard]`.
 *
 * Returns true on success, false if the platform tool is missing or fails.
 */
export async function writeImageToSystemClipboard(filePath: string, mime: string): Promise<boolean> {
  const platformName = platform();

  switch (platformName) {
    case "darwin":
      return writeImageMac(filePath, mime);
    case "linux":
      return writeImageLinux(filePath, mime);
    case "win32":
      return writeImageWindows(filePath);
    default:
      return false;
  }
}

async function writeImageMac(filePath: string, mime: string): Promise<boolean> {
  const imageClass = mime === "image/jpeg" ? "JPEG picture" : "«class PNGf»";
  const escaped = filePath.replace(/"/g, '\\"');
  const script = `set the clipboard to (read (POSIX file "${escaped}") as ${imageClass})`;
  return runCommand("osascript", ["-e", script]);
}

async function writeImageLinux(filePath: string, mime: string): Promise<boolean> {
  if (await runCommand("wl-copy", ["--type", mime], { stdinFile: filePath })) {
    return true;
  }
  return runCommand("xclip", ["-selection", "clipboard", "-t", mime, "-i", filePath]);
}

async function writeImageWindows(filePath: string): Promise<boolean> {
  const escaped = filePath.replace(/'/g, "''");
  const script = `Add-Type -AssemblyName System.Windows.Forms; ` +
    `$img = [System.Drawing.Image]::FromFile('${escaped}'); ` +
    `[System.Windows.Forms.Clipboard]::SetImage($img); ` +
    `$img.Dispose()`;
  return runCommand("powershell.exe", ["-NoProfile", "-Command", script]);
}

function runCommand(command: string, args: string[], options?: { stdinFile?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: options?.stdinFile ? ["pipe", "ignore", "ignore"] : "ignore" });
    } catch {
      resolve(false);
      return;
    }

    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));

    if (options?.stdinFile && child.stdin) {
      createReadStream(options.stdinFile).pipe(child.stdin);
    }
  });
}
