// ─── NMS Conversation History Service ────────────────────────────────────────
//
// Persists full conversation turns per userId across sessions.
// Used for:
//   • AI context window (last 10 turns forwarded to OpenAI)
//   • Course matching context (last 2 user messages enrich the query)
//
// Storage: backend/src/data/conversationHistory.json
// Format:  { "<userId>": { turns: [...], updatedAt: "ISO" }, ... }
// Cap:     100 turns per user (~50 exchanges) — oldest trimmed automatically

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, "../data/conversationHistory.json");
const MAX_TURNS = 100;

// ─── File I/O ─────────────────────────────────────────────────────────────────

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data), "utf8");
  } catch (err) {
    console.error("[history] write error:", err.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns all stored turns for a user (up to MAX_TURNS).
 * Returns [] for unknown users.
 */
export function getUserHistory(userId) {
  if (!userId) return [];
  return load()[userId]?.turns ?? [];
}

/**
 * Appends one or more turns to the user's history.
 * Each turn: { role: "user"|"assistant", content: string, ts: ISO string }
 * Trims to MAX_TURNS after appending.
 */
export function appendTurns(userId, turns) {
  if (!userId || !turns?.length) return;
  const data     = load();
  const existing = data[userId]?.turns ?? [];
  const merged   = [...existing, ...turns].slice(-MAX_TURNS);
  data[userId]   = { turns: merged, updatedAt: new Date().toISOString() };
  save(data);
}
