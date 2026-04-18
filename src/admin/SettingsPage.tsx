/**
 * Settings admin page (T24 / §16.8) — mounts at
 * `/_emdash/admin/plugins/lms-core/settings`.
 *
 * Four sections per §16.8:
 *
 *   1. General           — site LMS name, support email
 *   2. Defaults          — default passing score, certificate expiry, drip mode
 *   3. Email             — provider status badge + "Send test email" button
 *   4. Danger zone       — uninstall link (emdash's native uninstall flow owns
 *                          the `deleteData` checkbox + confirmation prompt)
 *
 * Per §12 Q19, Wave 6 pages (T19–T25) ship plain HTML + inline styles; the
 * Kumo + Lingui refactor is a single batch after T19–T25 have all landed.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type CSSProperties,
	type FormEvent,
	type ReactElement,
} from "react";

import {
	LmsApiError,
	createApiClient,
	type SettingsGetResponse,
	type SettingsShape,
	type SettingsUpdateInput,
} from "./api-client.js";

/** Form state; mirrors `SettingsShape` but stores numbers as strings so admins
 *  can clear a field without it defaulting back to `0`. `certificateExpiryDays`
 *  stays nullable because `null = never`. */
export interface SettingsFormState {
	siteName: string;
	supportEmail: string;
	defaultPassingScore: string;
	certificateExpiryDaysMode: "never" | "days";
	certificateExpiryDaysValue: string;
	dripMode: "immediate" | "relative";
	commentGateRequiresEnrollment: boolean;
}

type LoadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| {
			kind: "ready";
			data: SettingsGetResponse;
			form: SettingsFormState;
	  };

function formatError(err: unknown): string {
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

/** Convert the API shape into form fields. Exposed for unit tests. */
export function toFormState(settings: SettingsShape): SettingsFormState {
	return {
		siteName: settings.siteName,
		supportEmail: settings.supportEmail,
		defaultPassingScore: String(settings.defaultPassingScore),
		certificateExpiryDaysMode: settings.certificateExpiryDays === null ? "never" : "days",
		certificateExpiryDaysValue:
			settings.certificateExpiryDays === null ? "" : String(settings.certificateExpiryDays),
		dripMode: settings.dripMode,
		commentGateRequiresEnrollment: settings.commentGateRequiresEnrollment,
	};
}

/**
 * Produce the patch payload the `admin:settings:update` route accepts. Returns
 * `{ error }` with a human-readable message when a number field is out of range
 * or the support email is malformed, so the caller can surface it inline.
 */
export function buildPatch(
	form: SettingsFormState,
): { patch: SettingsUpdateInput["settings"] } | { error: string } {
	const patch: SettingsUpdateInput["settings"] = {};

	patch.siteName = form.siteName.trim();

	const supportEmail = form.supportEmail.trim();
	if (supportEmail !== "") {
		// Minimal RFC-5322-ish check — the backend enforces a full Zod email
		// schema; this just keeps an obvious typo from round-tripping.
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) {
			return { error: "Support email is not a valid address." };
		}
	}
	patch.supportEmail = supportEmail;

	const passing = Number(form.defaultPassingScore);
	if (!Number.isInteger(passing) || passing < 0 || passing > 100) {
		return { error: "Default passing score must be an integer 0–100." };
	}
	patch.defaultPassingScore = passing;

	if (form.certificateExpiryDaysMode === "never") {
		patch.certificateExpiryDays = null;
	} else {
		const days = Number(form.certificateExpiryDaysValue);
		if (!Number.isInteger(days) || days <= 0) {
			return { error: "Certificate expiry days must be a positive integer." };
		}
		patch.certificateExpiryDays = days;
	}

	patch.dripMode = form.dripMode;
	patch.commentGateRequiresEnrollment = form.commentGateRequiresEnrollment;

	return { patch };
}

/** Derives the provider badge label. Exposed for unit tests. */
export function formatProviderBadge(
	configured: boolean,
	queued: number,
): { tone: "ok" | "warn"; label: string } {
	if (configured) {
		return { tone: "ok", label: "Configured" };
	}
	if (queued > 0) {
		return {
			tone: "warn",
			label: `Not configured — ${queued} email${queued === 1 ? "" : "s"} queued`,
		};
	}
	return { tone: "warn", label: "Not configured" };
}

