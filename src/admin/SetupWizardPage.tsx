/**
 * Setup wizard admin page — mounts at `/_emdash/admin/plugins/lms-core/setup`.
 *
 * The component orchestrates the wizard steps (§7) from the admin browser:
 *   - `probe()` reports each step's current state.
 *   - `apply()` runs schema-mutating calls against
 *     `/_emdash/api/schema/*` using the admin's session cookie (D2).
 *   - Completion is persisted via the plugin's `setup:mark` route.
 *
 * T01 ships plain HTML + inline styles rather than Kumo / Lingui wiring.
 * Rationale lodged in prd-plugin.md §12 Q19 — T18/T19 refactor this page to
 * Kumo components and Lingui strings alongside the rest of the admin UI.
 */

import {
	Fragment,
	useCallback,
	useEffect,
	useMemo,
	useState,
	type ReactElement,
} from "react";

import { BOOTSTRAP_VERSION } from "../constants.js";
import {
	CoreSchemaClientError,
	createCoreSchemaClient,
} from "../setup/core-schema-client.js";
import {
	WIZARD_STEPS,
	type StepProbe,
	type WizardStep,
} from "../setup/steps.js";
import type { BootstrapState } from "../types/storage.js";
import { LmsApiError, createApiClient } from "./api-client.js";

interface StepRowState {
	probe: StepProbe;
	applying: boolean;
	lastApplyError?: string;
	lastWrites?: number;
}

const initialRow: StepRowState = {
	probe: { status: "pending", summary: "Loading…" },
	applying: false,
};

const statusPalette: Record<StepProbe["status"], { label: string; color: string }> = {
	pending: { label: "…", color: "#64748b" },
	ok: { label: "✓", color: "#15803d" },
	"needs-apply": { label: "○", color: "#b45309" },
	conflict: { label: "!", color: "#b91c1c" },
	error: { label: "×", color: "#b91c1c" },
};

