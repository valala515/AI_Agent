# NMS Wellness Companion — Recommendation & Behaviour Rules

This file is the single source of truth for how the system decides what to recommend,
when to surface it, and how the AI should respond. Update this file whenever a rule
changes, and reference it when building new features on top of the recommendation engine.

---

## 1. AI Persona & Tone

| Rule | Value |
|---|---|
| Name | NMS Wellness Companion |
| Tone | Warm, supportive, non-judgmental |
| Topics | Sleep, stress, nutrition, fitness, mindfulness, habit-building |
| Forbidden | Diagnosing medical conditions, prescribing treatments or medications |
| Safety fallback | If a user describes symptoms that may need medical attention, encourage them to see a healthcare professional |

---

## 2. AI Response Format

These rules live in `chatService.js → buildSystemPrompt()` and **must not be softened**.
The AI ignores soft suggestions — use imperative language.

### When courses are available (the normal case)

```
1. Give 2–4 lines of concise, practical advice on the user's question.
2. Then add a short bridge sentence
   (e.g. "To go deeper on this, we have something just for you on NMS:").
3. Then name 1–2 of the matched courses — title only, no URL
   (the widget renders the card).
Keep the whole reply under 120 words. Do not write long paragraphs.
```

### When no courses matched

```
Keep your reply concise — under 100 words. No long paragraphs.
```

### Conversation history

- Last **10 turns** of the conversation are forwarded to the AI.
- Older turns are dropped to stay within context limits.

### Model & temperature

| Setting | Value |
|---|---|
| Default model | `gpt-4o-mini` (override via `OPENAI_MODEL` env var) |
| Temperature | `0.7` |

---

## 3. Course Catalogue

### Source

- File: `backend/src/data/courses.json`
- Synced from `https://newmindstart.com/api/courses` using header `x-bot-key`
- Run manually: `npm run sync`
- Auto-refresh: weekly background job fires on server start (`courseService.js`)

### Language filter

**English only — always.** Russian-language courses are excluded at sync time.
Filter logic: `!c.lang || c.lang === "en"`

### Normalised course shape

```json
{
  "id":         123,
  "title":      "...",
  "slug":       "course-slug",
  "author":     "Author Name",
  "rating":     4.8,
  "thumb":      "https://…",
  "excerpt":    "First 300 chars of plain-text description",
  "lang":       "en",
  "created_at": "2024-12-01T00:00:00Z"
}
```

### Sync API call

```
GET /api/courses?per-page=100&page={n}&expand=thumb_big&sort=-id
Header: x-bot-key: <NMS_BOT_KEY>
```

Pages are iterated until `pagination.pagination_page_count` is reached.

---

## 4. Course Matching & Scoring

**File:** `backend/src/services/courseService.js → findRelevantCourses()`

### Keyword extraction (from user message)

1. Lowercase the message
2. Strip non-alphanumeric characters
3. Split on whitespace
4. **Discard words with ≤ 3 characters** (removes noise like "a", "the", "is")

### Scoring formula

```
total = relevance × 1.0  +  freshness × 0.3  +  popularity × 0.0
```

| Component | How calculated | Weight |
|---|---|---|
| `relevance` | Count of keyword matches in `title + excerpt` | 1.0 |
| `freshness` | `course.id / max_id` (higher ID = newer course) | 0.3 |
| `popularity` | `analyticsScores[course.id]` (injected externally) | **0.0 — not yet active** |

> **Why freshness via ID?** The NMS API returns newer courses with higher IDs.
> Using `created_at` would require date parsing; ID is simpler and equally accurate.

### Selection

- Courses with `relevance === 0` are excluded entirely.
- Top **3** courses by `total` score are passed to the AI prompt and returned to the frontend.

### Prompt format (one line per course)

```
• "Course Title"  by Author Name  ★ 4.8  — First 120 chars of excerpt…
```

---

## 5. Interest Tracking (Frontend)

**File:** `index.html → addInterests()`

User interests are extracted from every message the user sends (typed or chip) and
stored in `localStorage` as a deduplicated keyword array.

### Stop words (always discarded)

