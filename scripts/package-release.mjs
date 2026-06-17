#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const target = args.target;
const nodeRuntime = args["node-runtime"];
const outDir = path.resolve(ROOT_DIR, args["out-dir"] ?? ".release");

if (!target || !nodeRuntime) {
  usage();
  process.exit(2);
}

const match = /^(macos|linux|windows)-(x64|arm64)$/.exec(target);
if (!match) {
  throw new Error(`Invalid --target "${target}". Expected macos-x64, macos-arm64, linux-x64, linux-arm64, windows-x64, or windows-arm64.`);
}

const platform = match[1];
const arch = match[2];
const isWindows = platform === "windows";
const nodeRuntimeDir = path.resolve(ROOT_DIR, nodeRuntime);
const packageRoot = path.join(outDir, target, "webbridge");

await assertExists(path.join(ROOT_DIR, "packages/daemon/dist/cli/index.js"), "Daemon build missing. Run pnpm build:daemon first.");
await assertExists(path.join(ROOT_DIR, "packages/daemon/dist/index.js"), "Daemon build missing. Run pnpm build:daemon first.");
await assertExists(path.join(ROOT_DIR, "packages/extension/dist/manifest.json"), "Extension build missing. Run pnpm build:extension first.");

await fsp.rm(path.join(outDir, target), { recursive: true, force: true });
await fsp.mkdir(packageRoot, { recursive: true });

await copyDir(path.join(ROOT_DIR, "packages/daemon/dist"), path.join(packageRoot, "packages/daemon/dist"));
await copyFile(path.join(ROOT_DIR, "packages/daemon/package.json"), path.join(packageRoot, "packages/daemon/package.json"));
await copyDir(path.join(ROOT_DIR, "packages/extension/dist"), path.join(packageRoot, "extension"));
await copyDir(path.join(ROOT_DIR, "skills"), path.join(packageRoot, "skills"));
await copyFileIfExists(path.join(ROOT_DIR, "README.md"), path.join(packageRoot, "README.md"));
await copyFileIfExists(path.join(ROOT_DIR, "LICENSE"), path.join(packageRoot, "LICENSE"));
await copyFileIfExists(path.join(ROOT_DIR, "docs/agent-install.md"), path.join(packageRoot, "docs/agent-install.md"));
await copyFileIfExists(path.join(ROOT_DIR, "scripts/install-user.sh"), path.join(packageRoot, "scripts/install-user.sh"));
await copyFileIfExists(path.join(ROOT_DIR, "scripts/install-user.ps1"), path.join(packageRoot, "scripts/install-user.ps1"));

await copyNodeRuntime({ nodeRuntimeDir, packageRoot, isWindows });
await writeWrappers({ packageRoot, isWindows });
await writeInstallReadme({ packageRoot, target });
await writeManifest({ packageRoot, target, platform, arch });

console.log(`Packaged WebBridge ${target}: ${packageRoot}`);

async function copyNodeRuntime({ nodeRuntimeDir, packageRoot, isWindows }) {
  if (isWindows) {
    const source = firstExisting([
      path.join(nodeRuntimeDir, "node.exe"),
      path.join(nodeRuntimeDir, "bin/node.exe"),
    ]);
    if (!source) throw new Error(`Could not find node.exe under ${nodeRuntimeDir}`);
    await copyFile(source, path.join(packageRoot, "runtime/node/node.exe"));
    return;
  }

  const source = firstExisting([
    path.join(nodeRuntimeDir, "bin/node"),
    path.join(nodeRuntimeDir, "node"),
  ]);
  if (!source) throw new Error(`Could not find node binary under ${nodeRuntimeDir}`);
  const dest = path.join(packageRoot, "runtime/node/bin/node");
  await copyFile(source, dest);
  await fsp.chmod(dest, 0o755);
}

