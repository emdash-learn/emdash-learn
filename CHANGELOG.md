# Changelog

All notable changes to `@emdash/lms-core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-04-18

Introduces **Emdash Learn**, an open-source LMS plugin for emdash.

### Added

**Content**

- `courses`, `lessons`, and `topics` content collections with rich Portable Text bodies, drafts, revisions, scheduling, SEO, and i18n.
- **Topics primitive** (ADR 0001): first-class `Course → Lesson → Topic` hierarchy mirroring LearnDash's `sfwd-topic` post type. Topics inherit drip from the parent lesson and have no free-preview flag; gated by per-topic `requires_previous` within the lesson.
- Inline quiz blocks via a custom Portable Text block type (native-plugin only).

**Learning engine**

- Enrollments, per-step progress with video resume, per-lesson drip gating (immediate + relative modes), sequential-lesson requirements, free-preview lessons.
- Step-aware progress: a single `step_progress` collection tracks both lesson-body and topic completion. Course completion now requires every published lesson AND every published topic to be complete.
- Server-graded quizzes with 4 question types (MCQ, multi-select, true/false, short-text), configurable time limits (hard/soft policy), optional randomization.
- Certificate records with unique verification codes; public `certificate:verify` endpoint.
- Cohorts with capacity hints and CSV email import.
- Multi-instructor course assignment (lead/co/ta) via plugin storage.
- Lesson-level discussions via emdash's built-in comments.

**Admin**

- React admin pages mounted at `/_emdash/admin/plugins/lms-core/`: teaching dashboard, course detail (7-tab layout), enrollment management, quiz authoring, cohort management, instructor assignments, settings.
- One-click setup wizard that provisions the Courses and Lessons content collections.
- Per-student progress drill-down across all their enrolled courses.

**Integrations**

- Reuses emdash's passkey/OAuth/magic-link auth; no plugin-side auth surface.
- Site-side routes documented for theme authors: `catalog`, `my-learning`, `curriculum`, `lesson`, `topic`, `progress:tick`/`complete`, `quiz:start`/`submit`, `certificates:mine`, `certificate:verify`.

### Deferred to v1.1+

- Payment integration (Stripe, x402).
- Certificate PDF rendering.
- Site-wide admin analytics UI.
- Standalone theme package (`@emdash/lms-theme`).
- Cohort CSV auto-invite.

### Requires

- `emdash >=0.5.0`, `astro ^6.0.0`, `react ^19.0.0`, Node 20+ or Cloudflare Workers (Dynamic Worker Loader disabled — this plugin runs in trusted/native mode).

### License

MIT.
