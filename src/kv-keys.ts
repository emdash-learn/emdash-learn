/**
 * Typed KV-key helpers. Every plugin-owned KV key originates here so no engine
 * module builds prefixes inline. Namespaces follow emdash convention:
 *
 *   `settings:*`  — admin-configurable preferences (surfaced in UI)
 *   `state:*`     — internal plugin state (hidden from admin UI)
 *   `queue:*`     — email queue entries drained by flush-email-queue cron
 *   `notified:*`  — per-(lesson,user) drip-release email dedupe
 *
 * Note: the `handled:*` namespace (event-bus idempotency markers) has been
 * removed along with the event bus (AUDIT C1, Track C). Idempotency for
 * lifecycle emails is now stamped directly on enrollment rows via
 * `welcomeSentAt` / `completionSentAt` fields (src/types/storage.ts).
 */

export const BOOTSTRAP_STATE_KEY = "state:bootstrap";

export const settingKey = (name: string): string => `settings:${name}`;

export const emailQueueKey = (id: string): string => `queue:email:${id}`;

export const dripNotifiedKey = (lessonId: string, userId: string): string =>
	`notified:${lessonId}:${userId}`;