async function writeWrappers({ packageRoot, isWindows }) {
  const binDir = path.join(packageRoot, "bin");
  await fsp.mkdir(binDir, { recursive: true });

  if (isWindows) {
    const cmd = `@echo off\r\nsetlocal\r\nset "WEBBRIDGE_HOME=%~dp0.."\r\nset "WEBBRIDGE_ROOT=%WEBBRIDGE_HOME%"\r\npushd "%WEBBRIDGE_HOME%" >nul\r\n"%WEBBRIDGE_HOME%\\runtime\\node\\node.exe" "%WEBBRIDGE_HOME%\\packages\\daemon\\dist\\cli\\index.js" %*\r\nset "WEBBRIDGE_EXIT=%ERRORLEVEL%"\r\npopd >nul\r\nexit /b %WEBBRIDGE_EXIT%\r\n`;
    await fsp.writeFile(path.join(binDir, "webbridge.cmd"), cmd, "utf8");
    await fsp.writeFile(path.join(binDir, "webbridge-daemon.cmd"), cmd, "utf8");
    return;
  }

  const sh = `#!/usr/bin/env sh\nset -eu\nWEBBRIDGE_HOME="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexport WEBBRIDGE_ROOT="$WEBBRIDGE_HOME"\ncd "$WEBBRIDGE_HOME"\nexec "$WEBBRIDGE_HOME/runtime/node/bin/node" "$WEBBRIDGE_HOME/packages/daemon/dist/cli/index.js" "$@"\n`;
  const webbridge = path.join(binDir, "webbridge");
  const daemon = path.join(binDir, "webbridge-daemon");
  await fsp.writeFile(webbridge, sh, "utf8");
  await fsp.writeFile(daemon, sh, "utf8");
  await fsp.chmod(webbridge, 0o755);
  await fsp.chmod(daemon, 0o755);
}

async function writeInstallReadme({ packageRoot, target }) {
  const text = `# WebBridge Portable Install\n\nTarget: ${target}\n\nThis release bundle is self-contained. It includes:\n\n- a bundled Node.js runtime for the local daemon\n- the built WebBridge daemon\n- the built Chrome extension\n- ready-made agent Skills\n\n## Start WebBridge\n\nmacOS/Linux:\n\n\`\`\`bash\n./bin/webbridge start\n./bin/webbridge status\n\`\`\`\n\nWindows:\n\n\`\`\`powershell\n.\\bin\\webbridge.cmd start\n.\\bin\\webbridge.cmd status\n\`\`\`\n\n## One manual Chrome step\n\nChrome does not let scripts install this unpacked extension automatically.\nDo this once in the Chrome browser you want agents to control:\n\n1. Open Chrome and go to:\n   \`chrome://extensions\`\n2. Turn on:\n   \`Developer mode\`\n3. Click:\n   \`Load unpacked\`\n4. When Chrome asks for a folder, select this bundle's \`extension\` folder.\n\nImportant: select the folder named \`extension\` itself. Do not select \`manifest.json\` or any file inside the folder.\n\n5. Check status again. Expected after loading the extension:\n   \`Extension: Connected\`\n\n## Local API\n\n- Health: http://127.0.0.1:10087/health\n- Tool API: http://127.0.0.1:10087/api/tool\n`;
  await fsp.writeFile(path.join(packageRoot, "README-INSTALL.md"), text, "utf8");
}

async function writeManifest({ packageRoot, target, platform, arch }) {
  const rootPackage = JSON.parse(await fsp.readFile(path.join(ROOT_DIR, "package.json"), "utf8"));
  const manifest = {
    schema: "webbridge.release-bundle.v1",
    name: "WebBridge",
    version: rootPackage.version ?? "0.0.0",
    target,
    platform,
    arch,
    builtAt: new Date().toISOString(),
    gitSha: process.env.GITHUB_SHA ?? process.env.WEBBRIDGE_GIT_SHA ?? null,
    commands: platform === "windows"
      ? ["bin\\webbridge.cmd start", "bin\\webbridge.cmd status"]
      : ["bin/webbridge start", "bin/webbridge status"],
    extensionDir: "extension",
    skillDirs: ["skills/cursor", "skills/claude-code", "skills/codex", "skills/openclaw"],
  };
  await fsp.writeFile(path.join(packageRoot, "RELEASE-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

function firstExisting(paths) {
  return paths.find((candidate) => fs.existsSync(candidate));
}

async function assertExists(file, message) {
  if (!fs.existsSync(file)) throw new Error(message);
}

async function copyDir(source, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.cp(source, dest, { recursive: true, force: true, dereference: true });
}

async function copyFile(source, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(source, dest);
}

async function copyFileIfExists(source, dest) {
  if (fs.existsSync(source)) await copyFile(source, dest);
}

function usage() {
  console.log(`Usage: node scripts/package-release.mjs --target <platform-arch> --node-runtime <path> [--out-dir .release]\n\nTargets:\n  macos-x64, macos-arm64, linux-x64, linux-arm64, windows-x64, windows-arm64\n\nThe node runtime path should point to an extracted official Node.js runtime directory.\n`);
}
