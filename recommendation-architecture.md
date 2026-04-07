# Recommendation Architecture

## Goal

Build a recommendation system that:

- uses a local weekly-synced catalog instead of hitting the main platform on every chat request
- understands user intent even when users describe needs in different words
- separates sales copy from recommendation logic
- avoids irrelevant recommendations caused by overloaded words like `pain`, `release`, `healing`, or `strength`
- returns only the final selected course cards, not raw retrieval candidates

## Core principle

Every course needs two representations:

1. Marketing representation
- title
- sales copy
- landing page excerpt
- emotional and conversion language

2. Recommendation representation
- normalized recommendation metadata used only for matching and ranking

The recommendation engine should search the second representation, not the first.

## Enriched course record

Each course should be stored in an enriched local index with the following fields.

### Source fields

- `id`
- `slug`
- `title`
- `author`
- `rating`
- `thumb`
- `lang`
- `created_at`
- `excerpt`

### Recommendation fields

- `recommendation_summary`
- `retrieval_text`
- `primary_domain`
- `secondary_domains`
- `primary_intent`
- `secondary_intents`
- `body_areas`
- `pain_type`
- `symptom_tags`
- `goal_tags`
- `context_tags`
- `modality_tags`
- `audience_tags`
- `life_stage_tags`
- `energy_level`
- `difficulty_level`
- `time_commitment`
- `safety_flags`
- `contraindication_flags`
- `exclusion_tags`
- `recommendation_priority`

### Search / ranking fields

- `embedding`
- `keyword_aliases`
- `freshness_score`
- `popularity_score`
- `completion_score`

## Controlled taxonomy

These should be small enums or tightly controlled lists.

### `primary_domain`

- `physical_recovery`
- `pain_relief`
- `stress_regulation`
- `sleep_support`
- `nutrition`
- `movement_fitness`
- `emotional_regulation`
- `trauma_support`
- `creativity_expression`
- `sexual_wellness`
- `spiritual_practice`
- `cognitive_focus`

### `pain_type`

- `physical`
- `emotional`
- `mixed`
- `none`

### `primary_intent`

- `mobility_recovery`
- `strength_building`
- `flexibility`
- `pain_relief_physical`
- `tension_release_physical`
- `stress_relief`
- `sleep_improvement`
- `emotional_release`
- `trauma_processing`
- `posture_support`
- `joint_support`
- `nervous_system_regulation`
- `creative_expression`
- `energy_support`

### `body_areas`

- `full_body`
- `knee`
- `hips`
- `spine`
- `neck`
- `shoulders`
- `pelvic_floor`
- `jaw`
- `feet`
- `core`
- `gut`
- `face`

### `context_tags`

- `post_surgery`
- `postpartum`
- `desk_worker`
- `beginner`
- `aging_50_plus`
- `high_stress`
- `low_energy`
- `chronic_tension`

### `exclusion_tags`

- `not_post_surgery`
- `not_physical_rehab`
- `not_children`
- `not_postpartum`
- `not_spiritual`
- `not_creative_therapy`

## Example of why this matters

User query:

`I want to restore knee strength and flexibility after surgery.`

Correct inferred intent:

- `primary_domain = physical_recovery`
- `primary_intent = mobility_recovery`
- `secondary_intents = ["strength_building", "flexibility"]`
- `body_areas = ["knee"]`
- `context_tags = ["post_surgery"]`
- `pain_type = physical`
- exclusions:
  - `not_spiritual`
  - `not_creative_therapy`
  - `not_emotional_release`

This should strongly down-rank courses whose sales copy talks about:

- emotional pain
- spiritual healing
- trauma release
- creative expression

even if they use overlapping words like `healing`, `strength`, or `release`.

## Weekly pipeline

### Step 1. Sync raw platform data

Source:

- `/api/courses`
- `/api/events/all-user`

Output:

- `backend/src/data/courses.raw.json`
- `backend/src/data/events.raw.json`

### Step 2. Enrich courses

For each course:

- normalize source fields
- generate recommendation metadata
- generate `retrieval_text`
- generate or attach embeddings
- write enriched records