export function SettingsPage(): ReactElement {
	const api = useMemo(() => createApiClient(), []);
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);
	const [testResult, setTestResult] = useState<string | null>(null);

	const load = useCallback(async () => {
		setState({ kind: "loading" });
		try {
			const data = await api.settings.get();
			setState({ kind: "ready", data, form: toFormState(data.settings) });
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api]);

	useEffect(() => {
		void load();
	}, [load]);

	const patchForm = useCallback((patch: Partial<SettingsFormState>) => {
		setState((prev) =>
			prev.kind === "ready" ? { ...prev, form: { ...prev.form, ...patch } } : prev,
		);
	}, []);

	const onSave = useCallback(
		async (e: FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			if (state.kind !== "ready") return;
			setSaveError(null);
			setTestResult(null);

			const built = buildPatch(state.form);
			if ("error" in built) {
				setSaveError(built.error);
				return;
			}

			setSaving(true);
			try {
				const resp = await api.settings.update({ settings: built.patch });
				setState({
					kind: "ready",
					data: { ...state.data, settings: resp.settings },
					form: toFormState(resp.settings),
				});
				setSavedAt(Date.now());
			} catch (err) {
				setSaveError(formatError(err));
			} finally {
				setSaving(false);
			}
		},
		[api, state],
	);

	const onSendTestEmail = useCallback(async () => {
		setTestResult(null);
		try {
			const resp = await api.settings.testEmail();
			setTestResult(
				resp.delivered
					? `Test email sent to ${resp.to}.`
					: `No provider configured — queued for ${resp.to} and will send when one is installed.`,
			);
			// Refresh so the queued count stays honest.
			void load();
		} catch (err) {
			setTestResult(`Failed: ${formatError(err)}`);
		}
	}, [api, load]);

	if (state.kind === "loading") {
		return (
			<section style={pageStyle}>
				<h1 style={pageTitleStyle}>Settings</h1>
				<div style={mutedBannerStyle} role="status" aria-live="polite">
					Loading settings…
				</div>
			</section>
		);
	}

	if (state.kind === "error") {
		return (
			<section style={pageStyle}>
				<h1 style={pageTitleStyle}>Settings</h1>
				<div role="alert" style={errorBannerStyle}>
					<div style={{ marginBlockEnd: "0.5rem" }}>Couldn't load settings: {state.message}</div>
					<button type="button" onClick={() => void load()} style={secondaryButtonStyle}>
						Retry
					</button>
				</div>
			</section>
		);
	}

	const badge = formatProviderBadge(
		state.data.emailProvider.configured,
		state.data.emailProvider.queued,
	);

	return (
		<section style={pageStyle}>
			<header style={headerStyle}>
				<h1 style={pageTitleStyle}>Settings</h1>
				<p style={subtitleStyle}>
					Admin-wide defaults and provider status. Changes apply immediately after saving.
				</p>
			</header>

			<form onSubmit={onSave} style={formStyle}>
				<Card title="General">
					<label style={fieldLabelStyle}>
						Site name
						<input
							type="text"
							value={state.form.siteName}
							onChange={(e) => patchForm({ siteName: e.target.value })}
							maxLength={200}
							placeholder="Emdash Learn"
							style={inputStyle}
						/>
						<span style={hintStyle}>Shown in the student UI and email subject lines.</span>
					</label>

					<label style={fieldLabelStyle}>
						Support email
						<input
							type="email"
							value={state.form.supportEmail}
							onChange={(e) => patchForm({ supportEmail: e.target.value })}
							placeholder="support@example.com"
							style={inputStyle}
						/>
					</label>
				</Card>

				<Card title="Defaults">
					<label style={fieldLabelStyle}>
						Default quiz passing score
						<input
							type="number"
							min={0}
							max={100}
							value={state.form.defaultPassingScore}
							onChange={(e) => patchForm({ defaultPassingScore: e.target.value })}
							style={inputStyle}
						/>
						<span style={hintStyle}>Applied to new quizzes when no score is specified.</span>
					</label>

					<fieldset style={fieldsetStyle}>
						<legend style={legendStyle}>Certificate expiry</legend>
						<label style={radioLabelStyle}>
							<input
								type="radio"
								name="cert-expiry-mode"
								value="never"
								checked={state.form.certificateExpiryDaysMode === "never"}
								onChange={() => patchForm({ certificateExpiryDaysMode: "never" })}
							/>
							Never expires
						</label>
						<label style={radioLabelStyle}>
							<input
								type="radio"
								name="cert-expiry-mode"
								value="days"
								checked={state.form.certificateExpiryDaysMode === "days"}
								onChange={() => patchForm({ certificateExpiryDaysMode: "days" })}
							/>
							<span>Expires after</span>
							<input
								type="number"
								min={1}
								value={state.form.certificateExpiryDaysValue}
								onChange={(e) => patchForm({ certificateExpiryDaysValue: e.target.value })}
								disabled={state.form.certificateExpiryDaysMode !== "days"}
								placeholder="365"
								style={{ ...inputStyle, inlineSize: "8rem" }}
							/>
							<span>days</span>
						</label>
					</fieldset>

					<label style={fieldLabelStyle}>
						Drip mode
						<select
							value={state.form.dripMode}
							onChange={(e) =>
								patchForm({
									dripMode: e.target.value as "immediate" | "relative",
								})
							}
							style={inputStyle}
						>
							<option value="immediate">Immediate — unlock on enrollment</option>
							<option value="relative">Relative — unlock on schedule from enrollment date</option>
						</select>
					</label>

					<label style={checkboxLabelStyle}>
						<input
							type="checkbox"
							checked={state.form.commentGateRequiresEnrollment}
							onChange={(e) =>
								patchForm({
									commentGateRequiresEnrollment: e.target.checked,
								})
							}
						/>
						<span>Require enrollment to comment on lessons</span>
					</label>
				</Card>

				<Card title="Email">
					<div style={providerRowStyle}>
						<span style={badge.tone === "ok" ? badgeOkStyle : badgeWarnStyle}>{badge.label}</span>
						<button
							type="button"
							onClick={() => void onSendTestEmail()}
							disabled={!state.data.emailProvider.configured}
							style={secondaryButtonStyle}
						>
							Send test email
						</button>
					</div>
					{testResult ? (
						<div style={mutedBannerStyle} role="status" aria-live="polite">
							{testResult}
						</div>
					) : null}
				</Card>

				<Card title="Danger zone" tone="danger">
					<p style={{ marginBlock: 0 }}>
						Uninstall Emdash Learn via emdash's standard plugin uninstall flow. The confirmation
						dialog exposes a <strong>Delete all data</strong> checkbox — unchecked by default to
						preserve student data. Checking it wipes every course, lesson, enrollment, progress
						record, and certificate.
					</p>
					<div>
						<a href="/_emdash/admin/plugins" style={dangerLinkStyle}>
							Open Plugins &rarr;
						</a>
					</div>
				</Card>

				{saveError ? (
					<div role="alert" style={inlineErrorStyle}>
						{saveError}
					</div>
				) : null}

				<div style={footerStyle}>
					{savedAt !== null ? (
						<span style={mutedTextStyle} role="status" aria-live="polite">
							Saved.
						</span>
					) : null}
					<button type="submit" disabled={saving} style={primaryButtonStyle}>
						{saving ? "Saving…" : "Save changes"}
					</button>
				</div>
			</form>
		</section>
	);
}

