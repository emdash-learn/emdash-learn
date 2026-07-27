import { BOOTSTRAP_VERSION } from "../constants.js";
import type { BootstrapState } from "../types/storage.js";
import type { CoreSchemaClient } from "./core-schema-client.js";
import { WIZARD_STEPS, type StepProbe } from "./steps.js";

export interface ProjectionRepairResult {
	errors: number;
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

	const projection = await options.repairProjection();
	if (
		typeof projection !== "object" ||
		projection === null ||
		!Number.isSafeInteger(projection.errors) ||
		projection.errors !== 0
	) {
		throw new SetupVerificationError(
			"Lesson projection repair did not complete without errors.",
			"projection",
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
