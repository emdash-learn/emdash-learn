const SECRET_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		throw new Error("The Learn digest secret is not valid base64url.");
	}
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	if (bytes.length !== SECRET_BYTES) {
		throw new Error(`The Learn digest secret must contain ${SECRET_BYTES} bytes.`);
	}
	return bytes;
}

export type KeyedDigest = (domain: string, value: string) => Promise<string>;

export function generateDigestSecret(): string {
	const bytes = new Uint8Array(SECRET_BYTES);
	crypto.getRandomValues(bytes);
	return toBase64Url(bytes);
}

export function createKeyedDigest(secret: string): KeyedDigest {
	const key = crypto.subtle.importKey(
		"raw",
		fromBase64Url(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const encoder = new TextEncoder();

	return async (domain, value) => {
		if (domain.length === 0) throw new Error("A digest domain is required.");
		const signature = await crypto.subtle.sign(
			"HMAC",
			await key,
			encoder.encode(`emdash-learn:v1:${domain}\u0000${value}`),
		);
		return toBase64Url(new Uint8Array(signature));
	};
}
