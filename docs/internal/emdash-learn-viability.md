# emdash-learn Viability Report

_Date: 2026-04-17 · Evaluator: grounded code read of `packages/core`, `packages/auth`, `packages/plugins`, `packages/x402`._
_Scope assumption (from the prompt's example list): courses, lessons, enrollments, progress, quizzes, certificates, roles, payments, cohorts, plus the obvious adjacent needs (notifications, discussions, media, learner-facing pages)._

## Executive summary

**Conditional go.** EmDash's plugin system is real and mature enough to host ~80% of an LMS without core changes. The remaining 20% (auto-provisioning `courses`/`lessons` as CMS collections, a distinct "instructor" role, and a user-signup hook) either requires modest upstream contributions or a narrower product scope. I would not start without deciding on those three items first.

- Plugin API is production-grade: sandboxed V8 isolates, capability enforcement, KV, indexed document storage, cron, email, routes with Zod validation, Block Kit admin UI (`packages/core/src/plugins/types.ts:394`, `:1222`).
- Native-format plugins unlock what we actually need for lesson editing: custom Portable Text blocks and React admin (`skills/creating-plugins/SKILL.md:11`, `:276`). That forces trusted mode, not sandboxed — a deployment tradeoff, not a blocker.
- Three hard gaps: no plugin API to register CMS content collections, no custom roles beyond the fixed 5-level ladder (`packages/auth/src/rbac.ts:9`, `packages/auth/src/types.ts:9`), and no `user:created` lifecycle hook (`packages/core/src/plugins/types.ts:957–995`).

## Plugin architecture

| Concern | Location | Notes |
|---|---|---|
| Plugin formats (standard vs native) | `skills/creating-plugins/SKILL.md:11–22` | Native needed for PT blocks + React admin |
| Plugin definition API | `packages/core/src/plugins/define-plugin.ts`, `types.ts:1222` | `definePlugin({ hooks, routes, storage, admin })` |
| Lifecycle + content + media + cron + email + comment + page hooks | `types.ts:957–995` | No user hooks |
| Capability model | `types.ts:25–37` | Enforced in sandbox via RPC bridge |
| Runtime + plugin manager | `packages/core/src/emdash-runtime.ts` (2416 LOC), `plugins/manager.ts` (633 LOC) | Real orchestration, not a stub |
| Sandbox isolation | Cloudflare Dynamic Worker Loader (`README.md:76–95`, `plugins/sandbox/`) | CF-only; Node fallback = trusted |
| Plugin storage | `types.ts:45–137`, `references/storage.md` | Document collections, single/composite indexes, unique, pagination, range/in/startsWith filters, no joins |
| Content API for plugins | `types.ts:244–262` | CRUD on **existing** collections, not creation |
| RBAC | `packages/auth/src/rbac.ts`, `types.ts:9–15` | 5 fixed roles (SUBSCRIBER … ADMIN) |
| Comments + moderation hooks | `types.ts:548–674` | Reusable for lesson discussions |
| Payments | `packages/x402/src/index.ts` (HTTP 402 crypto), or Stripe via `network:fetch` | No first-class card billing |
| Cron | `types.ts:442–459` | Per-plugin scheduled tasks |
| Email | `types.ts:488–547` | Pluggable provider, send/intercept/deliver |
| Admin UI | Block Kit (sandboxed) or React (native) — `types.ts:1099–1217`, `references/block-kit.md` | Sandboxed plugins cannot ship JS or Astro components |

## Feature → capability matrix

| LMS feature | emdash capability | Fit | Notes |
|---|---|---|---|
| Courses (content type) | core content collections; plugin CRUDs via `ctx.content` | Conditional | No plugin API creates collections. Either ship a setup wizard that calls admin APIs, or extend core (see Risk 1). |
| Lessons w/ rich body | Portable Text + custom blocks | Conditional (native) | Custom lesson blocks (video, quiz, embed) require native plugin — sandboxed can't ship PT blocks (`SKILL.md:146`). |
| Enrollments | plugin storage collection w/ composite index `[userId, courseId]` | Achievable | Straightforward CRUD + query. |
| Progress tracking | plugin storage + routes | Achievable | Index by `userId`, `lessonId`, `completedAt`. |
| Quiz data + attempts | plugin storage + routes | Achievable | |
| Quiz blocks inline in lessons | PT block contribution | Native only | Forces native/trusted plugin. |
| Certificates | cron + email + media upload + (PDF via external service w/ `network:fetch`) | Achievable | PDF rendering needs an external service or WASM lib in native mode. |
| Student role | existing `SUBSCRIBER` level | Native fit | |
| Instructor role | no distinct tier; share `EDITOR` or gate via plugin-owned membership records | Compromise | No custom role support. |
| Cohorts | plugin storage collection | Achievable | |
| Notifications / drip | cron + email + content hooks | Native fit | |
| Payments (card) | `network:fetch` → Stripe + public plugin route for webhooks | Achievable | Plugin routes are public-capable (`types.ts:1086`). |
| Payments (crypto micro) | `@emdash-cms/x402` | Native fit | Already integrated as a sibling package. |
| Discussions per lesson | core comments + `comment:*` hooks | Native fit | Moderation surface already built. |
| Video lesson storage | `ctx.media` + R2/S3 signed uploads (`types.ts:294–325`) | Achievable | External streaming (Mux, CF Stream) via `network:fetch`. |
| Learner-facing UI | Astro site code consuming plugin routes | Outside plugin | Plugins ship APIs + admin UI only; learner pages must be built in the Astro site (or as native-plugin Astro components). |
| Auto-provision student record on signup | — | **Not feasible without core change** | No user lifecycle hook. |

## Top 3 technical risks

1. **No `ctx.schema.registerCollection()`.** Plugins can't auto-create `courses`/`lessons` tables. Mitigations: (a) ship a setup route that calls the core schema admin API once the admin clicks install; (b) upstream a plugin-scoped collection-registration API; (c) fall back to plugin storage collections and give up the visual schema editor for lesson authoring.
2. **Role model is closed.** Adding "instructor" / "TA" / "auditor" requires either riding on `EDITOR` + plugin-side membership records, or upstreaming custom-role support. Mitigation: plugin-owned `course_instructors` collection + route middleware; design UX to not expose EmDash's 5-role picker to LMS admins.
3. **No `user:created` / `auth:afterSignup` hook.** Onboarding a new student into `enrollments` can't be triggered by the plugin alone. Mitigations: (a) have the host Astro site call a plugin route after signup; (b) poll via cron for users with no student record (ugly); (c) upstream a user lifecycle hook (cleanest, 1–2 day change).

## Rough effort per feature

| Feature | Size |
|---|---|
| Courses / lessons scaffold (assuming core PR lands) | M |
| Courses / lessons (shipped as pure plugin w/ setup wizard) | L |
| Enrollments + progress | M |
| Quiz data + attempts + grading | M |
| Quiz PT blocks (native) | L |
| Certificates (incl. PDF) | L |
| Stripe payments + webhooks | L |
| Cohorts | S |
| Notifications & drip | S |
| Discussions | S (reuse core comments) |
| Learner-facing templates (course player, lesson viewer, quiz taker) | L |
| Upstream core changes (schema API + user hook + optional custom roles) | L–XL |
| **MVP all-up** | **XL (3–6 eng-months solo)** |

## Open questions (must be resolved before starting)

1. Are you willing to ship 1–3 upstream PRs to emdash core (collection-register API, user lifecycle hook, optional custom-role support)? If no, MVP scope must shrink and UX will suffer.
2. Cloudflare-only deployment, or must we support Node/SQLite hosts? (Affects native-vs-sandboxed decision and plugin distribution story.)
3. Native plugin (trusted, React admin, PT blocks) vs. standard sandboxed (Block Kit only, marketplace-installable). You likely want **native** for lesson authoring — confirm.
4. Learner frontend: shipped as a starter template, as native-plugin Astro components, or left entirely to the site owner?
5. Payments scope: Stripe + invoicing, x402 crypto, both, or free-only for v1?
6. Video: R2 direct, Cloudflare Stream, or Mux?
7. Scale: expected concurrent learners and enrollment count? Plugin storage (indexed document store over D1/SQLite) is fine for ~100k rows; beyond that, validate with a load test before committing.
8. Auth flows: passkey-only (emdash default), or do learners need password fallback for B2B buyers?
9. Does "open source LMS" mean marketplace-installable (sandboxed constraint) or self-hosted-only (native is fine)?
