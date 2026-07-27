# EmDash Learn terminology

This document defines the language used by the version 0.1 product and its
public interfaces.

## Content and assessment

**Course**

A published learning program containing an ordered set of Lessons.  
_Avoid_: Class, curriculum

**Lesson**

The smallest authored Course step represented in browser-local progress.
_Avoid_: Topic, module

**Knowledge Check**

An editor-owned, Course-bound assessment identity with one editable Draft and
one current published head.
_Avoid_: Quiz record

**Check Revision**

An immutable published snapshot of a Knowledge Check, including its questions,
answer key, and passing score. Presentation and grading use the exact
`revisionId`.
_Avoid_: Mutable quiz

**Knowledge Check Block**

The `learnKnowledgeCheck` Portable Text block. It carries the authored
`courseId` and stable `checkId` and renders through the canonical
`KnowledgeCheckBlock` Astro export.
_Avoid_: `lmsQuiz`, `quizId`

**Self-check**

Deterministic public grading whose optional result is saved only in
browser-local progress. It creates no server-side learner record.
_Avoid_: Attempt, credential

## Browser-local progress

**Device Progress**

Completed Lesson IDs and self-check summaries stored in one browser. It may be
reset or exported by the host site. It is not an account, does not synchronize
between devices, and is lost when site storage is cleared.
_Avoid_: Learner record, verified progress

Version 0.1 has no Learn user, learner profile, Attempt, Completion Fact,
device-to-account import, or privacy-erasure route. EmDash users and roles are
outside the plugin's interface.

## Setup

**Setup Run**

The no-input `setup:run` operation. The server converges and verifies the
Course and Lesson schema, repairs the publication projection, and persists
server-derived setup evidence.
_Avoid_: Browser-declared setup completion

## Reporting and privacy

**Engagement Observation**

A redacted anonymous event from a fixed vocabulary. Course, Lesson, and
Knowledge Check opens are directional browser observations. Each successful
self-grade request emits one submission observation.
_Avoid_: Unique visitor, arbitrary analytics payload

**Aggregate Event Count**

The number of retained observations matching an event and report range. It is
not a count of people, accounts, or sessions.
_Avoid_: Unique users

**Retained Observation**

A redacted event kept for at most 90 days and aggregated exactly at query
time. Daily maintenance deletes observations strictly older than the retention
cutoff.
_Avoid_: Permanent visitor history

**Calculation Watermark (`calculatedThrough`)**

The report snapshot time captured after the observation storage read. It is
present for an empty real report and is not the latest activity timestamp.
_Avoid_: Last activity time

Reporting stores no copied profile data, contact data, raw answers, free text,
raw IP addresses, or full user agents.

## Future account track

Account-linked learning records are intentionally deferred. If EmDash exposes
authenticated users to plugin routes, future work must consume the official
`ctx.user.id` contract tracked by
[emdash-cms/emdash#812](https://github.com/emdash-cms/emdash/issues/812).
The preserved prototype is an implementation candidate, not a version 0.1
contract.
