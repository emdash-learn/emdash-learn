/**
 * Typed KV-key helpers. Every plugin-owned KV key originates here so no engine
 * module builds prefixes inline. Namespaces follow emdash convention:
 *
 *   `settings:*`  — admin-configurable preferences (surfaced in UI)
 *   `state:*`     — internal plugin state (hidden from admin UI)
 *   `handled:*`   — event-bus idempotency markers (30-day TTL per D23)
 *   `queue:*`     — email queue entries drained by flush-email-queue cron
 *   `notified:*`  — per-(lesson,user) drip-release email dedupe
 */

export const BOOTSTRAP_STATE_KEY = "state:bootstrap";

export const settingKey = (name: string): string => `settings:${name}`;

export const handledKey = (handlerId: string, eventKey: string): string =>
	`handled:${handlerId}:${eventKey}`;

export const emailQueueKey = (id: string): string => `queue:email:${id}`;

export const dripNotifiedKey = (lessonId: string, userId: string): string =>
	`notified:${lessonId}:${userId}`;
