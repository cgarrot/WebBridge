import path from "node:path";

export const ROOT_DIR = path.resolve(process.env.WEBBRIDGE_ROOT ?? process.cwd());
export const DATA_DIR = path.join(ROOT_DIR, ".webbridge-data");
export const RUNTIME_FILE = path.join(DATA_DIR, "runtime.json");
export const PID_FILE = path.join(DATA_DIR, "daemon.pid");
export const LOG_FILE = path.join(DATA_DIR, "daemon.log");
