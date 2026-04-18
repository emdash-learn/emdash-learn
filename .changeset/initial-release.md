---
"@emdash/lms-core": major
---

Introduces **Emdash Learn**, an open-source LMS plugin for emdash.

**Content:**

- `courses` and `lessons` content collections with rich Portable Text bodies, drafts, revisions, scheduling, SEO, and i18n.
- Inline quiz blocks via a custom Portable Text block type (native-plugin only).

**Learning engine:**

- Enrollments, per-lesson progress with video resume, per-lesson drip gating (immediate + relative modes), sequential-lesson requirements, free-preview lessons.
- Server-graded quizzes with 4 question types (MCQ, multi-select, true/false, short-text), configurable time limits (hard/soft policy), optional randomization.
- Certificate records with unique verification codes; public `certificate:verify` endpoint.
- Cohorts with capacity hints and CSV email import.
- Multi-instructor course assignment (lead/co/ta) via plugin storage.
- Lesson-level discussions via emdash's built-in comments.

**Admin:**

- React admin pages mounted at `/_emdash/admin/plugins/lms-core/`: teaching dashboard, course detail (7-tab layout), enrollment management, quiz authoring, cohort management, instructor assignments, settings.
- One-click setup wizard that provisions the Courses and Lessons content collections.
- Per-student progress drill-down across all their enrolled courses.

**Integrations:**

- Reuses emdash's passkey/OAuth/magic-link auth; no plugin-side auth surface.
- Site-side routes documented for theme authors: `catalog`, `my-learning`, `curriculum`, `lesson`, `progress:tick`/`complete`, `quiz:start`/`submit`, `certificates:mine`, `certificate:verify`.

**Deferred to v1.1+:** payment integration (Stripe, x402), certificate PDF rendering, site-wide admin analytics UI, standalone theme package (`@emdash/lms-theme`), cohort CSV auto-invite.

**Requires:** `emdash >=0.5.0`, `astro ^6.0.0`, `react ^19.0.0`, Node 20+ or Cloudflare Workers (Dynamic Worker Loader disabled — this plugin runs in trusted/native mode).

**License:** MIT.
