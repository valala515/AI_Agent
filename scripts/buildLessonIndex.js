#!/usr/bin/env node
// ─── NMS Lesson Index Builder ─────────────────────────────────────────────────
//
// Reads all WEBVTT subtitle files from assets/_Subtitles_Eng/,
// strips timestamps, and calls GPT-4o-mini ONCE per lesson to produce:
//   • a 2-sentence summary of what the lesson covers
//   • a flat keyword list for matching against user queries
//
// Output: backend/src/data/lessons.json
//
// Run once:  node scripts/buildLessonIndex.js
// Re-run:    whenever new subtitle folders are added
//
// Cost estimate: ~145 lessons × ~600 tokens = ~87k tokens ≈ $0.05 at gpt-4o-mini pricing
// ─────────────────────────────────────────────────────────────────────────────

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const ROOT        = path.resolve(__dirname, "..");
const SUBTITLES   = path.join(ROOT, "assets", "_Subtitles_Eng");
const OUTPUT      = path.join(ROOT, "backend", "src", "data", "lessons.json");
const ENV_PATH    = path.join(ROOT, ".env");

// ── Load .env ─────────────────────────────────────────────────────────────────
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  }
}

const OPENAI_KEY  = process.env.OPENAI_API_KEY;
const MODEL       = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_URL  = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

if (!OPENAI_KEY) {
  console.error("❌  OPENAI_API_KEY not set in .env");
  process.exit(1);
}

// ── WEBVTT parser ─────────────────────────────────────────────────────────────
// Strips cue headers (timestamps + sequence numbers) and returns clean text.
function parseVTT(raw) {
  return raw
    .replace(/WEBVTT[^\n]*/g, "")          // remove header line
    .replace(/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}[^\n]*/g, "")
    .replace(/^\d+\s*$/gm, "")             // remove cue index numbers
    .replace(/<[^>]+>/g, "")               // strip any inline tags
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Walk the subtitle tree ────────────────────────────────────────────────────
// Returns array of { courseName, moduleName, lessonName, isBonus, vttPath }
function collectLessons() {
  const lessons = [];

  const BONUS_RE = /bonus/i;

  for (const courseEntry of fs.readdirSync(SUBTITLES, { withFileTypes: true })) {
    if (!courseEntry.isDirectory()) continue;
    const courseName = courseEntry.name.trim();
    if (courseName.startsWith(".")) continue;

    const courseDir = path.join(SUBTITLES, courseEntry.name);
    const courseContents = fs.readdirSync(courseDir, { withFileTypes: true });

    // Check if lessons are directly inside the course folder (flat) or in modules
    const hasDirs  = courseContents.some(e => e.isDirectory() && !e.name.startsWith("."));
    const hasFiles = courseContents.some(e => e.isFile() && !e.name.startsWith("."));

    if (!hasDirs && hasFiles) {
      // Flat structure — lessons directly under course folder
      for (const file of courseContents) {
        if (!file.isFile() || file.name.startsWith(".")) continue;
        lessons.push({
          courseName,
          moduleName: null,
          lessonName: file.name,
          isBonus:    BONUS_RE.test(file.name),
          vttPath:    path.join(courseDir, file.name),
        });
      }
    } else {
      // Module/folder structure
      for (const modEntry of courseContents) {
        if (!modEntry.isDirectory()) continue;
        if (modEntry.name.startsWith(".")) continue;
        const moduleName = modEntry.name.trim();
        const moduleDir  = path.join(courseDir, modEntry.name);
        const isBonus    = BONUS_RE.test(moduleName);

        for (const lessonEntry of fs.readdirSync(moduleDir, { withFileTypes: true })) {
          if (!lessonEntry.isFile()) continue;
          if (lessonEntry.name.startsWith(".")) continue;
          lessons.push({
            courseName,
            moduleName,
            lessonName: lessonEntry.name,
            isBonus,
            vttPath:    path.join(moduleDir, lessonEntry.name),
          });
        }
      }
    }
  }

  return lessons;
}

