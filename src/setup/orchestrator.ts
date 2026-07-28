import { BOOTSTRAP_VERSION } from "../constants.js";
import type { BootstrapState } from "../types/storage.js";
import type { CoreSchemaClient } from "./core-schema-client.js";
import { WIZARD_STEPS, type StepProbe } from "./steps.js";

/**
 * Setup only ever accepts an explicitly complete repair. Counts remain part of
 * the reported result so operators keep the reconciliation summary they had
 * before the Published Lessons module owned this decision.
 */
export interface ProjectionRepairResult {
	complete: boolean;
	errors: number;
	diagnostics?: ReadonlyArray<{ code: string; message: string }>;
}

export interface SetupOrchestratorOptions {
	schema: CoreSchemaClient;
	repairProjection(): Promise<ProjectionRepairResult>;
	persistState(state: BootstrapState): Promise<void>;
	now?: () => Date;
}

export interface SetupOrchestratorResult {
	state: BootstrapState;
	schemaWrites: number;
	projection: ProjectionRepairResult;
}

export class SetupVerificationError extends Error {
	constructor(
		message: string,
		public readonly stepId?: string,
		public readonly probe?: StepProbe,
	) {
		super(message);
		this.name = "SetupVerificationError";
	}
}

/**
 * Read whatever diagnostics a composed adapter actually reported. An adapter
 * that breaks its declared contract must still fail as setup verification
 * rather than as an unhandled type error.
 */
function reportedDiagnostics(projection: unknown): Array<{ code: string; message: string }> {
	if (typeof projection !== "object" || projection === null) return [];
	const diagnostics = Reflect.get(projection, "diagnostics");
	if (!Array.isArray(diagnostics)) return [];
	return diagnostics.filter(
		(entry: unknown): entry is { code: string; message: string } =>
			typeof entry === "object" &&
			entry !== null &&
			typeof Reflect.get(entry, "code") === "string" &&
			typeof Reflect.get(entry, "message") === "string",
	);
}

/**
 * Report why repair could not be accepted through the existing step-probe
 * field, so an operator sees the projection diagnostics instead of only a
 * server log line.
 */
function projectionProbe(projection: unknown): StepProbe {
	return {
		status: "error",
		summary: "Published Lesson projection repair did not complete.",
		details: reportedDiagnostics(projection).map(
			(diagnostic) => `${diagnostic.code}: ${diagnostic.message}`,
		),
	};
}

function assertVerifiedStep(stepId: string, probe: StepProbe): void {
	if (probe.status === "ok") return;
	throw new SetupVerificationError(
		`Setup step \`${stepId}\` could not be verified: ${probe.summary}`,
		stepId,
		probe,
	);
}

/**
 * Converge the required content schema, verify it again, repair the derived
 * Lesson projection, then persist a server-derived completion record.
 */
export async function convergeSetup(
	options: SetupOrchestratorOptions,
): Promise<SetupOrchestratorResult> {
	const schema = options.schema;
	const now = options.now ?? (() => new Date());
	const completedSteps: string[] = [];
	let schemaWrites = 0;

	for (const step of WIZARD_STEPS) {
		// oxlint-disable-next-line no-await-in-loop -- schema dependencies require ordered convergence
		let probe = await step.probe({ schema });
		if (probe.status === "needs-apply") {
			// oxlint-disable-next-line no-await-in-loop -- each write must be verified before continuing
			const applied = await step.apply({ schema });
			schemaWrites += applied.writes;
			// oxlint-disable-next-line no-await-in-loop -- completion is based on observed post-write state
			probe = await step.probe({ schema });
		}
		assertVerifiedStep(step.id, probe);
		completedSteps.push(step.id);
	}

	// The completion claim arrives from a composed adapter, so setup verifies it
	// against the reported errors instead of trusting either alone.
	const projection = await options.repairProjection();
	const claimsComplete: unknown =
		typeof projection === "object" && projection !== null ? projection.complete : undefined;
	if (
		claimsComplete !== true ||
		!Number.isSafeInteger(projection.errors) ||
		projection.errors !== 0
	) {
		throw new SetupVerificationError(
			"Published Lesson projection repair did not complete.",
			"projection",
			projectionProbe(projection),
		);
	}

	const state: BootstrapState = {
		version: BOOTSTRAP_VERSION,
		completedSteps,
		lastRunAt: now().toISOString(),
		verification: {
			contractVersion: BOOTSTRAP_VERSION,
			schema: "compatible",
			projection: "repaired",
		},
	};
	await options.persistState(state);

	return { state, schemaWrites, projection };
}