function formatError(err: unknown): string {
	if (err instanceof CoreSchemaClientError) {
		const detail =
			err.body && typeof err.body === "object" && "message" in err.body
				? String((err.body as { message: unknown }).message)
				: String(err.status);
		return `${err.message} — ${detail}`;
	}
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

export function SetupWizardPage(): ReactElement {
	const schema = useMemo(() => createCoreSchemaClient(), []);
	const api = useMemo(() => createApiClient(), []);
	const [rows, setRows] = useState<Record<string, StepRowState>>(() => {
		const out: Record<string, StepRowState> = {};
		for (const step of WIZARD_STEPS) out[step.id] = initialRow;
		return out;
	});
	const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
	const [targetVersion, setTargetVersion] = useState<number>(BOOTSTRAP_VERSION);
	const [runningAll, setRunningAll] = useState(false);
	const [globalError, setGlobalError] = useState<string | null>(null);

	const runProbe = useCallback(
		async (step: WizardStep): Promise<StepProbe> => {
			try {
				return await step.probe({ schema });
			} catch (err) {
				return { status: "error", summary: formatError(err) };
			}
		},
		[schema],
	);

	const refreshAll = useCallback(async () => {
		setGlobalError(null);
		const next: Record<string, StepRowState> = {};
		for (const step of WIZARD_STEPS) {
			next[step.id] = { ...initialRow, probe: { status: "pending", summary: "Checking…" } };
		}
		setRows(next);
		const probes = await Promise.all(
			WIZARD_STEPS.map(async (step) => ({ id: step.id, probe: await runProbe(step) })),
		);
		setRows((prev) => {
			const updated = { ...prev };
			for (const { id, probe } of probes) {
				updated[id] = { ...(updated[id] ?? initialRow), probe };
			}
			return updated;
		});
	}, [runProbe]);

	const refreshBootstrap = useCallback(async () => {
		try {
			const res = await api.setup.state();
			setBootstrap(res.state);
			setTargetVersion(res.targetVersion);
		} catch (err) {
			setGlobalError(formatError(err));
		}
	}, [api]);

	useEffect(() => {
		void refreshBootstrap();
		void refreshAll();
	}, [refreshAll, refreshBootstrap]);

	const runStep = useCallback(
		async (step: WizardStep): Promise<boolean> => {
			setRows((prev) => ({
				...prev,
				[step.id]: { ...(prev[step.id] ?? initialRow), applying: true, lastApplyError: undefined },
			}));
			try {
				const result = await step.apply({ schema });
				const probe = await runProbe(step);
				setRows((prev) => ({
					...prev,
					[step.id]: {
						...(prev[step.id] ?? initialRow),
						probe,
						applying: false,
						lastWrites: result.writes,
					},
				}));
				return probe.status === "ok";
			} catch (err) {
				const message = formatError(err);
				const probe = await runProbe(step);
				setRows((prev) => ({
					...prev,
					[step.id]: {
						...(prev[step.id] ?? initialRow),
						probe: probe.status === "ok" ? probe : { status: "error", summary: message },
						applying: false,
						lastApplyError: message,
					},
				}));
				return false;
			}
		},
		[runProbe, schema],
	);

	const runAll = useCallback(async () => {
		setRunningAll(true);
		setGlobalError(null);
		const completed: string[] = [];
		let failed: { stepId: string; message: string } | undefined;
		for (const step of WIZARD_STEPS) {
			if (step.id === "finalize") continue;
			// Sequential by design: step 2 reads the collection created in step 1.
			// eslint-disable-next-line eslint/no-await-in-loop -- step order matters
			const success = await runStep(step);
			if (success) {
				completed.push(step.id);
			} else {
				const row = rows[step.id];
				failed = {
					stepId: step.id,
					message: row?.lastApplyError ?? row?.probe.summary ?? "unknown",
				};
				break;
			}
		}
		try {
			if (!failed) completed.push("finalize");
			const markInput: {
				completedSteps: string[];
				lastError?: { stepId: string; message: string; at: string };
			} = { completedSteps: completed };
			if (failed) {
				markInput.lastError = {
					stepId: failed.stepId,
					message: failed.message,
					at: new Date().toISOString(),
				};
			}
			await api.setup.mark(markInput);
			await refreshBootstrap();
		} catch (err) {
			setGlobalError(formatError(err));
		}
		setRunningAll(false);
	}, [api, refreshBootstrap, rows, runStep]);

	const allSteps = WIZARD_STEPS;
	const pendingCount = allSteps.filter(
		(s) => rows[s.id]?.probe.status !== "ok",
	).length;
	const isComplete =
		bootstrap !== null &&
		bootstrap.version >= targetVersion &&
		pendingCount === 0;

	return (
		<section style={pageStyle}>
			<header style={headerStyle}>
				<h1 style={{ fontSize: "1.5rem", marginBlockEnd: "0.5rem" }}>Emdash Learn · Setup</h1>
				<p style={{ color: "#475569", marginBlockStart: 0 }}>
					Provisions the <code>courses</code> and <code>lessons</code> content collections the LMS
					engine depends on. Every step is idempotent — safe to re-run after an upgrade.
				</p>
				<StatusBanner
					bootstrap={bootstrap}
					targetVersion={targetVersion}
					isComplete={isComplete}
					pendingCount={pendingCount}
				/>
				{globalError ? <ErrorBanner message={globalError} /> : null}
			</header>

			<div style={toolbarStyle}>
				<button
					type="button"
					onClick={runAll}
					disabled={runningAll}
					style={primaryButtonStyle(runningAll)}
				>
					{runningAll ? "Running setup…" : pendingCount === 0 ? "Re-check" : "Run setup"}
				</button>
				<button
					type="button"
					onClick={() => void refreshAll()}
					disabled={runningAll}
					style={secondaryButtonStyle}
				>
					Refresh
				</button>
			</div>

			<ol style={listStyle}>
				{allSteps.map((step) => {
					const row = rows[step.id] ?? initialRow;
					return (
						<li key={step.id} style={itemStyle}>
							<div style={itemHeadStyle}>
								<StatusBadge status={row.probe.status} />
								<div style={{ flex: 1 }}>
									<div style={itemTitleStyle}>{step.title}</div>
									<div style={itemSummaryStyle}>{row.probe.summary}</div>
									{row.probe.details && row.probe.details.length > 0 ? (
										<ul style={detailListStyle}>
											{row.probe.details.map((d) => (
												<li key={d}>{d}</li>
											))}
										</ul>
									) : null}
									{row.lastApplyError ? (
										<div style={itemErrorStyle}>Apply error: {row.lastApplyError}</div>
									) : null}
									{typeof row.lastWrites === "number" && row.lastWrites > 0 ? (
										<div style={itemHintStyle}>
											{row.lastWrites} write{row.lastWrites === 1 ? "" : "s"} performed.
										</div>
									) : null}
								</div>
								<button
									type="button"
									onClick={() => void runStep(step)}
									disabled={runningAll || row.applying}
									style={tertiaryButtonStyle}
								>
									{row.applying ? "Applying…" : "Apply"}
								</button>
							</div>
							<p style={itemDescStyle}>{step.description}</p>
						</li>
					);
				})}
			</ol>
		</section>
	);
}

function StatusBadge({ status }: { status: StepProbe["status"] }): ReactElement {
	const { label, color } = statusPalette[status];
	return (
		<span
			aria-label={status}
			style={{
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				inlineSize: "1.5rem",
				blockSize: "1.5rem",
				borderRadius: "999px",
				backgroundColor: `${color}1a`,
				color,
				fontWeight: 600,
				fontVariantNumeric: "tabular-nums",
			}}
		>
			{label}
		</span>
	);
}

function StatusBanner({
	bootstrap,
	targetVersion,
	isComplete,
	pendingCount,
}: {
	bootstrap: BootstrapState | null;
	targetVersion: number;
	isComplete: boolean;
	pendingCount: number;
}): ReactElement {
	let tone: "neutral" | "success" | "warning" = "neutral";
	let body: ReactElement;
	if (bootstrap === null) {
		body = <>Loading bootstrap state…</>;
	} else if (isComplete) {
		tone = "success";
		body = (
			<>
				Setup complete — bootstrap version {bootstrap.version} / {targetVersion}. All checks green.
			</>
		);
	} else if (bootstrap.version < targetVersion && bootstrap.completedSteps.length > 0) {
		tone = "warning";
		body = (
			<>
				A plugin upgrade bumped the bootstrap version. {pendingCount} step
				{pendingCount === 1 ? "" : "s"} remain.
			</>
		);
	} else {
		tone = "warning";
		body = (
			<Fragment>
				Bootstrap version {bootstrap.version} / {targetVersion}. {pendingCount} step
				{pendingCount === 1 ? "" : "s"} remain.
			</Fragment>
		);
	}
	const palette = tone === "success"
		? { bg: "#ecfdf5", border: "#86efac", fg: "#166534" }
		: tone === "warning"
			? { bg: "#fefce8", border: "#fde68a", fg: "#854d0e" }
			: { bg: "#f1f5f9", border: "#cbd5e1", fg: "#334155" };
	return (
		<div
			style={{
				marginBlockStart: "1rem",
				marginBlockEnd: "1rem",
				paddingBlock: "0.75rem",
				paddingInline: "1rem",
				borderRadius: "0.5rem",
				border: `1px solid ${palette.border}`,
				backgroundColor: palette.bg,
				color: palette.fg,
			}}
		>
			{body}
		</div>
	);
}

function ErrorBanner({ message }: { message: string }): ReactElement {
	return (
		<div
			role="alert"
			style={{
				marginBlockStart: "0.5rem",
				paddingBlock: "0.75rem",
				paddingInline: "1rem",
				borderRadius: "0.5rem",
				border: "1px solid #fecaca",
				backgroundColor: "#fef2f2",
				color: "#991b1b",
			}}
		>
			{message}
		</div>
	);
}

// ── styles ───────────────────────────────────────────────────────────────────

const pageStyle = {
	padding: "2rem",
	maxInlineSize: "52rem",
	marginInline: "auto",
	fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif",
	color: "#0f172a",
} as const;

const headerStyle = {
	marginBlockEnd: "1.5rem",
} as const;

const toolbarStyle = {
	display: "flex",
	gap: "0.75rem",
	marginBlockEnd: "1.5rem",
} as const;

const primaryButtonStyle = (disabled: boolean): React.CSSProperties => ({
	paddingBlock: "0.5rem",
	paddingInline: "1rem",
	borderRadius: "0.375rem",
	border: "1px solid transparent",
	backgroundColor: disabled ? "#94a3b8" : "#2563eb",
	color: "white",
	cursor: disabled ? "not-allowed" : "pointer",
	fontWeight: 600,
});

const secondaryButtonStyle: React.CSSProperties = {
	paddingBlock: "0.5rem",
	paddingInline: "1rem",
	borderRadius: "0.375rem",
	border: "1px solid #cbd5e1",
	backgroundColor: "white",
	color: "#0f172a",
	cursor: "pointer",
};

const tertiaryButtonStyle: React.CSSProperties = {
	paddingBlock: "0.375rem",
	paddingInline: "0.75rem",
	borderRadius: "0.375rem",
	border: "1px solid #cbd5e1",
	backgroundColor: "white",
	color: "#0f172a",
	cursor: "pointer",
	fontSize: "0.875rem",
};

const listStyle = {
	listStyle: "none",
	paddingInlineStart: 0,
	marginBlockStart: 0,
	marginBlockEnd: 0,
	display: "flex",
	flexDirection: "column",
	gap: "0.75rem",
} as const;

const itemStyle: React.CSSProperties = {
	padding: "1rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	backgroundColor: "white",
};

const itemHeadStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "flex-start",
	gap: "0.75rem",
};

const itemTitleStyle: React.CSSProperties = {
	fontWeight: 600,
	marginBlockEnd: "0.25rem",
};

const itemSummaryStyle: React.CSSProperties = {
	color: "#334155",
	fontSize: "0.925rem",
};

const itemDescStyle: React.CSSProperties = {
	color: "#64748b",
	fontSize: "0.825rem",
	marginBlockStart: "0.5rem",
	marginBlockEnd: 0,
};

const itemErrorStyle: React.CSSProperties = {
	marginBlockStart: "0.5rem",
	color: "#991b1b",
	fontSize: "0.875rem",
};

const itemHintStyle: React.CSSProperties = {
	marginBlockStart: "0.25rem",
	color: "#166534",
	fontSize: "0.825rem",
};

const detailListStyle: React.CSSProperties = {
	marginBlockStart: "0.375rem",
	marginBlockEnd: 0,
	paddingInlineStart: "1.25rem",
	color: "#475569",
	fontSize: "0.8125rem",
};

export default SetupWizardPage;
