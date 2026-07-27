---
"@emdash/lms-core": minor
---

Introduce EmDash Learn, an open-source Course publishing and self-guided
learning plugin for EmDash.

- Add convergent, server-verified `setup:run` provisioning for Course and
  Lesson content collections and the published-content projection.
- Expose allowlisted, published-only catalog, Course, and Lesson routes.
- Add Course-bound, editor-authored Knowledge Check drafts, four question
  types, immutable published revisions, archive, redacted presentation, and
  deterministic grading.
- Add the `learnKnowledgeCheck` Portable Text block with required `courseId`
  and `checkId` fields, plus the canonical `KnowledgeCheckBlock` Astro export.
- Save Lesson completion and self-check summaries in bounded browser-local
  progress without creating an account record.
- Add best-effort aggregate reporting for anonymous Course, Lesson, and
  Knowledge Check activity, with exact retained-event aggregation and a
  calculation watermark.
- Retain redacted observations for 90 days and run daily best-effort pruning
  without relying on a non-transactional aggregate rollup.
- Add exact static admin pages for overview, Knowledge Check authoring,
  reporting, and setup.
- Collect no name, email address, phone number, password, verification code,
  or other profile data.

Requires EmDash `^0.31.1`, Astro `^6.0.0`, React/React DOM `^19.0.0`, and Node
22.12 or newer.
