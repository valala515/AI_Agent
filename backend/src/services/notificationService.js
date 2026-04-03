// ─── NMS Notification Service ─────────────────────────────────────────────────
//
// Generates three types of proactive notifications for the widget:
//
//  1. new_course    — released in the last 7 days, matches user interests
//  2. popular_course — high-rated course matching interests, not yet seen
//  3. event          — upcoming community event (placeholder until events API live)
//
// Interests are keyword arrays extracted from the user's chat history.
// seenIds are course IDs already shown to this user (tracked in localStorage).

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH  = path.resolve(__dirname, "../data/courses.json");
const NMS_BASE   = process.env.NMS_API_URL || "https://newmindstart.com";
const NEW_WINDOW = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Load courses ──────────────────────────────────────────────────────────────

function loadCourses() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8")).courses ?? [];
  } catch { return []; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchScore(course, words) {
  if (!words.length) return 0;
  const hay = `${course.title} ${course.excerpt}`.toLowerCase();
  return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
}

function serialize(course) {
  return {
    id:     course.id,
    title:  course.title,
    author: course.author,
    rating: course.rating,
    thumb:  course.thumb,
    url:    `${NMS_BASE}/courses/${course.slug}`,
  };
}

// Random social proof number: regenerated on every notification render
// so it naturally varies each session (200 – 1 800)
function socialProof() {
  return Math.floor(Math.random() * (1_800 - 200) + 200);
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function generateNotifications({ interests = [], seenIds = [] }) {
  const courses = loadCourses();
  const words   = interests
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  const unseen = courses.filter((c) => !seenIds.includes(c.id));
  const now    = Date.now();

  const notifications = [];

  // ── 1. New course (released this week, matches interests) ─────────────────
  const newCourses = unseen
    .filter((c) => c.created_at && now - new Date(c.created_at).getTime() < NEW_WINDOW)
    .map((c)    => ({ c, score: matchScore(c, words) }))
    .filter(({ score }) => score > 0 || words.length === 0) // show any new if no interests yet
    .sort((a, b) => b.score - a.score);

  if (newCourses.length) {
    const course = newCourses[0].c;
    notifications.push({
      type:     "new_course",
      course:   serialize(course),
      watching: socialProof(),
    });
  }

  // ── 2. Popular course (rating ≥ 4.7, matches interests, not yet seen) ─────
  const pickedNewId = notifications[0]?.course?.id;
  const popular = unseen
    .filter((c) => (c.rating ?? 0) >= 4.7 && c.id !== pickedNewId)
    .map((c)    => ({ c, score: matchScore(c, words) + (c.rating ?? 0) * 0.1 }))
    .filter(({ score }) => score > 0 || words.length === 0)
    .sort((a, b) => b.score - a.score);

  if (popular.length) {
    notifications.push({
      type:   "popular_course",
      course: serialize(popular[0].c),
    });
  }

  // ── 3. Upcoming event (placeholder — real data added when events API live) ─
  notifications.push({
    type:  "event",
    event: null, // replace with real event object once API is available
  });

  return notifications;
}