// ── Card wrapper ─────────────────────────────────────────────────────────────

function Card({
	title,
	tone,
	children,
}: {
	title: string;
	tone?: "danger";
	children: React.ReactNode;
}): ReactElement {
	return (
		<section style={tone === "danger" ? dangerCardStyle : cardStyle}>
			<h2 style={tone === "danger" ? dangerCardTitleStyle : cardTitleStyle}>{title}</h2>
			<div style={cardBodyStyle}>{children}</div>
		</section>
	);
}

// ── styles ───────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
	padding: "2rem",
	maxInlineSize: "48rem",
	marginInline: "auto",
	fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif",
	color: "#0f172a",
};

const headerStyle: CSSProperties = {
	marginBlockEnd: "1.5rem",
};

const pageTitleStyle: CSSProperties = {
	fontSize: "1.5rem",
	marginBlock: 0,
};

const subtitleStyle: CSSProperties = {
	color: "#475569",
	marginBlockStart: "0.25rem",
};

const formStyle: CSSProperties = {
	display: "grid",
	gap: "1.25rem",
};

const cardStyle: CSSProperties = {
	backgroundColor: "white",
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	padding: "1.25rem",
};

const dangerCardStyle: CSSProperties = {
	...cardStyle,
	borderColor: "#fecaca",
	backgroundColor: "#fef2f2",
};

