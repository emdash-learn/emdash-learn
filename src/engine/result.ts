/**
 * Result<T> — discriminated-union error channel used throughout the engine
 * (§17.5 / D35). Signature pinned in §22 so parallel T02/T03/T04 branches
 * cannot diverge on the shared surface.
 *
 * **T03 shim.** T02 owns this file and is landing the canonical implementation
 * on `t02-event-bus` in parallel. This shim exists so `t03-authz-types`
 * typechecks and tests on its own — the §22-pinned public surface is the same
 * either way. When the branches merge, T02's version wins and this file is
 * discarded.
 */

export interface ResultError {
	code: string;
	message: string;
}

export type Result<T, E extends ResultError = ResultError> =
	| { ok: true; data: T }
	| { ok: false; error: E };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });

export const err = (code: string, message: string): Result<never> => ({
	ok: false,
	error: { code, message },
});
