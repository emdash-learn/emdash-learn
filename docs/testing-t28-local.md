# Local smoke test — T28 (topics primitive)

A hands-on walkthrough to exercise the Course → Lesson → Topic hierarchy end-to-end in the `demos/simple` site. Assumes you are on `main` at commit `1aa9e69` or later and have `pnpm` on `PATH`.

## 0. Prep

```bash
cd /Users/baezor/dev/lms-core
pnpm install
pnpm build
```

`build` compiles the plugin once so the demo's `workspace:*` link picks up the new routes and admin pages.

## 1. Seed fresh demo data

```bash
cd demos/simple
rm -f data.db                 # nuke any prior state so the setup wizard runs cleanly
pnpm seed                     # runs migrations, provisions collections, inserts fixtures
```

Expected final line:

```
Seeded 4 courses, 14 lessons, 3 topics, 5 users, 5 enrollments, 1 quiz, 2 attempts, 1 certificate.
```

The 3 topics hang off **Components** (the third lesson of **Getting Started with React**).

## 2. Start the dev server

```bash
pnpm dev
```

Leave it running. All URLs below assume `http://localhost:4321`.

## 3. Sign in as an admin (dev bypass)

Passkeys can't be automated locally, so use:

```
http://localhost:4321/_emdash/api/auth/dev-bypass?redirect=/_emdash/admin
```

You land on the admin dashboard as `dev@emdash.local`.

---

## A. Admin-side checks (T28 new surface)

### A.1 Curriculum tree renders topics under lessons

1. Navigate to **Emdash Learn → Courses** in the left nav.
2. Open **Getting Started with React**.
3. Click the **Curriculum** tab.
4. Expand the **Components** lesson row.

**Expect:** three topic rows below it, in order — *JSX syntax*, *Props*, *Children*. The **Props** row shows a "requires previous" marker. Each topic row has edit / reorder / delete affordances.

### A.2 Create a new topic

1. In the curriculum tree, click **Add topic** on the **Components** row.
2. Fill in: title `Conditional rendering`, order `3`, a 1-sentence summary, a short Portable Text body.
3. Click **Save**.

**Expect:** redirect back to the curriculum tree; the new topic appears at the end of the Components lesson; no console errors.

### A.3 Edit the topic body

1. Click the pencil icon on **Conditional rendering**.
2. URL should be `/_emdash/admin/plugins/lms-core/courses/<courseId>/lessons/<lessonId>/topics/<topicId>`.
3. Change the summary, flip **Requires previous** on, save.

**Expect:** toast confirmation; returning to the curriculum view shows the updated summary and the "requires previous" marker.

### A.4 Reorder topics

1. In the curriculum tree, drag **Children** above **Props**.

**Expect:** order persists across a page reload; the student-side gating in §B.2 now reflects the new order.

### A.5 Delete guard — lesson with topics

1. Back on the curriculum, try to delete the **Components** lesson.

**Expect:** the request is rejected with a user-facing error explaining that the lesson still has topics. (This is the `contentBeforeDelete` hook from T28 §7.) Delete the topics first, then the lesson should delete cleanly.

### A.6 Per-student progress page

1. Nav: **Emdash Learn → Students**.
2. Pick **Alice Chen** (or whichever student has the most progress from the seed).
3. Open her progress for **Getting Started with React**.

**Expect:** Components row is expandable and shows per-topic completion rows (*JSX syntax*, *Props*, *Children*), each with a percent/complete indicator. Topics without a row yet render as *not started*.

---

## B. Student-side checks

Sign out of the dev-bypass session (clear the cookie or open an incognito window), then sign in as a student. Quickest path: re-use dev-bypass but visit `/my-learning` — Alice's enrollment is already seeded; the dev-bypass user can also enroll from `/catalog`.

> If you want a cleaner student view, run the demo in a private browser window and click **Enroll** from `/catalog` while signed in as the dev admin.

### B.1 Curriculum page shows nested topics

Visit `/courses/getting-started-with-react`.

**Expect:** a two-level tree. The **Components** lesson is expandable and shows three topic entries. Unlocked/locked states match the seeded enrollment (enrolled users see JSX syntax unlocked; Props locked until JSX syntax is complete).

### B.2 `requires_previous` gating on topics

