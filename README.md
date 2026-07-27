# EmDash Learn (`@emdash/lms-core`)

Course publishing, browser-local learning progress, knowledge checks, and
anonymous engagement reporting for
[EmDash](https://github.com/emdash-cms/emdash).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/emdash-learn/emdash-learn/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/emdash-learn/emdash-learn/actions/workflows/ci.yml)
[![CodeQL](https://github.com/emdash-learn/emdash-learn/actions/workflows/codeql.yml/badge.svg?branch=develop)](https://github.com/emdash-learn/emdash-learn/actions/workflows/codeql.yml)

> [!IMPORTANT]
> EmDash Learn is pre-release. Version 0.1 targets the currently published
> EmDash 0.31 plugin API and deliberately does not provide learner accounts or
> server-side learner records.

## What Learn provides

- additive Course → Lesson setup using EmDash content collections;
- published-only catalog, Course, and Lesson projections;
- editor-authored Knowledge Checks with immutable published revisions;
- deterministic, anonymous self-grading;
- browser-local Lesson completion and self-check summaries;
- anonymous aggregate engagement reporting; and
- a canonical Astro Portable Text component for embedded Knowledge Checks.

Learn does not create or manage users, roles, registration, verification,
credentials, or sessions. It does not collect names, email addresses, phone
numbers, passwords, or verification codes.

## Progress and self-checks

Lesson progress and Knowledge Check results are saved in the visitor's browser.
They are useful for a self-guided experience but are not durable account
records: they do not follow the visitor to another browser, and clearing site
storage removes them.

Public grading is deterministic and returns the result to the browser. Version
0.1 does not create server-side Attempts, import device progress, expose
learner history, or issue completion credentials.

## Knowledge Check block

The canonical Portable Text block is `learnKnowledgeCheck` and requires both
the containing Course and Knowledge Check identifiers:

```json
{
	"_type": "learnKnowledgeCheck",
	"courseId": "course_…",
	"checkId": "check_…"
}
```

`checkId` is the stable authored identity. Presentation resolves its current
published head and returns the exact immutable `revisionId` used for grading.
`courseId` supplies the authored learning and reporting context. Public
operations verify that the Course is published and matches the authored
Knowledge Check.

Astro sites can use the canonical component directly:

```astro
---
import { KnowledgeCheckBlock } from "@emdash/lms-core/astro";
---

<KnowledgeCheckBlock node={block} />
```

## Setup

The setup page calls the no-input `setup:run` route. The server converges and
verifies the Course and Lesson schema, repairs the published-content
projection, and persists setup evidence. `setup:state` reports that evidence.
Setup preserves compatible unknown fields and never deletes
administrator-authored Course or Lesson content.

## Reporting and privacy

Reporting is best-effort: telemetry failure cannot fail content delivery or
grading. Sites may record Course and Lesson visits once when a corresponding
page loads:

```ts
import { createLearnBrowserClient } from "@emdash/lms-core/browser";

const learn = createLearnBrowserClient({ storage: window.localStorage });

void learn.observeCourseOpened(courseId);
void learn.observeLessonOpened({ courseId, lessonId });
```

These methods deliberately fail open, including when reporting is rate-limited
or unavailable, so analytics cannot interrupt navigation.

Reports contain aggregate event totals, not unique visitors. Observations use
a fixed vocabulary and omit profile or contact data, raw answers, free text,
raw IP addresses, and full user agents. They are retained for at most 90 days
and aggregated exactly at query time. Daily best-effort maintenance deletes
rows strictly older than that window.

`calculatedThrough` is the report snapshot time captured after the storage
read, not the latest visitor-activity timestamp.

## Compatibility

| Dependency        | Target      |
| ----------------- | ----------- |
| EmDash            | `^0.31.1`   |
| Astro             | `^7.1.3`    |
| React / React DOM | `^19.0.0`   |
| Node.js           | `>=22.12.0` |
| pnpm              | `10.x`      |

Learn runs as a native/trusted plugin because it contributes React admin pages
and an Astro renderer. The authoritative product boundary is in
[docs/product-scope.md](./docs/product-scope.md); the current release gates
are tracked in
[docs/internal/release-readiness-2026-07-26.md](./docs/internal/release-readiness-2026-07-26.md).

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm test:e2e
```

The demo under `demos/simple` exercises the canonical block and anonymous
browser journey.

Account-linked progress is a future track. It must use the official EmDash
authenticated route context after
[emdash-cms/emdash#812](https://github.com/emdash-cms/emdash/issues/812)
lands; it is not emulated in version 0.1.

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the
Gitflow and Conventional Commits workflow, and [CHANGELOG.md](./CHANGELOG.md)
for published changes.

## License

MIT — see [LICENSE](./LICENSE).
