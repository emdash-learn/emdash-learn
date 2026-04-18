/**
 * Result<T> pattern (§17.5). Every engine function returns this shape so
 * expected failures (not-enrolled, quiz-timeout, etc.) never travel as thrown
 * exceptions — routes unwrap at the boundary.
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
