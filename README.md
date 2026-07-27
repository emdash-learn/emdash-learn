# EmDash Learn

Turn published EmDash content into self-guided courses with lessons, knowledge
checks, browser-local progress, and privacy-conscious engagement reports.

[![npm version](https://img.shields.io/npm/v/%40emdashlms%2Fplugin.svg)](https://www.npmjs.com/package/@emdashlms/plugin)
[![CI](https://github.com/emdash-learn/emdash-learn/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/emdash-learn/emdash-learn/actions/workflows/ci.yml)
[![CodeQL](https://github.com/emdash-learn/emdash-learn/actions/workflows/codeql.yml/badge.svg?branch=develop)](https://github.com/emdash-learn/emdash-learn/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

EmDash Learn is an open-source plugin for
[EmDash CMS](https://github.com/emdash-cms/emdash). The current `0.1` line
provides a complete anonymous learning flow:

- editors publish Courses and ordered Lessons with EmDash;
- editors create and publish Course-bound Knowledge Checks;
- visitors browse published content and grade self-checks;
- Lesson completion and the latest self-check result stay in the visitor's
  browser; and
- administrators review anonymous aggregate activity without building a
  learner database.

> [!NOTE]
> EmDash Learn is an independent, community-maintained project. It is not
> published by or affiliated with the `emdash-cms` GitHub or npm organization.

## Quick start

### 1. Install the plugin

Add Learn to an existing EmDash `0.31` project:

```bash
pnpm add @emdashlms/plugin
```

The package is also available through npm:

```bash
npm install @emdashlms/plugin
```

### 2. Register it with EmDash

Add `lmsCorePlugin()` to the plugins in your Astro configuration:

```js
// astro.config.mjs
import react from "@astrojs/react";
import { lmsCorePlugin } from "@emdashlms/plugin";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			plugins: [lmsCorePlugin()],
		}),
	],
});
```

The npm package is `@emdashlms/plugin`; its stable EmDash runtime ID is
`lms-core`. That ID appears in plugin admin URLs, storage, and the route prefix.

### 3. Run Learn setup

Start the site, sign in to the EmDash admin, and open **Learn → Setup**. Run the
setup once to:

- create or converge the `courses` and `lessons` content collections;
- install Learn's additive fields without deleting compatible custom fields;
- build the published-content projection; and
- verify the installation before public routes become available.

Setup is idempotent. Running it again repairs missing compatible schema or
projection state while preserving authored Course and Lesson content.

### 4. Publish learning content

Use the EmDash content editor to create and publish Courses and Lessons. Then
open **Learn → Knowledge checks** to create, preview, and publish a Knowledge
Check for a Course.

Learn adds four admin destinations:

| Page             | Purpose                                              |
| ---------------- | ---------------------------------------------------- |
| Learn            | Installation and content overview                    |
| Knowledge checks | Draft, publish, archive, and manage self-checks      |
| Reports          | Query anonymous activity, pass rate, and score bands |
| Setup            | Converge and verify the Course/Lesson schema         |

## Build the public learning experience

Learn supplies the content and assessment APIs, browser client, and Astro
Knowledge Check component. Your site owns its URLs and presentation, so it can
fit an existing theme instead of adopting a plugin-controlled frontend.

The public API uses EmDash's POST-only plugin-route transport:

```ts
const LEARN_API = "/_emdash/api/plugins/lms-core";

export async function callLearn<T>(origin: string, route: string, input: unknown): Promise<T> {
	const response = await fetch(`${origin}${LEARN_API}/${route}`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
		},
		body: JSON.stringify(input),
	});

	if (!response.ok) {
		throw new Error(`Learn route ${route} failed (${response.status}).`);
	}

	const payload = (await response.json()) as { data: T };
	return payload.data;
}
```

For example, an Astro catalog page can load published Courses like this:

```astro
---
import { callLearn } from "../lib/learn-api";

interface CourseSummary {
	id: string;
	slug: string | null;
	title: string;
	description?: string;
}

const page = await callLearn<{ items: CourseSummary[]; hasMore: boolean }>(
	Astro.url.origin,
	"catalog",
	{ limit: 24 },
);
---

<ul>
	{page.items.map((course) => (
		<li><a href={`/courses/${course.slug}`}>{course.title}</a></li>
	))}
</ul>
```

Only published, currently visible content is returned. Draft, scheduled,
trashed, orphaned, and stale Course or Lesson records stay private.

### Public routes

| Route                   | Input summary                                                |
| ----------------------- | ------------------------------------------------------------ |
| `catalog`               | Cursor, limit, search, and optional difficulty               |
| `course:get`            | Exactly one of `courseId` or `slug`                          |
| `lesson:get`            | `lessonId`                                                   |
| `assessment:present`    | Published `courseId` and `checkId`                           |
| `assessment:self-grade` | Presented revision plus validated answers                    |
| `engagement:observe`    | A fixed Course, Lesson, or Knowledge Check observation event |

See the working
[Astro demo](./demos/simple) for catalog, Course, Lesson, device-progress, and
Knowledge Check pages.

## Browser-local progress

The browser client records Lesson completion locally and exposes the current
device snapshot:

```ts
import { createLearnBrowserClient } from "@emdashlms/plugin/browser";

const learn = createLearnBrowserClient({
	storage: window.localStorage,
});

await learn.completeLesson({
	courseId: "course_123",
	lessonId: "lesson_456",
});

const progress = learn.deviceProgress.getCourse("course_123");
console.log(progress?.completedLessonIds);
```

The store also supports `resetCourse`, `resetAll`, `exportSnapshot`, and
`importSnapshot`. Data is schema-validated, bounded, and stored under
`emdash-learn:device-progress:v1`.

This progress is intentionally not an account record. It does not synchronize
between devices, and clearing site storage removes it.

## Knowledge Checks

Published Knowledge Checks use immutable revisions. The browser receives no
answer key, submits answers against the exact presented revision, and stores
only the latest score summary locally.

The Portable Text block shape is:

```json
{
	"_type": "learnKnowledgeCheck",
	"courseId": "course_123",
	"checkId": "check_456"
}
```

Render it directly in Astro:

```astro
---
import { KnowledgeCheckBlock } from "@emdashlms/plugin/astro";
---

<KnowledgeCheckBlock node={block} />
```

The component loads the published check, renders its questions, submits the
self-grade request, shows explanations, and saves the result in device
progress. Grading still works if browser storage or reporting is unavailable.

## Anonymous reporting

Record directional Course and Lesson activity from public pages:

```ts
import { createLearnBrowserClient } from "@emdashlms/plugin/browser";

const learn = createLearnBrowserClient({ storage: window.localStorage });

void learn.observeCourseOpened(courseId);
void learn.observeLessonOpened({ courseId, lessonId });
```

Observation calls are best-effort and always resolve, so analytics cannot
interrupt navigation. Successful public self-grades add an anonymous
submission observation automatically.

Reports contain event totals, pass rate, and score bands for an exact UTC date
range, optionally filtered by Course. They are not unique-visitor, user, or
session analytics.

Learn does not persist names, contact information, EmDash user IDs, raw
answers, free text, raw IP addresses, or full user agents in reporting rows.
Redacted observations are retained for at most 90 days.

## What version 0.1 does not do

Learn `0.1` does not provide:

- signup, sign-in, email verification, credentials, users, or roles;
- account-linked or synchronized learning progress;
- server-side attempts or learner history;
- enrollment, cohorts, assignments, due dates, or certificates;
- instructor grading, payments, messaging, or notifications; or
- learner profiles or unique-user analytics.

Account-linked learning is a future track. It will use an official published
EmDash authenticated plugin-route contract rather than browser-supplied
identity.

## Package exports

| Export                      | Use                                                |
| --------------------------- | -------------------------------------------------- |
| `@emdashlms/plugin`         | `lmsCorePlugin()` build-time descriptor            |
| `@emdashlms/plugin/sandbox` | EmDash runtime, routes, hooks, and storage         |
| `@emdashlms/plugin/admin`   | React admin-page registry                          |
| `@emdashlms/plugin/astro`   | Astro `KnowledgeCheckBlock` and block components   |
| `@emdashlms/plugin/browser` | Browser client and versioned device-progress store |

## Compatibility

| Dependency              | Supported version |
| ----------------------- | ----------------- |
| EmDash                  | `^0.31.1`         |
| `@emdash-cms/blocks`    | `^0.31.1`         |
| Astro                   | `^7.1.3`          |
| React and React DOM     | `^19.0.0`         |
| Node.js                 | `>=22.12.0`       |
| pnpm for this workspace | `10.x`            |

Learn is a native/trusted plugin because it contributes React admin pages and
an Astro component renderer.

## Development

```bash
git clone https://github.com/emdash-learn/emdash-learn.git
cd emdash-learn
pnpm install
pnpm check
pnpm test:e2e
```

Run the included demo:

```bash
pnpm --filter @emdash-learn/demo-simple seed
pnpm --filter @emdash-learn/demo-simple dev
```

Before contributing, read [CONTRIBUTING.md](./CONTRIBUTING.md) for the Gitflow,
Conventional Commits, Changesets, testing, and privacy rules. See
[CHANGELOG.md](./CHANGELOG.md) for published changes and
[SECURITY.md](./SECURITY.md) for private vulnerability reporting.

Questions and ideas belong in
[GitHub Discussions](https://github.com/emdash-learn/emdash-learn/discussions);
reproducible bugs belong in
[GitHub Issues](https://github.com/emdash-learn/emdash-learn/issues).

## License

[MIT](./LICENSE)