const cardTitleStyle: CSSProperties = {
	fontSize: "1.125rem",
	marginBlock: 0,
	marginBlockEnd: "0.75rem",
	color: "#0f172a",
};

const dangerCardTitleStyle: CSSProperties = {
	...cardTitleStyle,
	color: "#991b1b",
};

const cardBodyStyle: CSSProperties = {
	display: "grid",
	gap: "0.875rem",
};

const fieldLabelStyle: CSSProperties = {
	display: "grid",
	gap: "0.25rem",
	fontSize: "0.875rem",
	color: "#334155",
	fontWeight: 500,
};

const inputStyle: CSSProperties = {
	paddingBlock: "0.5rem",
	paddingInline: "0.625rem",
	borderRadius: "0.375rem",
	border: "1px solid #cbd5e1",
	fontSize: "0.925rem",
	backgroundColor: "white",
	color: "#0f172a",
};

const hintStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.75rem",
};

const fieldsetStyle: CSSProperties = {
	border: "1px solid #e2e8f0",
	borderRadius: "0.375rem",
	padding: "0.75rem",
	display: "grid",
	gap: "0.5rem",
};

const legendStyle: CSSProperties = {
	fontSize: "0.875rem",
	color: "#334155",
	fontWeight: 500,
	paddingInline: "0.25rem",
};

const radioLabelStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "0.5rem",
	fontSize: "0.875rem",
	color: "#334155",
};

const checkboxLabelStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "0.5rem",
	fontSize: "0.875rem",
	color: "#334155",
};

const providerRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "0.75rem",
};

const badgeOkStyle: CSSProperties = {
	display: "inline-block",
	paddingBlock: "0.25rem",
	paddingInline: "0.5rem",
	borderRadius: "9999px",
	backgroundColor: "#dcfce7",
	color: "#166534",
	fontSize: "0.75rem",
	fontWeight: 600,
};

const badgeWarnStyle: CSSProperties = {
	...badgeOkStyle,
	backgroundColor: "#fef3c7",
	color: "#92400e",
};

const primaryButtonStyle: CSSProperties = {
	paddingBlock: "0.5rem",
	paddingInline: "1rem",
	borderRadius: "0.375rem",
	border: "none",
	backgroundColor: "#2563eb",
	color: "white",
	fontWeight: 600,
	cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
	paddingBlock: "0.375rem",
	paddingInline: "0.75rem",
	borderRadius: "0.375rem",
	border: "1px solid #cbd5e1",
	backgroundColor: "white",
	color: "#0f172a",
	cursor: "pointer",
	fontSize: "0.875rem",
};

const dangerLinkStyle: CSSProperties = {
	color: "#991b1b",
	textDecoration: "none",
	fontWeight: 600,
};

const mutedBannerStyle: CSSProperties = {
	paddingBlock: "0.75rem",
	paddingInline: "1rem",
	borderRadius: "0.5rem",
	border: "1px solid #cbd5e1",
	backgroundColor: "#f1f5f9",
	color: "#334155",
};

const errorBannerStyle: CSSProperties = {
	paddingBlock: "0.75rem",
	paddingInline: "1rem",
	borderRadius: "0.5rem",
	border: "1px solid #fecaca",
	backgroundColor: "#fef2f2",
	color: "#991b1b",
};

const inlineErrorStyle: CSSProperties = {
	color: "#991b1b",
	fontSize: "0.875rem",
};

const footerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "flex-end",
	gap: "0.75rem",
};

const mutedTextStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.875rem",
};

export default SettingsPage;
