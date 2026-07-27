import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type CSSProperties,
	type ReactElement,
} from "react";

import { BOOTSTRAP_VERSION } from "../constants.js";
import type { ProjectionRepairResult } from "../setup/orchestrator.js";
import type { BootstrapState } from "../types/storage.js";
import { createApiClient, LmsApiError, type ApiClient } from "./api-client.js";

interface SetupResultSummary {
	schemaWrites: number;
	projection: ProjectionRepairResult;
}

export interface SetupViewProps {
	state: BootstrapState | null;
	targetVersion: number;
	running: boolean;
	error: string | null;
	result: SetupResultSummary | null;
	onRun: () => void;
	onRefresh: () => void;
}

function projectionCount(projection: ProjectionRepairResult, field: string): number | null {
	const value = Reflect.get(projection, field);
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isVerified(state: BootstrapState | null, targetVersion: number): boolean {
	return Boolean(
		state &&
		state.version >= targetVersion &&
		state.verification?.schema === "compatible" &&
		state.verification.projection === "repaired" &&
		state.verification.contractVersion >= targetVersion,
	);
}

export function SetupView({
	state,
	targetVersion,
	running,
	error,
	result,
	onRun,
	onRefresh,
}: SetupViewProps): ReactElement {
	const verified = isVerified(state, targetVersion);
	const reconciledLessons = result ? projectionCount(result.projection, "lessonsUpserted") : null;
	const deletedPointers = result ? projectionCount(result.projection, "staleRowsDeleted") : null;

	return (
		<section style={pageStyle}>
			<header style={headerStyle}>
				<p style={eyebrowStyle}>EmDash Learn</p>
				<h1 style={titleStyle}>Setup</h1>
				<p style={introStyle}>
					Verify the Course and Lesson schema, repair compatible missing fields, and reconcile the
					published lesson index. The server derives every completion check; the browser cannot mark
					setup complete.
				</p>
			</header>

			<div role="status" style={verified ? successStyle : warningStyle}>
				<strong>{verified ? "Setup verified" : "Setup needs verification"}</strong>
				<div>
					Bootstrap version {state?.version ?? 0} / {targetVersion}
					{state?.lastRunAt ? ` · last run ${new Date(state.lastRunAt).toLocaleString()}` : ""}
				</div>
			</div>

			{error ? (
				<div role="alert" style={errorStyle}>
					{error}
				</div>
			) : null}

			<div style={actionsStyle}>
				<button
					type="button"
					onClick={onRun}
					disabled={running}
					style={primaryButtonStyle(running)}
				>
					{running ? "Running verified setup…" : verified ? "Verify and repair again" : "Run setup"}
				</button>
				<button type="button" onClick={onRefresh} disabled={running} style={secondaryButtonStyle}>
					Refresh status
				</button>
			</div>

			{result ? (
				<section aria-label="Latest setup result" style={resultStyle}>
					<h2 style={sectionTitleStyle}>Latest run</h2>
					<ul>
						<li>
							{result.schemaWrites} schema write
							{result.schemaWrites === 1 ? "" : "s"} applied
						</li>
						{reconciledLessons === null ? null : (
							<li>{reconciledLessons} lesson records reconciled</li>
						)}
						{deletedPointers === null ? null : (
							<li>{deletedPointers} stale lesson pointers removed</li>
						)}
						<li>{result.projection.errors} projection errors</li>
					</ul>
				</section>
			) : null}

			{state?.completedSteps.length ? (
				<details style={detailsStyle}>
					<summary>Verified schema steps ({state.completedSteps.length})</summary>
					<ul>
						{state.completedSteps.map((step) => (
							<li key={step}>
								<code>{step}</code>
							</li>
						))}
					</ul>
				</details>
			) : null}

			<aside style={noteStyle}>
				<strong>Content remains yours.</strong> Setup only adds compatible Course and Lesson schema
				requirements. Uninstalling Learn never deletes administrator-owned Course or Lesson entries.
			</aside>
		</section>
	);
}

function errorMessage(error: unknown): string {
	if (error instanceof LmsApiError) return error.message;
	if (error instanceof Error) return error.message;
	return "Setup could not be completed.";
}

export interface SetupWizardPageProps {
	client?: ApiClient;
}

export function SetupWizardPage({ client }: SetupWizardPageProps = {}): ReactElement {
	const api = useMemo(() => client ?? createApiClient(), [client]);
	const [state, setState] = useState<BootstrapState | null>(null);
	const [targetVersion, setTargetVersion] = useState(BOOTSTRAP_VERSION);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<SetupResultSummary | null>(null);

	const refresh = useCallback(async () => {
		try {
			const response = await api.setup.state();
			setState(response.state);
			setTargetVersion(response.targetVersion);
			setError(null);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [api]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const run = useCallback(async () => {
		setRunning(true);
		setError(null);
		try {
			const response = await api.setup.run();
			setState(response.state);
			setResult({
				schemaWrites: response.schemaWrites,
				projection: response.projection,
			});
		} catch (caught) {
			setError(errorMessage(caught));
			await refresh();
		} finally {
			setRunning(false);
		}
	}, [api, refresh]);

	return (
		<SetupView
			state={state}
			targetVersion={targetVersion}
			running={running}
			error={error}
			result={result}
			onRun={() => void run()}
			onRefresh={() => void refresh()}
		/>
	);
}

export default SetupWizardPage;

const pageStyle: CSSProperties = {
	maxWidth: "56rem",
	marginInline: "auto",
	padding: "2rem",
	color: "#0f172a",
};

const headerStyle: CSSProperties = { marginBlockEnd: "1.5rem" };
const eyebrowStyle: CSSProperties = {
	margin: 0,
	color: "#4f46e5",
	fontSize: "0.75rem",
	fontWeight: 700,
	letterSpacing: "0.08em",
	textTransform: "uppercase",
};
const titleStyle: CSSProperties = { marginBlock: "0.4rem", fontSize: "2rem" };
const introStyle: CSSProperties = {
	maxWidth: "48rem",
	margin: 0,
	color: "#475569",
	lineHeight: 1.6,
};
const statusBase: CSSProperties = {
	padding: "1rem",
	borderRadius: "0.65rem",
	lineHeight: 1.55,
};
const successStyle: CSSProperties = {
	...statusBase,
	border: "1px solid #86efac",
	background: "#ecfdf5",
	color: "#166534",
};
const warningStyle: CSSProperties = {
	...statusBase,
	border: "1px solid #fde68a",
	background: "#fefce8",
	color: "#854d0e",
};
const errorStyle: CSSProperties = {
	marginBlockStart: "1rem",
	padding: "0.85rem 1rem",
	border: "1px solid #fecaca",
	borderRadius: "0.65rem",
	background: "#fef2f2",
	color: "#991b1b",
};
const actionsStyle: CSSProperties = {
	display: "flex",
	flexWrap: "wrap",
	gap: "0.75rem",
	marginBlock: "1.25rem",
};
const primaryButtonStyle = (disabled: boolean): CSSProperties => ({
	padding: "0.65rem 1rem",
	border: 0,
	borderRadius: "0.45rem",
	background: disabled ? "#94a3b8" : "#4f46e5",
	color: "white",
	cursor: disabled ? "not-allowed" : "pointer",
	fontWeight: 650,
});
const secondaryButtonStyle: CSSProperties = {
	padding: "0.65rem 1rem",
	border: "1px solid #cbd5e1",
	borderRadius: "0.45rem",
	background: "white",
	color: "#0f172a",
	cursor: "pointer",
	fontWeight: 600,
};
const resultStyle: CSSProperties = {
	padding: "1rem",
	border: "1px solid #cbd5e1",
	borderRadius: "0.65rem",
	background: "#f8fafc",
};
const sectionTitleStyle: CSSProperties = { marginBlockStart: 0, fontSize: "1rem" };
const detailsStyle: CSSProperties = { marginBlockStart: "1rem" };
const noteStyle: CSSProperties = {
	marginBlockStart: "1.5rem",
	padding: "1rem",
	borderInlineStart: "4px solid #818cf8",
	background: "#eef2ff",
	color: "#3730a3",
	lineHeight: 1.55,
};
