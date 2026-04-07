// ─── NMS Lesson Service ───────────────────────────────────────────────────────
//
// Loads the pre-built lesson index (lessons.json) and scores lessons against
// a user query using the same keyword-expansion logic as courseService.js.
//
// Returns the top matching NON-BONUS lessons, plus a flag if there is a
// relevant bonus lesson (so the AI can tease it without revealing it upfront).

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH  = path.resolve(__dirname, "../data/lessons.json");

// ── Load index ────────────────────────────────────────────────────────────────
function loadLessons() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    console.log(`[lessonService] Loaded ${raw.total} lessons (built ${raw.builtAt?.slice(0, 10)}).`);
    return raw.lessons ?? [];
  } catch {
    console.warn("[lessonService] lessons.json not found — run `npm run build:lessons` to generate it.");
    return [];
  }
}

let lessons = loadLessons();

// ── Stop words (same set as courseService) ────────────────────────────────────
const STOP_WORDS = new Set([
  "that","this","with","have","from","they","will","what","when","more",
  "also","about","your","just","like","very","some","been","want","need",
  "feel","help","make","know","think","time","good","better","really",
  "does","into","their","there","these","those","then","than","them",
  "each","much","many","most","here","over","such","only","even","back",
  "both","well","long","able","find","give","live","move","work","take",
  "come","ways","made","used","life","body","mind","self","every","while",
  "start","begin","learn","become","improve","practice","discover","explore",
  "build","join","stop","keep","show","goes","lets","gets","puts",
  "level","levels","completely","totally","fully","highly","really",
]);

// ── Simple suffix stemmer ─────────────────────────────────────────────────────
function stems(word) {
  const v = new Set([word]);
  for (const s of ["ing","tion","ness","ment","ful","ily","ly","er","ed","es","s"]) {
    if (word.endsWith(s) && word.length - s.length >= 4) v.add(word.slice(0, -s.length));
  }
  return [...v];
}

// ── Word-boundary matcher ─────────────────────────────────────────────────────
function matchesText(text, variants) {
  return variants.some(v => {
    try { return new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text); }
    catch { return text.includes(v); }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Find the most relevant lessons for a user message.
 *
 * @param {string}   userMessage
 * @param {string[]} relevantCourseNames  - Only search within these courses (from courseService results)
 * @param {number}   limit                - Max non-bonus lessons to return
 * @returns {{ topLessons, bonusHint }}
 *   topLessons: Array of { courseName, moduleName, lessonName, summary }
 *   bonusHint:  null | { courseName, lessonName } — first relevant bonus lesson found
 */
export function findRelevantLessons(userMessage, relevantCourseNames = [], limit = 2) {
  if (!lessons.length) return { topLessons: [], bonusHint: null };

  // Extract keywords from query
  const rawWords = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));

  if (!rawWords.length) return { topLessons: [], bonusHint: null };

  // Build variant sets (stems only — no synonym expansion needed here,
  // GPT already used natural language in the summaries)
  const wordVariants = rawWords.map(w => stems(w));
  const minScore = Math.max(1, Math.ceil(wordVariants.length * 0.3));

  // Restrict to the courses already surfaced by courseService when possible
  const courseSet  = new Set(relevantCourseNames.map(n => n.toLowerCase()));
  const pool = relevantCourseNames.length > 0
    ? lessons.filter(l => courseSet.has(l.courseName.toLowerCase()))
    : lessons;

  const scored = pool.map(l => {
    const haystack = `${l.lessonName} ${l.summary} ${(l.keywords ?? []).join(" ")}`.toLowerCase();
    const score = wordVariants.reduce((n, variants) => n + (matchesText(haystack, variants) ? 1 : 0), 0);
    return { lesson: l, score };
  }).filter(r => r.score >= minScore);

  // Separate bonus from regular lessons
  const regular = scored.filter(r => !r.lesson.isBonus).sort((a, b) => b.score - a.score);
  const bonus   = scored.filter(r =>  r.lesson.isBonus).sort((a, b) => b.score - a.score);

  const topLessons = regular.slice(0, limit).map(r => ({
    courseName: r.lesson.courseName,
    moduleName: r.lesson.moduleName,
    lessonName: r.lesson.lessonName,
    summary:    r.lesson.summary,
  }));

  const bonusHint = bonus.length ? {
    courseName: bonus[0].lesson.courseName,
    lessonName: bonus[0].lesson.lessonName,
  } : null;

  return { topLessons, bonusHint };
}

/**
 * Format matched lessons for the AI system prompt.
 */
export function formatLessonsForPrompt(topLessons, bonusHint) {
  if (!topLessons.length && !bonusHint) return "";

  const lines = [];

  if (topLessons.length) {
    lines.push("SPECIFIC LESSONS that directly answer the user's question (from the indexed courses):");
    for (const l of topLessons) {
      const mod = l.moduleName ? ` › ${l.moduleName}` : "";
      lines.push(`• "${l.courseName}"${mod} › ${l.lessonName}`);
      if (l.summary) lines.push(`  ${l.summary}`);
    }
    lines.push("");
    lines.push("When referencing these, say something like: \"In [Course Name], the lesson '[Lesson Name]' covers exactly this.\"");
  }

  if (bonusHint) {
    lines.push("");
    lines.push(`BONUS LESSON HINT: There is a relevant bonus lesson "${bonusHint.lessonName}" in "${bonusHint.courseName}" — mention it exists as a reward for completing the course, but do NOT describe its content or recommend it directly.`);
  }

  return lines.join("\n");
}
