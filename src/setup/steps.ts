/**
 * Wizard step catalog (§7). Each step is an idempotent probe/apply pair so a
 * re-run after partial failure lands in the correct state.
 *
 * The server-side setup orchestrator runs each `probe()`/`apply()` pair and
 * returns its verified state to the admin UI. Both operations receive the same
 * `StepContext`.
 */

import type { UpdateCollectionInput } from "emdash";

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

function canonicalValue(value: unknown): string {
	if (value === undefined || value === null) return "null";
	if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
	if (isRecord(value)) {
		const entries: Array<[string, unknown]> = Object.entries(value);
		// oxlint-disable-next-line no-array-sort -- entries is a fresh local copy
		entries.sort(([left], [right]) => left.localeCompare(right));
		return `{${entries
			.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalValue(entryValue)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diffFields(
	fixture: CollectionFixture,
	remote: RemoteCollectionWithFields,
): { missing: FieldSpec[] } {
	const remoteSlugs = new Set(remote.fields.map((f) => f.slug));
	const missing = fixture.fields.filter((f) => !remoteSlugs.has(f.slug));
	return { missing };
}

function detectTypeConflicts(
	fixture: CollectionFixture,
	remote: RemoteCollectionWithFields,
): string[] {
	const specsBySlug = new Map(fixture.fields.map((field) => [field.slug, field]));
	return remote.fields.flatMap((field) => {
		const spec = specsBySlug.get(field.slug);
		if (!spec || spec.type === field.type) return [];
		return [`\`${field.slug}\` must be \`${spec.type}\`; found \`${field.type}\`.`];
	});
}

function detectFieldSemanticConflicts(
	fixture: CollectionFixture,
	remote: RemoteCollectionWithFields,
): string[] {
	const specsBySlug = new Map(fixture.fields.map((field) => [field.slug, field]));
	return remote.fields.flatMap((field) => {
		const spec = specsBySlug.get(field.slug);
		if (!spec || spec.type !== field.type) return [];
		const expectedRequired = spec.required ?? false;
		if (field.required !== expectedRequired) {
			return [
				`\`${field.slug}.required\` must be \`${expectedRequired}\`; found \`${field.required}\`.`,
			];
		}
		const expectedUnique = spec.unique ?? false;
		if (field.unique !== expectedUnique) {
			return [`\`${field.slug}.unique\` must be \`${expectedUnique}\`; found \`${field.unique}\`.`];
		}
		const expectedValidation = spec.validation ?? null;
		const remoteValidation = field.validation ?? null;
		if (canonicalValue(remoteValidation) !== canonicalValue(expectedValidation)) {
			return [
				`\`${field.slug}.validation\` must be \`${canonicalValue(expectedValidation)}\`; found \`${canonicalValue(remoteValidation)}\`.`,
			];
		}
		const expectedDefault = spec.defaultValue ?? null;
		const remoteDefault = field.defaultValue ?? null;
		if (canonicalValue(remoteDefault) !== canonicalValue(expectedDefault)) {
			return [
				`\`${field.slug}.defaultValue\` must be \`${canonicalValue(expectedDefault)}\`; found \`${canonicalValue(remoteDefault)}\`.`,
			];
		}
		const expectedOptions = spec.options ?? null;
		const remoteOptions = field.options ?? null;
		if (canonicalValue(remoteOptions) !== canonicalValue(expectedOptions)) {
			return [
				`\`${field.slug}.options\` must be \`${canonicalValue(expectedOptions)}\`; found \`${canonicalValue(remoteOptions)}\`.`,
			];
		}
		const expectedWidget = spec.widget ?? null;
		const remoteWidget = field.widget ?? null;
		if (canonicalValue(remoteWidget) !== canonicalValue(expectedWidget)) {
			return [
				`\`${field.slug}.widget\` must be \`${canonicalValue(expectedWidget)}\`; found \`${canonicalValue(remoteWidget)}\`.`,
			];
		}
		const expectedSearchable = spec.searchable ?? false;
		if (field.searchable !== expectedSearchable) {
			return [
				`\`${field.slug}.searchable\` must be \`${expectedSearchable}\`; found \`${field.searchable}\`.`,
			];
		}
		const expectedTranslatable = spec.translatable ?? true;
		if (field.translatable !== expectedTranslatable) {
			return [
				`\`${field.slug}.translatable\` must be \`${expectedTranslatable}\`; found \`${field.translatable}\`.`,
			];
		}
		return [];
	});
}

