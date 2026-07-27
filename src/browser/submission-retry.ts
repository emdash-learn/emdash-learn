export interface SubmissionRetryState {
	idFor(payload: unknown): string;
	settle(): void;
}

/**
 * Keeps one idempotency key while a submission outcome is uncertain.
 *
 * A changed answer payload intentionally starts a new logical submission.
 * Call `settle` only after a successful response or a definitive client error.
 */
export function createSubmissionRetryState(
	nextId: () => string = () => globalThis.crypto.randomUUID(),
): SubmissionRetryState {
	let pending: { fingerprint: string; id: string } | null = null;

	return {
		idFor(payload) {
			const fingerprint = JSON.stringify(payload);
			if (pending?.fingerprint === fingerprint) return pending.id;
			const id = nextId();
			pending = { fingerprint, id };
			return id;
		},
		settle() {
			pending = null;
		},
	};
}
