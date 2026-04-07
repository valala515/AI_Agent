import express from "express";
import fs      from "fs";
import path    from "path";
import { fileURLToPath } from "url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH  = path.resolve(__dirname, "../data/userProfiles.json");
const router     = express.Router();

// ─── File helpers ─────────────────────────────────────────────────────────────

function loadProfiles() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveProfiles(profiles) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(profiles, null, 2), "utf8");
}

// ─── GET /api/profile/:userId ─────────────────────────────────────────────────
// Returns the stored profile for a user (empty object if unknown).

router.get("/:userId", (req, res) => {
  const profiles = loadProfiles();
  res.json(profiles[req.params.userId] ?? {});
});

// ─── PATCH /api/profile/:userId ───────────────────────────────────────────────
// Upserts one or more profile fields. Body: { field, value } or { updates: { field: value, ... } }

router.patch("/:userId", (req, res) => {
  const profiles = loadProfiles();
  const userId   = req.params.userId;
  const existing = profiles[userId] ?? {};

  // Accept either a single { field, value } or a batch { updates: { ... } }
  let incoming = {};
  if (req.body.updates && typeof req.body.updates === "object") {
    incoming = req.body.updates;
  } else if (req.body.field) {
    incoming[req.body.field] = req.body.value;
  }

  profiles[userId] = { ...existing, ...incoming, updatedAt: new Date().toISOString() };
  saveProfiles(profiles);
  res.json(profiles[userId]);
});

export default router;
