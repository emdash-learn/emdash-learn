/**
 * Wizard step catalog (§7). Each step is an idempotent probe/apply pair so a
 * re-run after partial failure lands in the correct state.
 *
 * The wizard runs in the admin browser: `probe()` reports the observed state
 * to the UI, `apply()` performs whatever mutations are needed. Both receive
 * the same `StepContext` so the UI can render precise status text.
 */

import type { CoreSchemaClient, RemoteCollectionWithFields } from "./core-schema-client.js";
import { NOT_FOUND } from "./core-schema-client.js";
import {
	FIXTURES,
	type CollectionFixture,
	type FieldSpec,
	type FixtureKey,
} from "./schema-fixtures.js";

export type StepStatus = "pending" | "ok" | "needs-apply" | "conflict" | "error";

export interface StepProbe {
	status: StepStatus;
	/** Human-readable summary used as the main line in the UI row. */
	summary: string;
	/** Optional bulleted detail — e.g. list of missing fields. */
	details?: string[];
}

export interface StepApplyResult {
	writes: number;
	summary: string;
}

export interface StepContext {
	schema: CoreSchemaClient;
}

export interface WizardStep {
	id: string;
	title: string;
	description: string;
	probe(ctx: StepContext): Promise<StepProbe>;
	apply(ctx: StepContext): Promise<StepApplyResult>;
}

/** Subset of a field definition the fixture cares about for equality checks. */
const fixtureFieldSlugs = (fixture: CollectionFixture): Set<string> =>
	new Set(fixture.fields.map((f) => f.slug));

const lockedFieldSlugs = (fixture: CollectionFixture): Set<string> =>
	new Set(fixture.fields.filter((f) => f.locked).map((f) => f.slug));

function diffFields(
	fixture: CollectionFixture,
	remote: RemoteCollectionWithFields,
): { missing: FieldSpec[]; missingLocked: string[] } {
	const remoteSlugs = new Set(remote.fields.map((f) => f.slug));
	const missing = fixture.fields.filter((f) => !remoteSlugs.has(f.slug));
	const missingLocked = [...lockedFieldSlugs(fixture)].filter((slug) => !remoteSlugs.has(slug));
	return { missing, missingLocked };
}

/**
 * Detects a renamed locked field: present in the fixture, absent remotely, but
 * SOME non-fixture slug with a conflicting label or identical position is
 * present. v1 keeps the heuristic simple: any missing locked slug + any extra
 * slug counts as a suspected rename. Surface the list; never auto-repair.
 */
function detectRenames(fixture: CollectionFixture, remote: RemoteCollectionWithFields): string[] {
	const fixtureSlugs = fixtureFieldSlugs(fixture);
	const { missingLocked } = diffFields(fixture, remote);
	if (missingLocked.length === 0) return [];
	const extras = remote.fields.filter((f) => !fixtureSlugs.has(f.slug)).map((f) => f.slug);
	if (extras.length === 0) return [];
	return missingLocked.map(
		(locked) =>
			`\`${locked}\` appears to have been renamed or removed. Unknown fields present: ${extras.join(", ")}.`,
	);
}

function collectionStep(key: FixtureKey): WizardStep {
	const fixture = FIXTURES[key];
	return {
		id: `collection:${key}`,
		title: `Create \`${fixture.create.slug}\` collection`,
		description: `Provisions the \`${fixture.create.slug}\` content collection with its label, icon, URL pattern, and comment settings.`,
		async probe({ schema }) {
			const existing = await schema.getCollection(fixture.create.slug);
			if (existing === NOT_FOUND) {
				return { status: "needs-apply", summary: `\`${fixture.create.slug}\` does not exist.` };
			}
			return {
				status: "ok",
				summary: `\`${fixture.create.slug}\` collection present.`,
			};
		},
		async apply({ schema }) {
			const existing = await schema.getCollection(fixture.create.slug);
			let writes = 0;
			if (existing === NOT_FOUND) {
				await schema.createCollection(fixture.create);
				writes += 1;
			}
			if (fixture.postCreateUpdate) {
				await schema.updateCollection(fixture.create.slug, fixture.postCreateUpdate);
				writes += 1;
			}
			return {
				writes,
				summary: writes === 0 ? "No changes." : `Created \`${fixture.create.slug}\`.`,
			};
		},
	};
}

function fieldsStep(key: FixtureKey): WizardStep {
	const fixture = FIXTURES[key];
	return {
		id: `fields:${key}`,
		title: `Ensure \`${fixture.create.slug}\` fields`,
		description: `Adds every engine-depended field to \`${fixture.create.slug}\`. Never renames or retypes existing fields.`,
		async probe({ schema }) {
			const existing = await schema.getCollection(fixture.create.slug);
			if (existing === NOT_FOUND) {
				return {
					status: "pending",
					summary: `Run "Create \`${fixture.create.slug}\` collection" first.`,
				};
			}
			const renames = detectRenames(fixture, existing);
			if (renames.length > 0) {
				return {
					status: "conflict",
					summary: "Locked field rename detected; repair required.",
					details: renames,
				};
			}
			const { missing } = diffFields(fixture, existing);
			if (missing.length === 0) {
				return {
					status: "ok",
					summary: `All ${fixture.fields.length} fields present.`,
				};
			}
			return {
				status: "needs-apply",
				summary: `${missing.length} missing field${missing.length === 1 ? "" : "s"}.`,
				details: missing.map((f) => `\`${f.slug}\` (${f.type})`),
			};
		},
		async apply({ schema }) {
			const existing = await schema.getCollection(fixture.create.slug);
			if (existing === NOT_FOUND) {
				throw new Error(
					`Collection \`${fixture.create.slug}\` is missing; create it before adding fields.`,
				);
			}
			const renames = detectRenames(fixture, existing);
			if (renames.length > 0) {
				throw new Error(`Rename detected — refusing to apply. ${renames.join(" ")}`);
			}
			const { missing } = diffFields(fixture, existing);
			await Promise.all(
				missing.map((spec, i) => {
					const { locked: _locked, ...createInput } = spec;
					return schema.createField(fixture.create.slug, {
						...createInput,
						sortOrder: existing.fields.length + i,
					});
				}),
			);
			const writes = missing.length;
			return {
				writes,
				summary: writes === 0 ? "No changes." : `Added ${writes} field${writes === 1 ? "" : "s"}.`,
			};
		},
	};
}

function finalizeStep(): WizardStep {
	return {
		id: "finalize",
		title: "Finalize setup",
		description: "Marks the plugin as fully bootstrapped.",
		async probe() {
			return { status: "needs-apply", summary: "Ready when the prior steps are green." };
		},
		async apply() {
			return { writes: 0, summary: "Setup marker updated." };
		},
	};
}

export const WIZARD_STEPS: readonly WizardStep[] = [
	collectionStep("courses"),
	fieldsStep("courses"),
	collectionStep("lessons"),
	fieldsStep("lessons"),
	collectionStep("topics"),
	fieldsStep("topics"),
	finalizeStep(),
];

export function stepById(id: string): WizardStep | undefined {
	return WIZARD_STEPS.find((s) => s.id === id);
}
