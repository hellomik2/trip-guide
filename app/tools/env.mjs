// Settings shared by the dev tools. Local paths live in local/test-env.json (git-ignored) or env vars.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'local', 'test-env.json');
const local = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

export const CHROME_EXE = process.env.CHROME_EXE || local.chromeExe || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// A separate Chrome profile for testing, one that already has the on-device model.
// Never point this at your everyday profile, and never at a profile without the model
// (opening the app there can start a multi-GB model download).
export const PROFILE_DIR = process.env.CHROME_PROFILE || local.profileDir || null;
export const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || local.debugPort || 9337);
export const PAGE_PORT = Number(process.env.PORT || local.pagePort || 8790);
export const CDP_URL = `http://127.0.0.1:${DEBUG_PORT}`;
export const RESULTS_DIR = process.env.RESULTS_DIR || local.resultsDir || path.join(ROOT, 'test', 'results');

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
