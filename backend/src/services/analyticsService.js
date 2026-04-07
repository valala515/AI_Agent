// ─── NMS Chat Analytics Service ──────────────────────────────────────────────
//
// Events are appended to analytics.jsonl (one JSON object per line).
// The dashboard reads the whole file, aggregates in memory, and returns a
// single data object — no database needed for the current scale.

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH   = path.resolve(__dirname, "../data/analytics.jsonl");

// ─── Write ────────────────────────────────────────────────────────────────────

export function trackEvent(payload) {
  const line = JSON.stringify({ ...payload, ts: new Date().toISOString() }) + "\n";
  fs.appendFile(LOG_PATH, line, (err) => {
    if (err) console.error("[analytics] write error:", err.message);
  });
}

// ─── Read ─────────────────────────────────────────────────────────────────────

function readAllEvents() {
  try {
    return fs.readFileSync(LOG_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Aggregate ────────────────────────────────────────────────────────────────

export function buildDashboardData() {
  const events = readAllEvents();

  const sessions      = new Set();
  const clickSessions = new Set();
  const dailyCounts   = {};
  const courseClicks  = {};   // title → click count
  const courseRecs    = {};   // title → times recommended
  const topicsCount   = {};   // keyword → frequency
  const notifShown    = { new_course: 0, popular_course: 0, event: 0 };
  const notifClicked  = { new_course: 0, popular_course: 0, event: 0 };
  let   totalMessages = 0;

  // Per-session message counts (for avg depth before first click)
  const sessionMsgCount   = {};
  const sessionFirstClick = {}; // sessionId → message index at click

  // Per-user activity — keyed by userId, built in parallel with session stats
  const userActivity = {}; // userId → { sessions, messages, courseClicks, topics, lastSeen }
  function uAct(userId) {
    if (!userId) return null;
    return (userActivity[userId] ??= {
      sessions:     new Set(),
      messages:     0,
      courseClicks: 0,
      topics:       new Set(),
      coursesClicked:    [],
      coursesRecommended:[],
      lastSeen:     null,
    });
  }

  for (const e of events) {
    const day = (e.ts ?? "").slice(0, 10);

    const u = uAct(e.userId);

    if (e.event === "chat_opened") {
      sessions.add(e.sessionId);
      if (day) dailyCounts[day] = (dailyCounts[day] || 0) + 1;
      if (u) { u.sessions.add(e.sessionId); if (!u.lastSeen || e.ts > u.lastSeen) u.lastSeen = e.ts; }
    }

    if (e.event === "message_sent") {
      totalMessages++;
      sessions.add(e.sessionId);
      sessionMsgCount[e.sessionId] = (sessionMsgCount[e.sessionId] || 0) + 1;
      for (const t of (e.interests ?? [])) {
        topicsCount[t] = (topicsCount[t] || 0) + 1;
      }
      if (u) {
        u.messages++;
        u.sessions.add(e.sessionId);
        for (const t of (e.interests ?? [])) u.topics.add(t);
        if (!u.lastSeen || e.ts > u.lastSeen) u.lastSeen = e.ts;
      }
    }

    if (e.event === "courses_recommended") {
      for (const title of (e.courseTitles ?? [])) {
        courseRecs[title] = (courseRecs[title] || 0) + 1;
      }
      if (u) {
        for (const title of (e.courseTitles ?? [])) {
          if (!u.coursesRecommended.includes(title)) u.coursesRecommended.push(title);
        }
      }
    }

    if (e.event === "course_clicked") {
      clickSessions.add(e.sessionId);
      const key = e.courseTitle ?? "Unknown";
      courseClicks[key] = (courseClicks[key] || 0) + 1;
      // Record message depth at first click for this session
      if (!(e.sessionId in sessionFirstClick)) {
        sessionFirstClick[e.sessionId] = sessionMsgCount[e.sessionId] ?? 0;
      }
      if (u) {
        u.courseClicks++;
        if (!u.coursesClicked.includes(key)) u.coursesClicked.push(key);
        if (!u.lastSeen || e.ts > u.lastSeen) u.lastSeen = e.ts;
      }
    }

    if (e.event === "notification_shown" && e.notifType) {
      const k = e.notifType;
      notifShown[k] = (notifShown[k] || 0) + 1;
    }

    if (e.event === "notification_clicked" && e.notifType) {
      const k = e.notifType;
      notifClicked[k] = (notifClicked[k] || 0) + 1;
    }
  }

  // Serialize per-user Sets → plain values, sort by most active
  const userActivityList = Object.entries(userActivity)
    .map(([userId, u]) => ({
      userId,
      sessions:            u.sessions.size,
      messages:            u.messages,
      courseClicks:        u.courseClicks,
      topics:              [...u.topics].slice(0, 10),
      coursesClicked:      u.coursesClicked.slice(0, 10),
      coursesRecommended:  u.coursesRecommended.slice(0, 10),
      lastSeen:            u.lastSeen,
    }))
    .sort((a, b) => b.messages - a.messages);

  // Derived stats
  const totalSessions       = sessions.size;
  const sessionsWithClicks  = clickSessions.size;
  const totalCourseClicks   = Object.values(courseClicks).reduce((a, b) => a + b, 0);
  const discoveryRate       = totalSessions > 0
    ? Math.round((sessionsWithClicks / totalSessions) * 100) : 0;
  const avgMessages         = totalSessions > 0
    ? (totalMessages / totalSessions).toFixed(1) : "0";

  // Average messages before first click
  const clickDepths = Object.values(sessionFirstClick);
  const avgDepthToClick = clickDepths.length > 0
    ? (clickDepths.reduce((a, b) => a + b, 0) / clickDepths.length).toFixed(1)
    : "—";

  // Last 30 days of session activity
  const dailySessions = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailySessions.push({ date: key, count: dailyCounts[key] || 0 });
  }

  // Build click-vs-recommended comparison for top courses
  const allCourseTitles = new Set([
    ...Object.keys(courseClicks),
    ...Object.keys(courseRecs),
  ]);
  const courseComparison = [...allCourseTitles]
    .map((title) => ({
      title,
      clicks:      courseClicks[title]  ?? 0,
      recommended: courseRecs[title]    ?? 0,
    }))
    .filter((c) => c.clicks > 0 || c.recommended > 0)
    .sort((a, b) => b.clicks - a.clicks || b.recommended - a.recommended)
    .slice(0, 10);

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      totalSessions,
      totalMessages,
      totalCourseClicks,
      sessionsWithClicks,
      discoveryRate,
      avgMessages,
      avgDepthToClick,
    },
    topClickedCourses:     Object.entries(courseClicks).sort((a, b) => b[1] - a[1]).slice(0, 10),
    topRecommendedCourses: Object.entries(courseRecs).sort((a, b) => b[1] - a[1]).slice(0, 10),
    courseComparison,
    topTopics:             Object.entries(topicsCount).sort((a, b) => b[1] - a[1]).slice(0, 15),
    dailySessions,
    notifications: { shown: notifShown, clicked: notifClicked },
    userActivity:          userActivityList,
  };
}
