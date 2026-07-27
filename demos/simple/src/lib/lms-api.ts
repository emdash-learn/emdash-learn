/** Tiny server-side helper for the plugin's public routes. */

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
	return typeof value === "object" && value !== null && Reflect.has(value, "data");
}

function isFailure(value: unknown): value is EmdashErrorEnvelope {
	if (typeof value !== "object" || value === null || !Reflect.has(value, "error")) return false;
	const error = Reflect.get(value, "error");
	return (
		typeof error === "object" &&
		error !== null &&
		typeof Reflect.get(error, "code") === "string" &&
		typeof Reflect.get(error, "message") === "string"
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

/** Extract plain paragraphs from the subset of Portable Text used by the demo. */
export function portableTextParagraphs(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const paragraphs: string[] = [];
	for (const block of value) {
		if (typeof block !== "object" || block === null) continue;
		const children = Reflect.get(block, "children");
		if (!Array.isArray(children)) continue;
		const text = children
			.map((child) => {
				if (typeof child !== "object" || child === null) return "";
				const childText = Reflect.get(child, "text");
				return typeof childText === "string" ? childText : "";
			})
			.join("")
			.trim();
		if (text) paragraphs.push(text);
	}
	return paragraphs;
}
