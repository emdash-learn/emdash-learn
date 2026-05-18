/**
 * Admin settings routes (T24 / §16.8).
 *
 *   POST /_emdash/api/plugins/lms-core/admin:settings:get
 *     -> { settings, emailProvider: { configured, queued } }
 *
 *   POST /_emdash/api/plugins/lms-core/admin:settings:update
 *     { settings: Partial<SettingsShape> }
 *     -> { settings: SettingsShape }
 *
 *   POST /_emdash/api/plugins/lms-core/admin:test-email
 *     { to?: string }
 *     -> { ok: true, delivered: boolean, to: string }
 *
 * All three routes are ADMIN-only (emdash `Role.ADMIN = 50`). Settings live
 * under `ctx.kv` with the `settings:<name>` prefix (D4 / §16.8). Reads fall
 * back to `DEFAULT_SETTINGS` so an install that never ran the admin settings
 * form still returns a complete, typed shape.
 *
 * `admin:test-email` defers to `engine/email-queue.ts::send` — with a provider
 * it delivers inline; without one the message joins the `queue:email:*` queue
 * that §8.5's provider-detection UX surfaces. `delivered` distinguishes the
 * two outcomes so the admin UI can show a precise toast.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { type AuthContext, Role, requireRole } from "../authz.js";
import { DEFAULT_SETTINGS, LEARN_ERRORS, SETTING_KEYS, type SettingsShape } from "../constants.js";
import { send as sendEmail } from "../engine/email-queue.js";
import { settingKey } from "../kv-keys.js";
import { ensureSetupComplete } from "../setup-gate.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * Per-key schemas used for read-time validation in `readSettings`. Any value
 * that was written under a previous schema version and no longer parses
 * triggers a `log.warn` + fallback to `DEFAULT_SETTINGS[key]` (M10).
 */
const SETTINGS_VALUE_SCHEMAS: Record<keyof SettingsShape, z.ZodTypeAny> = {
	siteName: z.string().max(200),
	supportEmail: z.string().email().or(z.literal("")),
	defaultPassingScore: z.number().int().min(0).max(100),
	certificateExpiryDays: z.number().int().positive().nullable(),
	dripMode: z.enum(["immediate", "relative"]),
	commentGateRequiresEnrollment: z.boolean(),
};

/**
 * Every key in `SettingsShape` is optional on write so admins can PATCH one
 * field without echoing the others. `strict()` rejects unknown keys so a
 * rogue payload can't write arbitrary KV entries through this route.
 */
const settingsPatchSchema = z
	.object({
		siteName: z.string().max(200).optional(),
		supportEmail: z.string().email().or(z.literal("")).optional(),
		defaultPassingScore: z.number().int().min(0).max(100).optional(),
		certificateExpiryDays: z.number().int().positive().nullable().optional(),
		dripMode: z.enum(["immediate", "relative"]).optional(),
		commentGateRequiresEnrollment: z.boolean().optional(),
	})
	.strict();

export const settingsUpdateInput = z.object({
	settings: settingsPatchSchema,
});
export type SettingsUpdateInput = z.infer<typeof settingsUpdateInput>;

export const testEmailInput = z.object({
	to: z.string().email().optional(),
});
export type TestEmailInput = z.infer<typeof testEmailInput>;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface EmailProviderStatus {
	configured: boolean;
	queued: number;
}

export interface SettingsGetResponse {
	settings: SettingsShape;
	emailProvider: EmailProviderStatus;
}

export interface SettingsUpdateResponse {
	settings: SettingsShape;
}

export interface TestEmailResponse {
	ok: true;
	/** `true` when a provider was configured and accepted the message inline. */
	delivered: boolean;
	to: string;
}

// ---------------------------------------------------------------------------
// Error → HTTP mapping (§17.6)
// ---------------------------------------------------------------------------

function statusForCode(code: string): number {
	switch (code) {
		case LEARN_ERRORS.UNAUTHENTICATED:
			return 401;
		case LEARN_ERRORS.FORBIDDEN:
			return 403;
		default:
			return 400;
	}
}

function toRouteError(code: string, message: string): PluginRouteError {
	return new PluginRouteError(code, message, statusForCode(code));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readSettings(ctx: AuthContext): Promise<SettingsShape> {
	const pairs = await Promise.all(
		SETTING_KEYS.map(async (name) => {
			const stored = await ctx.kv.get(settingKey(name));
			if (stored === null) return [name, DEFAULT_SETTINGS[name]] as const;
			const parsed = SETTINGS_VALUE_SCHEMAS[name].safeParse(stored);
			if (!parsed.success) {
				ctx.log.warn(
					`settings: stored value for "${name}" failed validation; reverting to default`,
				);
				return [name, DEFAULT_SETTINGS[name]] as const;
			}
			return [name, parsed.data as SettingsShape[typeof name]] as const;
		}),
	);
	return Object.fromEntries(pairs) as SettingsShape;
}

async function countQueuedEmails(ctx: AuthContext): Promise<number> {
	const entries = await ctx.kv.list("queue:email:");
	return entries.length;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const getRoute: PluginRoute<unknown> = {
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.ADMIN);
		if (!user.ok) throw toRouteError(user.error.code, user.error.message);

		const [settings, queued] = await Promise.all([readSettings(auth), countQueuedEmails(auth)]);
		const response: SettingsGetResponse = {
			settings,
			emailProvider: { configured: Boolean(auth.email), queued },
		};
		return response;
	},
};

const updateRoute: PluginRoute<SettingsUpdateInput> = {
	input: settingsUpdateInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.ADMIN);
		if (!user.ok) throw toRouteError(user.error.code, user.error.message);

		const { settings: patch } = ctx.input;
		const entries = Object.entries(patch) as Array<
			[keyof SettingsShape, SettingsShape[keyof SettingsShape]]
		>;
		await Promise.all(
			entries.map(([key, value]) =>
				value === undefined ? Promise.resolve() : auth.kv.set(settingKey(key), value),
			),
		);

		const settings = await readSettings(auth);
		const response: SettingsUpdateResponse = { settings };
		return response;
	},
};

const testEmailRoute: PluginRoute<TestEmailInput> = {
	input: testEmailInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.ADMIN);
		if (!user.ok) throw toRouteError(user.error.code, user.error.message);

		const to = ctx.input.to ?? user.data.email;
		const settings = await readSettings(auth);
		const from = settings.siteName || "Emdash Learn";
		const delivered = Boolean(auth.email);

		await sendEmail(auth, {
			to,
			subject: `${from}: test email`,
			text:
				`This is a test email from ${from}.\n\n` +
				"If you received this, your email provider is configured correctly.\n",
		});

		const response: TestEmailResponse = { ok: true, delivered, to };
		return response;
	},
};

export const adminSettingsRoutes = {
	"admin:settings:get": getRoute,
	"admin:settings:update": updateRoute,
	"admin:test-email": testEmailRoute,
} as const;