```
that, this, with, have, from, they, will, what, when, more,
also, about, your, just, like, very, some, been, want, need,
feel, help, make, know, think, time, good, better, really
```

### Rules

- **Minimum word length:** > 3 characters (same as backend)
- **Storage cap:** 40 most-recent unique words (oldest trimmed automatically)
- **Persistence:** `localStorage` key `nms_interests` — survives page reload

### Triggers

| Action | Calls `addInterests`? |
|---|---|
| User types and sends a message | Yes |
| User clicks a quick-reply chip | Yes |

---

## 6. Proactive Notification System

**Backend:** `notificationService.js`
**Endpoint:** `GET /api/assistant/notifications?interests=sleep,stress&seen=1234,5678`
**Frontend:** `index.html → loadNotifications() + renderNotification()`

### Trigger

Notifications fire **once per browser session**, **6 seconds after the chat widget opens**.
Guard key: `sessionStorage` key `nms_notif_shown`.

### Notification types (returned in order)

#### Type 1 — `new_course`
Shown when a course was released within the **last 7 days** and matches user interests.

| Rule | Value |
|---|---|
| Recency window | 7 days from `created_at` |
| Matching | Keyword score > 0, OR show any new course if no interests recorded yet |
| Sort | Highest keyword score first |
| Social proof label | "🔥 X people joining this course" |
| Social proof number | Random integer **200 – 1800**, re-generated on every render |
| Dedup | Course ID recorded in `localStorage` key `nms_notified_ids` after display |

#### Type 2 — `popular_course`
Shown when a highly-rated unseen course matches user interests.

| Rule | Value |
|---|---|
| Minimum rating | ≥ 4.7 |
| Must not overlap | Cannot be the same course already shown as `new_course` |
| Matching | Keyword score + `rating × 0.1` bonus |
| Sort | Highest combined score first |
| Dedup | Same `nms_notified_ids` localStorage key |

#### Type 3 — `event`
Upcoming community event.

| Rule | Value |
|---|---|
| Status | **Placeholder — skipped when `event: null`** |
| Unblocked by | Backend team adding `/api/events/all-user` to Cloudflare WAF bypass rule (same `x-bot-key` pattern as courses) |

### Seen-course deduplication

- Frontend writes displayed course IDs to `localStorage` key `nms_notified_ids`.
- These IDs are passed as `?seen=…` on every notification request.
- Backend filters them out before scoring, so a course is never shown twice.

---

## 7. Events System

**File:** `backend/src/services/eventService.js`

Built and ready. Currently returns 403 because the Cloudflare WAF bypass rule covers
`/api/courses` but not `/api/events/all-user`.

**Unblock:** Ask backend team to extend the `x-bot-key` WAF rule to include `/api/events/all-user`.

### Events API call (when unblocked)

```
GET /api/events/all-user?per-page=100&page={n}&expand=thumb&sort=-id
Header: x-bot-key: <NMS_BOT_KEY>
```

---

## 8. Analytics Hook (Future)

`courseService.js` exports `updateAnalyticsScores(scores)`.

Call it with an object mapping `{ [courseId]: score }` where score represents
completion rate, engagement, or any custom signal. The weight in the scoring formula
is currently set to **0.0** and should be raised once data is available.

```js
import { updateAnalyticsScores } from "./courseService.js";
updateAnalyticsScores({ 101: 0.92, 204: 0.78 });
```

---

## 9. What to Build Next

Ideas to layer on top of this foundation:

- **Semantic matching** — replace keyword overlap with embedding similarity for better recall on paraphrased queries
- **Completion-rate weighting** — wire real analytics into `updateAnalyticsScores()` and raise the `popularity` weight from 0.0
- **Per-user seen history on the backend** — currently only tracked client-side; a server-side record would survive browser clears
- **Events notifications** — unblock the events endpoint (see §7) and the frontend `renderNotification` already handles them
- **Personalised greeting** — use stored interests on first open to pre-populate a context-aware welcome message
- **A/B test social proof numbers** — replace random range with a data-backed figure once course enrollment metrics are available