Output:

- `backend/src/data/courses.enriched.json`

### Step 3. Build lightweight retrieval index

Optional but recommended:

- precompute body-area index
- precompute domain index
- precompute alias maps

Output:

- `backend/src/data/courses.index.json`

### Step 4. Refresh events

Events are time-sensitive, so keep the cache short.

Output:

- `backend/src/data/events.cache.json`

## Runtime chat flow

1. User sends chat message
2. Build intent profile from message + user profile
3. Retrieve candidate courses from enriched local index
4. Apply exclusions and safety filters
5. Re-rank candidates
6. Keep top 5 candidates internally
7. Ask the model to choose 1–2 from those candidates
8. Return only final selected course cards

The frontend should never render the whole candidate pool.

## Intent profile

At runtime, normalize the user request into a structured object like this:

```json
{
  "domains": ["physical_recovery"],
  "intents": ["mobility_recovery", "strength_building", "flexibility"],
  "body_areas": ["knee"],
  "pain_type": "physical",
  "context_tags": ["post_surgery"],
  "exclude_domains": ["spiritual_practice", "creativity_expression", "emotional_regulation"]
}
```

This profile can be produced by either:

- a small rules layer first
- then an LLM normalization step

That normalization call is much cheaper than sending the full course catalog every time.

## File-by-file implementation plan

### Keep and evolve

- `backend/src/services/chatService.js`
  - keep as orchestrator
  - stop returning raw retrieval candidates
  - return only final selected recommendations

- `backend/src/services/courseService.js`
  - replace current lexical matcher with hybrid retrieval

- `backend/src/services/eventService.js`
  - keep 72-hour gating
  - match only after enough user context exists

- `backend/src/data/mockData.js`
  - evolve into lightweight user-profile seed data until real user profile exists

### Add

- `backend/src/data/courses.raw.json`
  - raw synced course dump from platform

- `backend/src/data/courses.enriched.json`
  - enriched recommendation records

- `backend/src/data/events.raw.json`
  - raw synced events dump

- `backend/src/services/intentService.js`
  - converts user message into normalized intent profile

- `backend/src/services/rankingService.js`
  - scores and filters enriched course records

- `backend/src/services/recommendationSelectionService.js`
  - selects final 1–2 recommendations from top candidates

- `scripts/enrichCourses.js`
  - weekly enrichment step for course metadata

- `scripts/syncEvents.js`
  - fetch and cache events

### Update

- `scripts/syncCourses.js`
  - sync raw data only
  - do not overload it with recommendation logic

- `index.html`
  - render only selected cards
  - optionally show no cards if confidence is low

## Ranking strategy

Use weighted ranking, not simple keyword overlap.

Suggested weighting:

- hard filters
  - audience mismatch
  - contraindication mismatch
  - excluded domains

- semantic relevance
  - embedding similarity

- structured relevance
  - domain match
  - intent match
  - body area match
  - pain type match
  - context tag match

- soft ranking
  - popularity
  - completion
  - freshness

## Personalization layer

Keep a lightweight user profile separate from course data.

Recommended user fields:

- `completed_course_ids`
- `clicked_course_ids`
- `dismissed_course_ids`
- `recent_chat_topics`
- `saved_interests`
- `preferred_modalities`
- `preferred_duration`
- `preferred_energy_level`
- `subscription_state`
- `current_goal`

This should affect ranking, not replace intent detection.

## Events logic

Events should appear only when:

- the user has enough context for us to know relevance
- and the event begins within 72 hours

Suggested rule:

- no event recommendations in the first 1–2 shallow interactions unless explicitly requested
- allow event cards when:
  - user asks directly for events
  - or intent confidence is high
  - or a near-term event strongly matches the user profile

## What we can implement now

We have enough information to implement:

- enriched course schema
- intent normalization
- hybrid ranking
- final selection instead of raw candidate rendering

We do not yet have enough source metadata to get the best possible precision without enrichment.

That is fine. The enrichment layer is exactly what closes that gap.
