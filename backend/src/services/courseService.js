// ─── NMS Course Service ───────────────────────────────────────────────────────
//
// Reads from backend/src/data/courses.json (synced weekly by scripts/syncCourses.js).
// No live API call on every chat request — token-safe and fast.
//
// Weekly auto-refresh: on server start a timer fires every 7 days and
// re-runs the sync script in the background.

import fs      from "fs";
import path    from "path";
import { execFile }     from "child_process";
import { fileURLToPath } from "url";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH   = path.resolve(__dirname, "../data/courses.json");
const SYNC_SCRIPT = path.resolve(__dirname, "../../../scripts/syncCourses.js");
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NMS_BASE    = process.env.NMS_API_URL || "https://newmindstart.com";

// ─── Load from file ───────────────────────────────────────────────────────────

function loadFromFile() {
  try {
    const raw  = fs.readFileSync(DATA_PATH, "utf8");
    const json = JSON.parse(raw);
    console.log(`[courseService] Loaded ${json.total} courses from file (synced ${json.syncedAt}).`);
    return json.courses ?? [];
  } catch {
    console.warn("[courseService] courses.json not found — run `npm run sync` to generate it.");
    return [];
  }
}

// In-memory catalogue — populated on first import
let courses = loadFromFile();

// ─── Weekly background refresh ────────────────────────────────────────────────

function scheduleWeeklySync() {
  const timer = setInterval(() => {
    console.log("[courseService] Weekly sync starting…");
    execFile("node", [SYNC_SCRIPT], (err, stdout) => {
      if (err) {
        console.error("[courseService] Weekly sync failed:", err.message);
        return;
      }
      console.log(stdout.trim());
      courses = loadFromFile(); // reload into memory after sync
    });
  }, ONE_WEEK_MS);

  // Don't keep the process alive just for this timer
  timer.unref();
}

scheduleWeeklySync();

// ─── Analytics scores (plugged in later) ─────────────────────────────────────

let analyticsScores = {};
export function updateAnalyticsScores(scores) {
  analyticsScores = scores ?? {};
}

// ─── Match ────────────────────────────────────────────────────────────────────

export async function findRelevantCourses(userMessage, limit = 3) {
  if (!courses.length) return [];

  const words = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  if (!words.length) return [];

  const maxId = courses.reduce((m, c) => Math.max(m, c.id ?? 0), 0);

  return courses
    .map((course) => {
      const haystack = [course.title ?? "", course.excerpt ?? ""].join(" ").toLowerCase();
      const relevance  = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
      if (relevance === 0) return null;

      const freshness  = maxId > 0 ? (course.id ?? 0) / maxId : 0;
      const popularity = analyticsScores[course.id] ?? 0;
      const total      = relevance * 1.0 + freshness * 0.3 + popularity * 0.0;

      return { course, total };
    })
    .filter(Boolean)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map(({ course }) => course);
}

// ─── Format for system prompt ─────────────────────────────────────────────────

export function formatCourseForPrompt(course) {
  return [
    `• "${course.title}"`,
    course.author ? `by ${course.author}` : null,
    course.rating ? `★ ${course.rating}`  : null,
    course.excerpt ? `— ${course.excerpt.slice(0, 120)}…` : null,
  ].filter(Boolean).join("  ");
}

// ─── Serialise for frontend ───────────────────────────────────────────────────

export function serializeCourseForClient(course) {
  return {
    title:  course.title,
    author: course.author,
    rating: course.rating,
    thumb:  course.thumb,
    url:    `${NMS_BASE}/courses/${course.slug}`,
  };
}