// ── GPT summariser ────────────────────────────────────────────────────────────
async function summariseLesson(courseName, lessonName, transcriptText) {
  // Truncate to ~800 words to keep token cost low
  const words    = transcriptText.split(/\s+/);
  const truncated = words.slice(0, 800).join(" ") + (words.length > 800 ? "…" : "");

  const prompt = `You are building a searchable index for a wellness course platform.

Course: "${courseName}"
Lesson: "${lessonName}"

Transcript excerpt:
"""
${truncated}
"""

Reply with ONLY valid JSON (no markdown, no explanation):
{
  "summary": "<2 sentences: what this lesson teaches and what the student will be able to do>",
  "keywords": ["<5-12 specific topical keywords a user might search for>"]
}

Rules for keywords:
- Use lowercase, 1-3 words each
- Focus on symptoms, techniques, body parts, emotions, outcomes
- No generic words like "learn", "course", "introduction", "welcome"`;

  const res = await fetch(`${OPENAI_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model:       MODEL,
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI ${res.status}: ${body}`);
  }

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content?.trim() ?? "{}";

  try {
    return JSON.parse(raw);
  } catch {
    // Try to extract JSON from markdown code block if model ignored instructions
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { summary: "", keywords: [] };
  }
}

// ── Throttled batch runner ────────────────────────────────────────────────────
// Processes lessons N at a time to avoid rate limits
async function processBatch(lessons, concurrency = 3) {
  const results = [];
  for (let i = 0; i < lessons.length; i += concurrency) {
    const batch = lessons.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (l) => {
        const raw  = fs.readFileSync(l.vttPath, "utf8");
        const text = parseVTT(raw);
        if (!text.trim()) {
          return { ...l, summary: "", keywords: [] };
        }
        const gpt = await summariseLesson(l.courseName, l.lessonName, text);
        return { ...l, summary: gpt.summary ?? "", keywords: gpt.keywords ?? [] };
      })
    );
    for (const s of settled) {
      if (s.status === "fulfilled") {
        results.push(s.value);
      } else {
        console.warn("  ⚠️  Lesson failed:", s.reason?.message);
      }
    }
    process.stdout.write(`  Progress: ${Math.min(i + concurrency, lessons.length)}/${lessons.length}\r`);
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🔍  Scanning subtitle folders…");
  const lessons = collectLessons();
  console.log(`📚  Found ${lessons.length} lessons across ${new Set(lessons.map(l => l.courseName)).size} courses`);
  console.log(`🤖  Sending to ${MODEL} for summarisation (this takes ~2 minutes)…\n`);

  // Check if output already exists — only re-process new lessons
  let existing = {};
  if (fs.existsSync(OUTPUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));
      for (const l of (prev.lessons ?? [])) {
        existing[l.vttPath] = l;
      }
      console.log(`♻️   Found ${Object.keys(existing).length} previously indexed lessons — skipping those\n`);
    } catch {}
  }

  const toProcess = lessons.filter(l => !existing[l.vttPath] || !existing[l.vttPath].summary);
  const skipped   = lessons.filter(l =>  existing[l.vttPath] &&  existing[l.vttPath].summary);

  console.log(`⚡  Processing ${toProcess.length} new/updated lessons, skipping ${skipped.length}…\n`);

  const processed = toProcess.length > 0 ? await processBatch(toProcess, 3) : [];

  // Merge: existing (still valid) + newly processed
  const allLessons = [
    ...skipped.map(l => existing[l.vttPath]),
    ...processed,
  ].map(l => ({
    courseName: l.courseName,
    moduleName: l.moduleName ?? null,
    lessonName: l.lessonName,
    isBonus:    l.isBonus,
    summary:    l.summary,
    keywords:   l.keywords,
    // keep vttPath so incremental re-runs can skip unchanged lessons
    vttPath:    l.vttPath,
  }));

  const output = {
    builtAt: new Date().toISOString(),
    total:   allLessons.length,
    lessons: allLessons,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), "utf8");

  console.log(`\n\n✅  Done! ${allLessons.length} lessons written to backend/src/data/lessons.json`);

  // Print a quick summary per course
  const byCourse = {};
  for (const l of allLessons) {
    byCourse[l.courseName] = (byCourse[l.courseName] ?? 0) + 1;
  }
  for (const [course, count] of Object.entries(byCourse)) {
    console.log(`   ${count} lessons — ${course}`);
  }
}

main().catch(err => {
  console.error("❌  Build failed:", err.message);
  process.exit(1);
});
