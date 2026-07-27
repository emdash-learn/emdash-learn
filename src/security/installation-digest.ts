import { DIGEST_SECRET_KEY } from "../kv-keys.js";
import { createKeyedDigest, generateDigestSecret, type KeyedDigest } from "./keyed-digest.js";

interface InstallationDigestReader {
	get(key: string): Promise<unknown>;
}

interface InstallationDigestWriter extends InstallationDigestReader {
	set(key: string, value: unknown): Promise<void>;
}

export class InstallationDigestError extends Error {
	readonly code = "LEARN_SETUP_INCOMPLETE";
	readonly status = 409;

	constructor(message: string) {
		super(message);
		this.name = "InstallationDigestError";
	}
}

function validateSecret(value: unknown): string {
	if (typeof value !== "string") {
		throw new InstallationDigestError(
			"Learn's installation digest secret is missing. Run the setup wizard.",
		);
	}
	try {
		createKeyedDigest(value);
	} catch {
		throw new InstallationDigestError(
			"Learn's installation digest secret is invalid. Repair the plugin setup.",
		);
	}
	return value;
}

export async function ensureInstallationDigestSecret(
	kv: InstallationDigestWriter,
): Promise<string> {
	const existing = await kv.get(DIGEST_SECRET_KEY);
	if (existing !== null && existing !== undefined) return validateSecret(existing);
	const created = generateDigestSecret();
	await kv.set(DIGEST_SECRET_KEY, created);
	return created;
}

export async function requireInstallationDigest(
	kv: InstallationDigestReader,
): Promise<KeyedDigest> {
	return createKeyedDigest(validateSecret(await kv.get(DIGEST_SECRET_KEY)));
}
