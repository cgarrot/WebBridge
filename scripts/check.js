#!/usr/bin/env node
const { spawnSync } = require("node:child_process");

const result = spawnSync("pnpm", ["build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
