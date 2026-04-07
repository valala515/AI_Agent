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

// ── Fetch course list ─────────────────────────────────────────────────────────
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

// ── Fetch full description for one course ─────────────────────────────────────
async function fetchCourseBody(id) {
  const url = `${NMS_BASE}/api/courses/${id}`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "x-bot-key": NMS_KEY },
  });
  if (!res.ok) return null;
  const json = await res.json();

  let raw = json.description ?? json.data?.description ?? null;
  if (!raw) return null;

  // description is a JSON string containing an array of content blocks
  let blocks;
  try {
    blocks = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }

  if (!Array.isArray(blocks)) return null;

  // Collect all text content from blocks — skip list items (usually bullet points
  // that duplicate the excerpt) unless they're the only content.
  const parts = [];
  for (const block of blocks) {
    const t = block.text ?? block.subtitle ?? null;
    if (t && typeof t === "string") {
      // Strip markdown bold/italic markers and HTML tags
      const clean = t
        .replace(/<[^>]+>/g, " ")
        .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
        .replace(/_([^_]+)_/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
      if (clean.length > 20) parts.push(clean);
    }
    // Also grab list items
    if (Array.isArray(block.list)) {
      for (const item of block.list) {
        const s = typeof item === "string" ? item : item?.text ?? "";
        const clean = s.replace(/<[^>]+>/g, " ").replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1").trim();
        if (clean.length > 10) parts.push(clean);
      }
    }
  }

  return parts.join(" ").slice(0, 2000) || null;
}

// ── Enrich courses with full landing page bodies (batched) ────────────────────
async function enrichWithBodies(courses, batchSize = 5) {
  const results = [];
  for (let i = 0; i < courses.length; i += batchSize) {
    const batch = courses.slice(i, i + batchSize);
    const bodies = await Promise.all(batch.map((c) => fetchCourseBody(c.id)));
    for (let j = 0; j < batch.length; j++) {
      results.push({ ...batch[j], body: bodies[j] ?? null });
    }
    process.stdout.write(`  Enriched ${Math.min(i + batchSize, courses.length)}/${courses.length} courses\r`);
  }
  console.log(); // newline after \r progress
  return results;
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
    body:       c.body       ?? null,
    lang:       c.lang       ?? c.locale ?? null,
    created_at: c.created_at ?? null,
  };
}

// ── Write ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log("🔄  Syncing NMS course catalogue…");
  const raw        = await fetchAllCourses();
  console.log(`  Fetched ${raw.length} courses. Enriching with full descriptions…`);
  const enriched   = await enrichWithBodies(raw);
  const normalised = enriched.map(normaliseCourse);

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
