# EmDash Learn (`@emdash/lms-core`)

Course publishing, knowledge checks, learning progress, and
privacy-preserving engagement reporting for
[EmDash](https://github.com/emdash-cms/emdash).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> [!IMPORTANT]
> EmDash Learn is pre-release. Its compatibility target is EmDash 0.32.0,
> which must publish the authenticated plugin-route principal before Learn can
> release. EmDash core ships first; Learn then updates its development lockfile,
> passes the clean-consumer release gates, and publishes.

## What Learn provides

- additive Course → Lesson setup using EmDash content collections;
- published-only catalog, course, and lesson projections;
- editor-authored knowledge checks with immutable published revisions;
- browser-local lesson progress and self-check results for anonymous visitors;
- immutable, concurrency-safe completion facts and server-graded Attempts for
  authenticated learners;
- engagement reporting whose event metrics preserve total, anonymous, and
  verified-account counts; and
- a canonical Astro Portable Text component for embedded knowledge checks.

EmDash core owns registration, account recovery, email verification, resend
flows, credentials, sessions, users, and roles. Learn never asks for a name,
email address, phone number, password, verification code, or caller-supplied
learner ID. Personalized routes derive an opaque learner identity only from
the authenticated principal supplied by EmDash.

## Progress and attempts

Anonymous and authenticated activity deliberately use different stores:

| Visitor state | Lesson progress                                           | Knowledge-check result                                   |
| ------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Anonymous     | Saved in that browser through the device progress store   | Self-graded and saved on that device; no account Attempt |
| Authenticated | Monotonic completion facts linked to the EmDash principal | Server-graded, immutable, concurrency-safe Attempt       |

Device progress can be reset, exported, and imported. After sign-in, completed
lesson IDs may be imported as account-linked `device_import` facts. Anonymous
self-check scores are never promoted to verified Attempts. Concurrent
completion and submission retries converge on one durable fact rather than
creating duplicate learning records.

## Knowledge-check block

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
`courseId` supplies the authored learning/reporting context, and public
operations verify that it identifies a published Course and matches the
authored Knowledge Check.

Astro sites can use the canonical component directly:

```astro
---
import { KnowledgeCheckBlock } from "@emdash/lms-core/astro";
---

<KnowledgeCheckBlock node={block} />
```

## Setup

The setup page calls the no-input `setup:run` route. The server—not the
browser—converges and verifies the Course/Lesson schema, repairs the published
content projection, and persists completion evidence. `setup:state` reports
that evidence. Setup preserves compatible unknown fields and never deletes
administrator-authored Course or Lesson content.

## Reporting and privacy

Reporting is best-effort: telemetry failure cannot fail content delivery,
grading, or progress writes. Public opens are directional browser
observations. Every successful self-grade request emits one submission
observation classified from the optional Core principal; authenticated retries
emit only for the newly durable Attempt. Completion observations likewise emit
only for newly durable facts.

Sites record Course and Lesson visits once when the corresponding page loads:

```ts
import { createLearnBrowserClient } from "@emdash/lms-core/browser";

const learn = createLearnBrowserClient({ storage: window.localStorage });

void learn.observeCourseOpened(courseId);
void learn.observeLessonOpened({ courseId, lessonId });
```

Call only the method for the page being rendered. Both observation methods are
deliberately fail-open: they always resolve, including when reporting is
rate-limited or unavailable, so analytics cannot interrupt navigation.

Every event metric and score band uses an `ActorCount` with `total`,
`anonymous`, and `verified` counts. `verifiedAccountDays` is separately the
sum of distinct authenticated accounts active within each UTC day. It is
additive across days and must not be interpreted as unique people.

Reporting aggregates exact retained observations at query time. Observations
use a fixed vocabulary, omit copied profile/contact data, and are retained for
90 days. Daily best-effort maintenance deletes only rows strictly older than
that window; no lossy or non-transactional rollup step is used.
`calculatedThrough` is the report snapshot time captured after the storage
read, not the latest visitor-activity timestamp.

The authenticated `privacy:erase-my-data` route removes that principal's
lesson completions, assessment Attempts, and attributable raw engagement
observations, so subsequent reports no longer include that attributable
activity. Site code can expose this through
`createLearnBrowserClient(...).eraseMyData()`; the host site owns the
learner-facing confirmation and recovery experience. Partial failures preserve
the route's `failedCategories` and per-category `deleted` counts on
`LearnBrowserApiError.details`.

## Compatibility

| Dependency        | Target      |
| ----------------- | ----------- |
| EmDash            | `^0.32.0`   |
| Astro             | `^6.0.0`    |
| React / React DOM | `^19.0.0`   |
| Node.js           | `>=22.12.0` |
| pnpm              | `10.x`      |

Learn runs as a native/trusted plugin because it contributes React admin pages
and an Astro renderer. The authoritative product boundary is in
[docs/product-scope.md](./docs/product-scope.md); the exact remaining release
work is tracked in
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
browser journey. It is development scaffolding, not authenticated release
evidence; the verified-account and privacy journeys must run through a native
host using the published EmDash 0.32.0 contract.

No stable Learn package has been published. See the release-readiness document
before treating the current worktree as consumable.

## License

MIT — see [LICENSE](./LICENSE).
