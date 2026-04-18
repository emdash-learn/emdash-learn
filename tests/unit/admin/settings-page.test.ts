/**
 * Unit tests for `src/admin/SettingsPage.tsx` (T24 / §16.8).
 *
 * Full component rendering is covered manually against emdash's admin shell —
 * vitest runs in a node env with no DOM (see vitest.config.ts), so we pin the
 * pure transform helpers instead. Those are the pieces the renderer depends on
 * for correctness: form ↔ settings mapping, patch validation, and the email
 * provider badge logic (§16.8 "green Configured / yellow Not configured, M
 * emails queued").
 */

import { describe, expect, it } from "vitest";

import { buildPatch, formatProviderBadge, toFormState } from "../../../src/admin/SettingsPage.js";
import type { SettingsFormState } from "../../../src/admin/SettingsPage.js";
import type { SettingsShape } from "../../../src/constants.js";

const baseSettings: SettingsShape = {
	siteName: "Acme",
	supportEmail: "help@acme.test",
	defaultPassingScore: 80,
	certificateExpiryDays: 365,
	dripMode: "relative",
	commentGateRequiresEnrollment: true,
};

// ---------------------------------------------------------------------------
// toFormState
// ---------------------------------------------------------------------------

describe("toFormState", () => {
	it("maps API shape to form fields, stringifying numeric inputs", () => {
		const form = toFormState(baseSettings);
		expect(form).toEqual({
			siteName: "Acme",
			supportEmail: "help@acme.test",
			defaultPassingScore: "80",
			certificateExpiryDaysMode: "days",
			certificateExpiryDaysValue: "365",
			dripMode: "relative",
			commentGateRequiresEnrollment: true,
		});
	});

	it("maps certificateExpiryDays=null to 'never' mode with an empty value", () => {
		const form = toFormState({ ...baseSettings, certificateExpiryDays: null });
		expect(form.certificateExpiryDaysMode).toBe("never");
		expect(form.certificateExpiryDaysValue).toBe("");
	});
});

// ---------------------------------------------------------------------------
// buildPatch
// ---------------------------------------------------------------------------

const baseForm: SettingsFormState = toFormState(baseSettings);

describe("buildPatch", () => {
	it("returns a full patch for a valid form", () => {
		const res = buildPatch(baseForm);
		expect("error" in res).toBe(false);
		if ("error" in res) return;
		expect(res.patch).toEqual({
			siteName: "Acme",
			supportEmail: "help@acme.test",
			defaultPassingScore: 80,
			certificateExpiryDays: 365,
			dripMode: "relative",
			commentGateRequiresEnrollment: true,
		});
	});

	it("trims siteName and supportEmail", () => {
		const res = buildPatch({
			...baseForm,
			siteName: "  Acme  ",
			supportEmail: "  help@acme.test  ",
		});
		if ("error" in res) throw new Error(res.error);
		expect(res.patch.siteName).toBe("Acme");
		expect(res.patch.supportEmail).toBe("help@acme.test");
	});

	it("allows supportEmail to be cleared to empty string", () => {
		const res = buildPatch({ ...baseForm, supportEmail: "" });
		if ("error" in res) throw new Error(res.error);
		expect(res.patch.supportEmail).toBe("");
	});

	it("rejects a malformed support email", () => {
		const res = buildPatch({ ...baseForm, supportEmail: "not-an-email" });
		expect("error" in res).toBe(true);
		if ("error" in res) expect(res.error).toMatch(/Support email/);
	});

	it("rejects a passing score outside 0–100", () => {
		const lo = buildPatch({ ...baseForm, defaultPassingScore: "-1" });
		const hi = buildPatch({ ...baseForm, defaultPassingScore: "101" });
		expect("error" in lo).toBe(true);
		expect("error" in hi).toBe(true);
	});

	it("rejects a non-integer passing score", () => {
		const res = buildPatch({ ...baseForm, defaultPassingScore: "70.5" });
		expect("error" in res).toBe(true);
	});

	it("sends certificateExpiryDays=null when mode is 'never'", () => {
		const res = buildPatch({
			...baseForm,
			certificateExpiryDaysMode: "never",
			certificateExpiryDaysValue: "365",
		});
		if ("error" in res) throw new Error(res.error);
		expect(res.patch.certificateExpiryDays).toBeNull();
	});

	it("rejects certificateExpiryDays when mode is 'days' and value is empty or <=0", () => {
		const empty = buildPatch({
			...baseForm,
			certificateExpiryDaysMode: "days",
			certificateExpiryDaysValue: "",
		});
		const zero = buildPatch({
			...baseForm,
			certificateExpiryDaysMode: "days",
			certificateExpiryDaysValue: "0",
		});
		expect("error" in empty).toBe(true);
		expect("error" in zero).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// formatProviderBadge
// ---------------------------------------------------------------------------

describe("formatProviderBadge", () => {
	it("renders an 'ok' Configured pill when a provider is installed", () => {
		expect(formatProviderBadge(true, 0)).toEqual({
			tone: "ok",
			label: "Configured",
		});
		// Queued count is ignored when configured — once a provider exists the
		// next flush-email-queue sweep drains it.
		expect(formatProviderBadge(true, 42)).toEqual({
			tone: "ok",
			label: "Configured",
		});
	});

	it("renders a 'warn' Not configured pill with a queued count when M > 0", () => {
		expect(formatProviderBadge(false, 5)).toEqual({
			tone: "warn",
			label: "Not configured — 5 emails queued",
		});
		expect(formatProviderBadge(false, 1)).toEqual({
			tone: "warn",
			label: "Not configured — 1 email queued",
		});
	});

	it("renders a bare 'Not configured' pill when nothing is queued", () => {
		expect(formatProviderBadge(false, 0)).toEqual({
			tone: "warn",
			label: "Not configured",
		});
	});
});
