/**
 * Tiny server-side helper the Astro pages use to call the plugin's public
 * routes. Mirrors the CSRF + cookie passthrough the admin api-client does
 * in the browser, minus the typed wrappers — demo pages only need the
 * shape-agnostic `call` function.
 */

const PLUGIN_PREFIX = "/_emdash/api/plugins/lms-core";

export interface LmsApiError {
	status: number;
	code: string;
	message: string;
}

export interface LmsApiResult<T> {
	ok: boolean;
	data?: T;
	error?: LmsApiError;
}

interface EmdashErrorEnvelope {
	error: { code: string; message: string };
}

interface EmdashSuccessEnvelope<T> {
	data: T;
}

function isSuccess<T>(value: unknown): value is EmdashSuccessEnvelope<T> {
	return (
		typeof value === "object" && value !== null && "data" in (value as Record<string, unknown>)
	);
}

function isFailure(value: unknown): value is EmdashErrorEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		"error" in (value as Record<string, unknown>) &&
		typeof (value as { error?: unknown }).error === "object"
	);
}

export interface CallOptions {
	/** Forwarded so SSR-side fetches share the caller's session cookie. */
	cookie?: string | null;
	/** Forwarded so server-side fetch hits the correct origin. */
	origin?: string;
}

export async function callLmsRoute<T = unknown>(
	route: string,
	input: unknown,
	opts: CallOptions = {},
): Promise<LmsApiResult<T>> {
	const base = opts.origin ?? "";
	const url = `${base}${PLUGIN_PREFIX}/${route}`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
		"X-EmDash-Request": "1",
	};
	if (opts.cookie) headers.Cookie = opts.cookie;

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(input ?? {}),
		});
	} catch (err) {
		return {
			ok: false,
			error: {
				status: 0,
				code: "NETWORK_ERROR",
				message: err instanceof Error ? err.message : String(err),
			},
		};
	}

	const text = await res.text();
	let parsed: unknown = null;
	if (text.length > 0) {
		try {
			parsed = JSON.parse(text);
		} catch {
			return {
				ok: false,
				error: {
					status: res.status,
					code: "MALFORMED_RESPONSE",
					message: "Server returned non-JSON",
				},
			};
		}
	}

	if (!res.ok) {
		if (isFailure(parsed)) {
			return {
				ok: false,
				error: { status: res.status, code: parsed.error.code, message: parsed.error.message },
			};
		}
		return {
			ok: false,
			error: {
				status: res.status,
				code: "HTTP_ERROR",
				message: `Request failed (${res.status})`,
			},
		};
	}

	if (!isSuccess<T>(parsed)) {
		return {
			ok: false,
			error: {
				status: res.status,
				code: "MALFORMED_RESPONSE",
				message: "Response envelope missing `data`",
			},
		};
	}
	return { ok: true, data: parsed.data };
}

export function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
