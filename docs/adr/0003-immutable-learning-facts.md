---
status: accepted
date: 2026-07-26
---

# Use immutable learning facts and separate reporting

## Context

EmDash plugin storage does not promise transactions or compare-and-swap. A
mutable “progress percentage,” mutable published check, or increment-in-place
analytics counter would make retries, partial failure, concurrent requests,
and repair ambiguous.

Learning records and reporting also have different correctness and privacy
requirements. A telemetry write must never decide whether content, grading, or
progress succeeds.

## Decision

Learn stores authoritative activity as immutable or deterministically keyed
facts:

- a Lesson Completion Fact is monotonic for one principal and Lesson;
- a Check Revision is an immutable publication snapshot;
- an Attempt is a server-graded immutable result for one principal,
  submission ID, and Check Revision; and
- a raw Engagement Observation is append-only until account erasure or its
  90-day retention cutoff.

Stable Knowledge Check heads point to immutable revisions. Course percentages
are folded from Completion Facts and the current published Lesson set.
Identical operation/submission retries converge; conflicting submission-ID
reuse is rejected.

Anonymous device progress is a separate browser-local snapshot. It may contain
Lesson IDs and self-check summaries, but it is not an account Learning Record.
Only eligible Lesson IDs import as `device_import` Completion Facts.

Reporting remains behind a best-effort seam. Opens are directional browser
observations. Each successful public self-grade request emits one submission
event, while account completion and submission retries emit only when they
create a new durable fact. Stored observations use redacted resource/outcome
fields and day-scoped keyed account pseudonyms. Reports aggregate the retained
observations exactly at query time, and daily maintenance removes expired rows.

`verifiedAccountDays` counts distinct authenticated account pseudonyms per UTC
day and sums those daily counts. It is neither a cross-day unique-account count
nor a unique-person count.

Privacy erasure removes the principal's Completion Facts, Attempts, and
attributable raw observations, removing them from subsequent reports.

## Consequences

- Publishing, grading, completion, and reporting can be retried and repaired
  without unsafe mutable counters.
- An Attempt continues to identify the exact revision it graded even after an
  editor republishes or archives a check.
- Raw submitted answers and free text do not need to be persisted.
- Reporting queries fold retained observations and expose
  `calculatedThrough` as a post-read report snapshot watermark, not a latest
  activity timestamp.
- Telemetry failures are logged and fail open for learning operations.
- Exact raw reporting is simpler and correct on Core's current storage API,
  but historical reporting is intentionally limited to 90 days.
