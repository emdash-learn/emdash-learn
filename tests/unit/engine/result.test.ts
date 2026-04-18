import { describe, expect, test } from "vitest";

import { err, ok } from "../../../src/engine/result.js";

describe("Result<T>", () => {
	test("ok() wraps data with ok: true", () => {
		const result = ok(42);

		expect(result).toEqual({ ok: true, data: 42 });
		if (result.ok) {
			expect(result.data).toBe(42);
		}
	});

	test("ok() preserves the exact value, including undefined", () => {
		const undef = ok(undefined);
		expect(undef.ok).toBe(true);
		if (undef.ok) {
			expect(undef.data).toBeUndefined();
		}

		const obj = { id: "abc", count: 3 };
		const result = ok(obj);
		if (result.ok) {
			expect(result.data).toBe(obj);
		}
	});

	test("err() wraps a code + message with ok: false", () => {
		const result = err("LEARN_NOT_ENROLLED", "user is not enrolled");

		expect(result).toEqual({
			ok: false,
			error: { code: "LEARN_NOT_ENROLLED", message: "user is not enrolled" },
		});
	});

	test("result discriminant narrows on .ok", () => {
		const result = Math.random() > 2 ? ok("x") : err("LEARN_X", "x");

		if (result.ok) {
			const _data: string = result.data;
			expect(_data).toBeDefined();
		} else {
			const _code: string = result.error.code;
			const _message: string = result.error.message;
			expect(_code).toBeDefined();
			expect(_message).toBeDefined();
		}
	});
});
