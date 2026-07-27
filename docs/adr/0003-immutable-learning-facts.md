---
status: partially-accepted
date: 2026-07-26
---

# Use immutable learning facts and separate reporting

> Version 0.1 applies this decision to immutable Knowledge Check revisions and
> retained anonymous observations. Account Completion Facts, Attempts,
> attributable reporting, and privacy erasure belong to the deferred account
> track.

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

The deferred account design proposed day-scoped actor pseudonyms and
account-owned privacy erasure. Neither mechanism is part of the anonymous 0.1
reporting contract.

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
