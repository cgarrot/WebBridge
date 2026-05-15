#!/usr/bin/env node

/**
 * Registers the WebBridge Native Messaging Host manifest for Chrome.
 *
 * - Windows: writes to HKCU\Software\Google\Chrome\NativeMessagingHosts
 * - macOS: writes to ~/Library/Application Support/Google/Chrome/NativeMessagingHosts
 * - Linux: writes to ~/.config/google-chrome/NativeMessagingHosts
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const HOST_NAME = "com.webbridge.host";
const daemonEntry = resolve(__dirname, "..", "dist", "index.js");

const manifest = {
  name: HOST_NAME,
  description: "WebBridge browser automation daemon",
  path: process.platform === "win32"
    ? resolve(__dirname, "..", "native-host.bat")
    : daemonEntry,
  type: "stdio",
  allowed_origins: [
    // Will be filled with actual extension ID after first install
    "chrome-extension://YOUR_EXTENSION_ID_HERE/",
  ],
};

function installWindows() {
  const manifestPath = resolve(__dirname, `${HOST_NAME}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const batPath = resolve(__dirname, "..", "native-host.bat");
  writeFileSync(
    batPath,
    `@echo off\r\nset WEBBRIDGE_NATIVE_HOST=1\r\nnode "${daemonEntry}" %*\r\n`
  );

  const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`);
  console.log(`[install] Registry key set: ${regKey}`);
  console.log(`[install] Manifest: ${manifestPath}`);
}

function installUnix() {
  const homeDir = process.env.HOME || "~";
  let targetDir;

  if (process.platform === "darwin") {
    targetDir = join(homeDir, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  } else {
    targetDir = join(homeDir, ".config", "google-chrome", "NativeMessagingHosts");
  }

  mkdirSync(targetDir, { recursive: true });
  const manifestPath = join(targetDir, `${HOST_NAME}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[install] Manifest written: ${manifestPath}`);
}

if (process.platform === "win32") {
  installWindows();
} else {
  installUnix();
}

console.log("[install] Done. Update allowed_origins with your extension ID.");