1. Open **Components → JSX syntax** at `/courses/getting-started-with-react/lessons/<lessonSlug>/topics/react-jsx-syntax`.
2. Mark complete (trigger the progress:complete button, or scrub progress to 90% if the demo exposes a position control).
3. Go back; open **Props**.

**Expect:**
- Before completing JSX syntax: the Props link is locked and the UI shows a "complete the previous topic first" message.
- After completing JSX syntax: Props unlocks and its body renders normally.

### B.3 Lesson cascade — completing all topics auto-completes the lesson

1. With JSX syntax already complete, complete **Props**, then **Children**.

**Expect:**
- The **Components** lesson flips to *Complete* in the curriculum tree without any direct action on the lesson body (the seed lesson has no body, so the cascade is the only path to completion).
- Course progress percentage ticks up accordingly.

### B.4 Course completion requires all topics

Walk the remaining lessons to completion. When the last un-topicked lesson completes, the course should mark complete and issue a certificate.

**Expect:** `/certificates` shows a new entry for **Getting Started with React**. If you stop just short of completing any one topic, the course should stay at 99%/incomplete — this is the regression that T28's `evaluateCourseComplete` rewrite protects against.

### B.5 `my-learning` shows `nextStep` correctly

Visit `/my-learning`.

**Expect:** the "Continue learning" card points to the next incomplete step. If the next step is a topic (not a lesson), the card links directly to `/courses/.../lessons/.../topics/...`, not just to the lesson.

---

## C. Direct RPC smoke tests (optional but fast)

With the dev server running and a session cookie from dev-bypass, `curl` these to sanity-check the new routes. Replace `<topicId>` with an id from the seed (grab one from DevTools → Network during §A.1).

```bash
# Single topic body
curl -s -X POST http://localhost:4321/_emdash/api/plugins/lms-core/topic \
  -H "content-type: application/json" -H "cookie: $(your session cookie)" \
  --data '{"topicId":"<topicId>"}' | jq

# Tick progress on a topic
curl -s -X POST http://localhost:4321/_emdash/api/plugins/lms-core/progress:tick \
  -H "content-type: application/json" -H "cookie: ..." \
  --data '{"stepType":"topic","stepId":"<topicId>","positionSeconds":120,"percentComplete":50}' | jq

# Complete a topic
curl -s -X POST http://localhost:4321/_emdash/api/plugins/lms-core/progress:complete \
  -H "content-type: application/json" -H "cookie: ..." \
  --data '{"stepType":"topic","stepId":"<topicId>"}' | jq

# Curriculum response should now nest topics under the parent lesson
curl -s -X POST http://localhost:4321/_emdash/api/plugins/lms-core/curriculum \
  -H "content-type: application/json" -H "cookie: ..." \
  --data '{"courseId":"<courseId>"}' | jq '.data.lessons[] | {title, topics: (.topics // [] | map(.title))}'
```

**Expect:** every response is shaped `{ success: true, data: ... }`. Tick and complete return updated `step_progress` rows. Curriculum's `topics` key is an array (possibly empty) on every lesson entry.

---

## D. Localization + RTL spot checks

1. In the admin, open **Settings → Language** and switch to Spanish. Visit the curriculum tree and the topic edit page.

**Expect:** no hard-coded English leaks through. Every visible label, helper text, button, aria-label is translated.

2. Switch to **العربية (Arabic)**.

**Expect:** layout flips direction. Topic row affordances (edit / delete) land on the logical-end of the row, chevrons point the right way, no `left-*` / `right-*` class accidentally pins UI to the wrong side.

If anything looks wrong, that's a T28 regression — the admin strings added for topics were supposed to go through Lingui and use `ms-*` / `me-*` / `start-*` / `end-*`.

---

## E. Reset between runs

```bash
cd demos/simple
rm -f data.db && pnpm seed
```

Ctrl-C the dev server first (so it drops its SQLite handle), then re-run `pnpm dev`.

---

## What to report if something fails

For each breakage, capture:

- The URL and the action that triggered it.
- The expected vs observed behavior from this doc.
- Any console errors (browser devtools + the terminal running `pnpm dev`).
- The exact commit SHA you're on (`git rev-parse HEAD`).

Open a Discussion (or a fresh subagent task) referencing ADR 0001 and the failing section letter from this doc.
