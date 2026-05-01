import { mkdir, unlink, rm } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

/**
 * Stable per-workspace (or global) directory for Chromium user-data so cookies,
 * localStorage, and IndexedDB survive across extension restarts.
 *
 * Also removes stale lock files left by a previously crashed Chromium process —
 * without this, Chromium refuses to start with the same user-data-dir.
 */
export async function ensureBrowserProfileDirectory(context: vscode.ExtensionContext): Promise<string> {
  const base = context.storageUri ?? context.globalStorageUri;
  const dir = path.join(base.fsPath, "chromium-profile");
  
  // If directory exists and has lock files, create a unique subdirectory
  try {
    await mkdir(dir, { recursive: true });
    
    // Check for existing singleton lock and handle it
    const lockFile = path.join(dir, "SingletonLock");
    try {
      await unlink(lockFile);
    } catch (error) {
      // If unlink fails, the lock might be held by an active process
      // Create a unique profile directory instead
      const uniqueDir = path.join(dir, `profile-${randomUUID()}`);
      await mkdir(uniqueDir, { recursive: true });
      return uniqueDir;
    }
    
    // Clean up other stale lock files
    const staleLockFiles = ["SingletonSocket", "SingletonCookie", "DevToolsActivePort"];
    for (const name of staleLockFiles) {
      await unlink(path.join(dir, name)).catch(() => undefined);
    }
  } catch (error) {
    // If directory creation fails, try creating a unique one
    const uniqueDir = path.join(dir, `profile-${randomUUID()}`);
    await mkdir(uniqueDir, { recursive: true });
    return uniqueDir;
  }

  return dir;
}

/**
 * Force cleanup of all Chrome profile directories and lock files
 */
export async function forceCleanupBrowserProfiles(context: vscode.ExtensionContext): Promise<void> {
  const base = context.storageUri ?? context.globalStorageUri;
  const profileDir = path.join(base.fsPath, "chromium-profile");
  
  try {
    // Remove all Chrome lock files and profile subdirectories
    await rm(profileDir, { force: true, recursive: true });
  } catch (error) {
    // Ignore cleanup errors
    console.warn("Failed to cleanup browser profiles:", error);
  }
}