function collectionSettingsPatch(
	fixture: CollectionFixture,
	remote: RemoteCollectionWithFields,
): UpdateCollectionInput | null {
	const patch: UpdateCollectionInput = {};
	const expectedSupports = fixture.create.supports ?? [];
	const missingSupports = expectedSupports.filter((support) => !remote.supports.includes(support));
	if (missingSupports.length > 0) {
		patch.supports = [...remote.supports, ...missingSupports];
	}
	if (fixture.create.urlPattern !== undefined && remote.urlPattern !== fixture.create.urlPattern) {
		patch.urlPattern = fixture.create.urlPattern;
	}
	if (fixture.create.hasSeo !== undefined && remote.hasSeo !== fixture.create.hasSeo) {
		patch.hasSeo = fixture.create.hasSeo;
	}
	return Object.keys(patch).length > 0 ? patch : null;
}

function collectionStep(key: FixtureKey): WizardStep {
	const fixture = FIXTURES[key];
	return {
		id: `collection:${key}`,
		title: `Create \`${fixture.create.slug}\` collection`,
		description: `Creates the \`${fixture.create.slug}\` content collection or repairs its required publishing, search, URL, and SEO settings while preserving administrator-owned comment settings.`,
		async probe({ schema }) {
			const existing = await schema.getCollection(fixture.create.slug);
			if (existing === NOT_FOUND) {
				return { status: "needs-apply", summary: `\`${fixture.create.slug}\` does not exist.` };
			}
			const patch = collectionSettingsPatch(fixture, existing);
			if (patch) {
				return {
					status: "needs-apply",
					summary: `\`${fixture.create.slug}\` collection settings need repair.`,
					details: Object.keys(patch).map((setting) => `\`${setting}\``),
				};
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
			} else {
				const patch = collectionSettingsPatch(fixture, existing);
				if (patch) {
					await schema.updateCollection(fixture.create.slug, patch);
					writes += 1;
				}
			}
			return {
				writes,
				summary:
					writes === 0
						? "No changes."
						: existing === NOT_FOUND
							? `Created \`${fixture.create.slug}\`.`
							: `Repaired \`${fixture.create.slug}\` settings.`,
			};
		},
	};
}

function fieldsStep(key: FixtureKey): WizardStep {
	const fixture = FIXTURES[key];
	return {
		id: `fields:${key}`,
		title: `Ensure \`${fixture.create.slug}\` fields`,
		description: `Adds every engine-dependent field to \`${fixture.create.slug}\`. Never renames or retypes existing fields.`,
		async probe({ schema }) {
			const existing = await schema.getCollection(fixture.create.slug);
			if (existing === NOT_FOUND) {
				return {
					status: "pending",
					summary: `Run "Create \`${fixture.create.slug}\` collection" first.`,
				};
			}
			const typeConflicts = detectTypeConflicts(fixture, existing);
			if (typeConflicts.length > 0) {
				return {
					status: "conflict",
					summary: "Field type conflict detected; repair required.",
					details: typeConflicts,
				};
			}
			const semanticConflicts = detectFieldSemanticConflicts(fixture, existing);
			if (semanticConflicts.length > 0) {
				return {
					status: "conflict",
					summary: "Field semantics conflict detected; repair required.",
					details: semanticConflicts,
				};
			}
			const { missing } = diffFields(fixture, existing);
			const missingRequired = missing.filter((field) => field.required === true);
			if (missingRequired.length > 0) {
				let isEmpty: boolean;
				try {
					isEmpty = await schema.isCollectionEmpty(fixture.create.slug);
				} catch (error) {
					return {
						status: "error",
						summary: `Could not prove that \`${fixture.create.slug}\` is empty.`,
						details: [error instanceof Error ? error.message : String(error)],
					};
				}
				if (!isEmpty) {
					return {
						status: "conflict",
						summary: "Required fields cannot be added to a non-empty collection.",
						details: missingRequired.map((field) => `\`${field.slug}\` is required and missing.`),
					};
				}
			}
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
			const typeConflicts = detectTypeConflicts(fixture, existing);
			if (typeConflicts.length > 0) {
				throw new Error(`Field type conflict — refusing to apply. ${typeConflicts.join(" ")}`);
			}
			const semanticConflicts = detectFieldSemanticConflicts(fixture, existing);
			if (semanticConflicts.length > 0) {
				throw new Error(
					`Field semantics conflict — refusing to apply. ${semanticConflicts.join(" ")}`,
				);
			}
			const { missing } = diffFields(fixture, existing);
			const missingRequired = missing.filter((field) => field.required === true);
			if (missingRequired.length > 0 && !(await schema.isCollectionEmpty(fixture.create.slug))) {
				throw new Error(
					`Required fields cannot be added to non-empty collection \`${fixture.create.slug}\`.`,
				);
			}
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

export const WIZARD_STEPS: readonly WizardStep[] = [
	collectionStep("courses"),
	fieldsStep("courses"),
	collectionStep("lessons"),
	fieldsStep("lessons"),
];

export function stepById(id: string): WizardStep | undefined {
	return WIZARD_STEPS.find((s) => s.id === id);
}
