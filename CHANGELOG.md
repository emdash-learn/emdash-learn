# Changelog

## 0.1.2

### Patch Changes

- dba6172: Refresh release validation with Astro 7.1.4 and `@astrojs/check` 0.9.10.

## 0.1.1

### Patch Changes

- 147023f: Replace the pre-release README with current installation, setup, public API,
  browser progress, Knowledge Check, reporting, compatibility, and contributor
  guidance.
- 0d25b1a: Set the package homepage and public README to the official EmDash Learn website
  at `https://emdashlearn.com/`.

All notable changes to `@emdashlms/plugin` are documented in this file.

Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and
entries use the user-facing clarity encouraged by
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version entries are
generated from `.changeset/` by `pnpm release:version`.

## 0.1.0

### Minor Changes

- 5cfaac5: Introduce EmDash Learn, an open-source Course publishing and self-guided
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

  Requires EmDash `^0.31.1`, Astro `^7.1.3`, React/React DOM `^19.0.0`, and Node
  22.12 or newer.
