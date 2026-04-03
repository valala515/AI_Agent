#!/usr/bin/env node
// ─── NMS Course Sync Script ───────────────────────────────────────────────────
//
// Fetches the full course catalogue from the NMS API and writes it to
// backend/src/data/courses.json for use by courseService.js.
//
// Run manually:   npm run sync
// Auto-run:       courseService.js calls this weekly on server start
//
// The file is committed to the repo so the server always has a baseline
// even before the first sync runs.

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// ── Load .env ─────────────────────────────────────────────────────────────────
const envPath = path.join(projectRoot, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  }
}

const NMS_BASE = process.env.NMS_API_URL  || "https://newmindstart.com";
const NMS_KEY  = process.env.NMS_BOT_KEY;
const OUT_PATH = path.join(projectRoot, "backend", "src", "data", "courses.json");

// ── Fetch ─────────────────────────────────────────────────────────────────────
async function fetchAllCourses() {
  if (!NMS_KEY) throw new Error("NMS_BOT_KEY is not set in .env");

  const all  = [];
  let   page = 1;

  while (true) {
    const url = `${NMS_BASE}/api/courses?per-page=100&page=${page}&expand=thumb_big&sort=-id`;
    process.stdout.write(`  Fetching page ${page}…`);

    const res = await fetch(url, {
      headers: { "Accept": "application/json", "x-bot-key": NMS_KEY },
    });

    if (!res.ok) throw new Error(`API error ${res.status} on page ${page}`);

    const json       = await res.json();
    const courses    = json.data       ?? [];
    const pagination = json.pagination ?? {};

    all.push(...courses);
    console.log(` ${courses.length} courses (total so far: ${all.length})`);

    if (page >= (pagination.pagination_page_count ?? 1)) break;
    page++;
  }

  return all;
}

// ── Normalise ─────────────────────────────────────────────────────────────────
// Strip heavy fields we never use (vimeo_folder, admin_description, etc.)
// to keep the file small and focused on what the AI actually needs.
function normaliseCourse(c) {
  let author = null;
  try {
    const info = typeof c.author_info === "string" ? JSON.parse(c.author_info) : c.author_info;
    author = info?.[0]?.name ?? null;
  } catch {}

  const excerpt = (c.excerpt ?? "").replace(/<[^>]+>/g, "").trim();

  return {
    id:         c.id,
    title:      c.title,
    slug:       c.slug,
    author,
    rating:     c.rating     ?? null,
    thumb:      c.thumb_big  ?? null,
    excerpt:    excerpt.slice(0, 300),
    lang:       c.lang       ?? c.locale ?? null,
    created_at: c.created_at ?? null,
  };
}

// ── Write ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log("🔄  Syncing NMS course catalogue…");
  const raw        = await fetchAllCourses();
  const normalised = raw.map(normaliseCourse);

  // English-only — never recommend Russian-language courses
  const englishOnly = normalised.filter(c => !c.lang || c.lang === "en");
  const skipped     = normalised.length - englishOnly.length;
  if (skipped > 0) console.log(`  Skipped ${skipped} non-English course(s).`);

  const payload = {
    syncedAt: new Date().toISOString(),
    total:    englishOnly.length,
    courses:  englishOnly,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  const kb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
  console.log(`✅  Saved ${englishOnly.length} English courses → ${OUT_PATH} (${kb} KB)`);
}

run().catch(err => { console.error("❌ Sync failed:", err.message); process.exit(1); });
