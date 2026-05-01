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
exports.ensureBrowserProfileDirectory = ensureBrowserProfileDirectory;
exports.forceCleanupBrowserProfiles = forceCleanupBrowserProfiles;
const promises_1 = require("node:fs/promises");
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
/**
 * Stable per-workspace (or global) directory for Chromium user-data so cookies,
 * localStorage, and IndexedDB survive across extension restarts.
 *
 * Also removes stale lock files left by a previously crashed Chromium process —
 * without this, Chromium refuses to start with the same user-data-dir.
 */
async function ensureBrowserProfileDirectory(context) {
    const base = context.storageUri ?? context.globalStorageUri;
    const dir = path.join(base.fsPath, "chromium-profile");
    // If directory exists and has lock files, create a unique subdirectory
    try {
        await (0, promises_1.mkdir)(dir, { recursive: true });
        // Check for existing singleton lock and handle it
        const lockFile = path.join(dir, "SingletonLock");
        try {
            await (0, promises_1.unlink)(lockFile);
        }
        catch (error) {
            // If unlink fails, the lock might be held by an active process
            // Create a unique profile directory instead
            const uniqueDir = path.join(dir, `profile-${(0, node_crypto_1.randomUUID)()}`);
            await (0, promises_1.mkdir)(uniqueDir, { recursive: true });
            return uniqueDir;
        }
        // Clean up other stale lock files
        const staleLockFiles = ["SingletonSocket", "SingletonCookie", "DevToolsActivePort"];
        for (const name of staleLockFiles) {
            await (0, promises_1.unlink)(path.join(dir, name)).catch(() => undefined);
        }
    }
    catch (error) {
        // If directory creation fails, try creating a unique one
        const uniqueDir = path.join(dir, `profile-${(0, node_crypto_1.randomUUID)()}`);
        await (0, promises_1.mkdir)(uniqueDir, { recursive: true });
        return uniqueDir;
    }
    return dir;
}
/**
 * Force cleanup of all Chrome profile directories and lock files
 */
async function forceCleanupBrowserProfiles(context) {
    const base = context.storageUri ?? context.globalStorageUri;
    const profileDir = path.join(base.fsPath, "chromium-profile");
    try {
        // Remove all Chrome lock files and profile subdirectories
        await (0, promises_1.rm)(profileDir, { force: true, recursive: true });
    }
    catch (error) {
        // Ignore cleanup errors
        console.warn("Failed to cleanup browser profiles:", error);
    }
}
//# sourceMappingURL=browserProfilePath.js.map