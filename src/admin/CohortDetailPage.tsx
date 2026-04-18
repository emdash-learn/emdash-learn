/**
 * Cohort detail page (T22 / §16.6) — mounts at
 * `/_emdash/admin/plugins/lms-core/cohorts/:cohortId`.
 *
 * Loads `cohort:get` (detail + members) on mount and exposes:
 *   - Header with title / slug / dates / capacity.
 *   - Members table (Student, Role, Joined) with inline remove.
 *   - "Add member" modal (userId + role).
 *   - "Import CSV" modal (paste-one-per-line emails) surfacing the D50
 *     unknown-emails + already-members reports back to the instructor.
 *
 * The §16.6 wireframe shows "Student" as a human name; the engine only
 * stores userId + joinedAt + role — populating display names requires a
 * users-lookup we don't have here, so the page renders the userId verbatim
 * and leaves the enrichment to a follow-up once `users.get()` is wired.
 *
 * Per §12 Q19, plain HTML + inline styles like T19/T25.
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
	type CohortDetailResponse,
	type CohortImportResponse,
} from "./api-client.js";
import type { CohortMemberRole } from "../types/storage.js";

const PLUGIN_BASE = "/_emdash/admin/plugins/lms-core";
const COHORTS_PATH_PREFIX = `${PLUGIN_BASE}/cohorts/`;
const COHORTS_HREF = `${PLUGIN_BASE}/cohorts`;

type Member = CohortDetailResponse["members"][number];

type LoadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; data: CohortDetailResponse };

function formatError(err: unknown): string {
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Extract the `:cohortId` segment from an admin-shell URL like
 * `/_emdash/admin/plugins/lms-core/cohorts/coh_abc`. Returns `null` if the
 * path doesn't match or the segment is empty.
 */
export function parseCohortIdFromPath(pathname: string): string | null {
	if (!pathname.startsWith(COHORTS_PATH_PREFIX)) return null;
	const rest = pathname.slice(COHORTS_PATH_PREFIX.length);
	const slashIndex = rest.indexOf("/");
	const raw = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
	if (raw.length === 0) return null;
	try {
		const decoded = decodeURIComponent(raw);
		return decoded.length > 0 ? decoded : null;
	} catch {
		return null;
	}
}

/** `2026-05-01T...` → `1 May 2026` — UTC slices so tests are deterministic. */
export function formatShortDate(isoTimestamp: string): string {
	const parsed = Date.parse(isoTimestamp);
	if (!Number.isFinite(parsed)) return isoTimestamp;
	const d = new Date(parsed);
	const day = d.getUTCDate();
	const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
	const year = d.getUTCFullYear();
	return `${day} ${month} ${year}`;
}

export function formatCapacityLine(memberCount: number, capacity?: number): string {
	if (typeof capacity === "number") {
		return `${capacity} seats · Current members: ${memberCount}`;
	}
	return `Current members: ${memberCount}`;
}

/**
 * Split one-email-per-line (or comma-separated) paste into a trimmed,
 * de-duped list. Mirrors the route-side parser so the user sees the same
 * list we're about to submit, pre-flight.
 */
export function parseEmailList(input: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const token of input.split(/[\n,]/)) {
		const email = token.trim();
		if (!email) continue;
		const key = email.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(email);
	}
	return out;
}

export function CohortDetailPage(): ReactElement {
	const cohortId = useMemo(() => {
		if (typeof window === "undefined") return null;
		return parseCohortIdFromPath(window.location.pathname);
	}, []);

	const api = useMemo(() => createApiClient(), []);
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [showAdd, setShowAdd] = useState(false);
	const [showImport, setShowImport] = useState(false);

	const load = useCallback(async () => {
		if (!cohortId) {
			setState({
				kind: "error",
				message:
					"Missing cohort id in URL — expected /_emdash/admin/plugins/lms-core/cohorts/<id>.",
			});
			return;
		}
		setState({ kind: "loading" });
		try {
			const data = await api.cohorts.get({ cohortId });
			setState({ kind: "ready", data });
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api, cohortId]);

	useEffect(() => {
		void load();
	}, [load]);

	const refresh = useCallback(() => {
		void load();
	}, [load]);

	const onRemoveMember = useCallback(
		async (userId: string) => {
			if (!cohortId) return;
			if (typeof window !== "undefined" && !window.confirm(`Remove ${userId} from this cohort?`))
				return;
			try {
				await api.cohorts.removeMember({ cohortId, userId });
				refresh();
			} catch (err) {
				if (typeof window !== "undefined") window.alert(formatError(err));
			}
		},
		[api, cohortId, refresh],
	);

	return (
		<section style={pageStyle}>
			<header style={headerStyle}>
				<a href={COHORTS_HREF} style={backLinkStyle}>
					← Back to cohorts
				</a>

				{state.kind === "ready" ? (
					<CohortHeader data={state.data} />
				) : (
					<h1 style={pageTitleStyle}>Cohort</h1>
				)}
			</header>

			{state.kind === "loading" ? (
				<LoadingBanner />
			) : state.kind === "error" ? (
				<ErrorBanner message={state.message} onRetry={() => void load()} />
			) : (
				<>
					<section aria-label="Members" style={sectionStyle}>
						<div style={sectionHeaderStyle}>
							<h2 style={sectionTitleStyle}>Members</h2>
							<div style={sectionActionsStyle}>
								<button type="button" onClick={() => setShowAdd(true)} style={primaryButtonStyle}>
									+ Add member
								</button>
								<button
									type="button"
									onClick={() => setShowImport(true)}
									style={secondaryButtonStyle}
								>
									Import CSV
								</button>
							</div>
						</div>
						<MembersTable members={state.data.members} onRemove={onRemoveMember} />
					</section>

					{showAdd && cohortId ? (
						<AddMemberModal
							cohortId={cohortId}
							api={api}
							onCancel={() => setShowAdd(false)}
							onAdded={() => {
								setShowAdd(false);
								refresh();
							}}
						/>
					) : null}
					{showImport && cohortId ? (
						<ImportCsvModal
							cohortId={cohortId}
							api={api}
							onCancel={() => setShowImport(false)}
							onImported={() => {
								setShowImport(false);
								refresh();
							}}
						/>
					) : null}
				</>
			)}
		</section>
	);
}

function CohortHeader({ data }: { data: CohortDetailResponse }): ReactElement {
	const { cohort, members } = data;
	return (
		<>
			<div style={headerRowStyle}>
				<h1 style={pageTitleStyle}>{cohort.title}</h1>
				<span style={slugBadgeStyle}>{cohort.slug}</span>
			</div>
			<dl style={metaGridStyle}>
				<div style={metaItemStyle}>
					<dt style={metaLabelStyle}>Start</dt>
					<dd style={metaValueStyle}>{cohort.startAt ? formatShortDate(cohort.startAt) : "—"}</dd>
				</div>
				<div style={metaItemStyle}>
					<dt style={metaLabelStyle}>End</dt>
					<dd style={metaValueStyle}>{cohort.endAt ? formatShortDate(cohort.endAt) : "—"}</dd>
				</div>
				<div style={metaItemStyle}>
					<dt style={metaLabelStyle}>Capacity</dt>
					<dd style={metaValueStyle}>{formatCapacityLine(members.length, cohort.capacity)}</dd>
				</div>
			</dl>
		</>
	);
}

function MembersTable({
	members,
	onRemove,
}: {
	members: Member[];
	onRemove: (userId: string) => void;
}): ReactElement {
	if (members.length === 0) {
		return <EmptyState message="No members yet — add them one at a time or import a list." />;
	}
	return (
		<div style={tableWrapperStyle}>
			<table style={tableStyle}>
				<thead>
					<tr>
						<th style={thStyle}>Student</th>
						<th style={thStyle}>Role</th>
						<th style={thStyle}>Joined</th>
						<th style={thActionStyle} aria-label="Actions" />
					</tr>
				</thead>
				<tbody>
					{members.map((m) => (
						<tr key={m.id}>
							<td style={tdMonoStyle}>{m.userId}</td>
							<td style={tdStyle}>
								<RoleBadge role={m.role} />
							</td>
							<td style={tdStyle}>{formatShortDate(m.joinedAt)}</td>
							<td style={tdActionStyle}>
								<button type="button" onClick={() => onRemove(m.userId)} style={dangerLinkStyle}>
									Remove
								</button>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function RoleBadge({ role }: { role: CohortMemberRole }): ReactElement {
	const palette =
		role === "ta"
			? { label: "TA", bg: "#dbeafe", fg: "#1e40af" }
			: { label: "Student", bg: "#f1f5f9", fg: "#475569" };
	return (
		<span
			style={{
				...badgeStyle,
				backgroundColor: palette.bg,
				color: palette.fg,
			}}
		>
			{palette.label}
		</span>
	);
}

// ── Add-member modal ─────────────────────────────────────────────────────────

interface AddMemberModalProps {
	cohortId: string;
	api: ReturnType<typeof createApiClient>;
	onCancel: () => void;
	onAdded: () => void;
}

function AddMemberModal({ cohortId, api, onCancel, onAdded }: AddMemberModalProps): ReactElement {
	const [userId, setUserId] = useState("");
	const [role, setRole] = useState<CohortMemberRole>("student");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		setSubmitting(true);
		try {
			await api.cohorts.addMember({
				cohortId,
				userId: userId.trim(),
				role,
			});
			onAdded();
		} catch (err) {
			setError(formatError(err));
			setSubmitting(false);
		}
	};

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="add-member-title"
			style={modalOverlayStyle}
		>
			<form onSubmit={onSubmit} style={modalStyle}>
				<h2 id="add-member-title" style={modalTitleStyle}>
					Add member
				</h2>
				<label style={fieldLabelStyle}>
					User ID
					<input
						type="text"
						value={userId}
						onChange={(e) => setUserId(e.target.value)}
						required
						placeholder="usr_…"
						style={inputStyle}
					/>
					<span style={hintStyle}>Find the user ID in the admin user list.</span>
				</label>
				<label style={fieldLabelStyle}>
					Role
					<select
						value={role}
						onChange={(e) => {
							const next = e.target.value;
							if (next === "student" || next === "ta") setRole(next);
						}}
						style={inputStyle}
					>
						<option value="student">Student</option>
						<option value="ta">TA</option>
					</select>
				</label>

				{error ? <div style={inlineErrorStyle}>{error}</div> : null}

				<div style={modalActionsStyle}>
					<button
						type="button"
						onClick={onCancel}
						disabled={submitting}
						style={secondaryButtonStyle}
					>
						Cancel
					</button>
					<button type="submit" disabled={submitting} style={primaryButtonStyle}>
						{submitting ? "Adding…" : "Add member"}
					</button>
				</div>
			</form>
		</div>
	);
}

// ── Import-CSV modal ─────────────────────────────────────────────────────────

interface ImportCsvModalProps {
	cohortId: string;
	api: ReturnType<typeof createApiClient>;
	onCancel: () => void;
	onImported: () => void;
}

function ImportCsvModal({
	cohortId,
	api,
	onCancel,
	onImported,
}: ImportCsvModalProps): ReactElement {
	const [csv, setCsv] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [report, setReport] = useState<CohortImportResponse | null>(null);

	const parsedPreview = useMemo(() => parseEmailList(csv), [csv]);

	const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		if (parsedPreview.length === 0) {
			setError("Paste at least one email address.");
			return;
		}
		setSubmitting(true);
		try {
			const result = await api.cohorts.import({ cohortId, csv });
			setReport(result);
			setSubmitting(false);
		} catch (err) {
			setError(formatError(err));
			setSubmitting(false);
		}
	};

	if (report) {
		return (
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="import-result-title"
				style={modalOverlayStyle}
			>
				<div style={modalStyle}>
					<h2 id="import-result-title" style={modalTitleStyle}>
						Import complete
					</h2>
					<dl style={reportGridStyle}>
						<div style={metaItemStyle}>
							<dt style={metaLabelStyle}>Added</dt>
							<dd style={metaValueStyle}>{report.counts.added}</dd>
						</div>
						<div style={metaItemStyle}>
							<dt style={metaLabelStyle}>Already members</dt>
							<dd style={metaValueStyle}>{report.counts.alreadyMembers}</dd>
						</div>
						<div style={metaItemStyle}>
							<dt style={metaLabelStyle}>Unknown emails</dt>
							<dd style={metaValueStyle}>{report.counts.unknown}</dd>
						</div>
					</dl>
					{report.unknownEmails.length > 0 ? (
						<ReportList
							label="Unknown emails (no user found — invite separately):"
							items={report.unknownEmails}
						/>
					) : null}
					{report.alreadyMembers.length > 0 ? (
						<ReportList label="Already members:" items={report.alreadyMembers} />
					) : null}
					<div style={modalActionsStyle}>
						<button type="button" onClick={onImported} style={primaryButtonStyle}>
							Done
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="import-csv-title"
			style={modalOverlayStyle}
		>
			<form onSubmit={onSubmit} style={modalStyle}>
				<h2 id="import-csv-title" style={modalTitleStyle}>
					Import members from CSV
				</h2>
				<label style={fieldLabelStyle}>
					Email addresses
					<textarea
						value={csv}
						onChange={(e) => setCsv(e.target.value)}
						rows={8}
						placeholder={"alice@example.com\nbob@example.com"}
						style={{ ...inputStyle, resize: "vertical", minBlockSize: "8rem" }}
					/>
					<span style={hintStyle}>
						One email per line, or comma-separated. {parsedPreview.length} valid{" "}
						{parsedPreview.length === 1 ? "email" : "emails"} detected.
					</span>
				</label>

				{error ? <div style={inlineErrorStyle}>{error}</div> : null}

				<div style={modalActionsStyle}>
					<button
						type="button"
						onClick={onCancel}
						disabled={submitting}
						style={secondaryButtonStyle}
					>
						Cancel
					</button>
					<button type="submit" disabled={submitting} style={primaryButtonStyle}>
						{submitting ? "Importing…" : "Import"}
					</button>
				</div>
			</form>
		</div>
	);
}

function ReportList({ label, items }: { label: string; items: string[] }): ReactElement {
	return (
		<details style={reportDetailsStyle}>
			<summary style={reportSummaryStyle}>
				{label} ({items.length})
			</summary>
			<ul style={reportListStyle}>
				{items.map((email) => (
					<li key={email} style={reportListItemStyle}>
						{email}
					</li>
				))}
			</ul>
		</details>
	);
}

// ── Shared presentational ────────────────────────────────────────────────────

function LoadingBanner(): ReactElement {
	return (
		<div style={mutedBannerStyle} role="status" aria-live="polite">
			Loading cohort…
		</div>
	);
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
	return (
		<div role="alert" style={errorBannerStyle}>
			<div style={{ marginBlockEnd: "0.5rem" }}>Couldn't load cohort: {message}</div>
			<button type="button" onClick={onRetry} style={secondaryButtonStyle}>
				Retry
			</button>
		</div>
	);
}

function EmptyState({ message }: { message: string }): ReactElement {
	return <div style={emptyStateStyle}>{message}</div>;
}

// ── styles ───────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
	padding: "2rem",
	maxInlineSize: "64rem",
	marginInline: "auto",
	fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif",
	color: "#0f172a",
};

const headerStyle: CSSProperties = {
	marginBlockEnd: "1.5rem",
};

const backLinkStyle: CSSProperties = {
	display: "inline-block",
	color: "#2563eb",
	textDecoration: "none",
	fontSize: "0.875rem",
	marginBlockEnd: "0.75rem",
};

const headerRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "0.75rem",
	flexWrap: "wrap",
	marginBlockEnd: "0.5rem",
};

const pageTitleStyle: CSSProperties = {
	fontSize: "1.5rem",
	marginBlock: 0,
};

const slugBadgeStyle: CSSProperties = {
	paddingInline: "0.5rem",
	paddingBlock: "0.125rem",
	borderRadius: "9999px",
	backgroundColor: "#f1f5f9",
	color: "#475569",
	fontSize: "0.8125rem",
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
};

const metaGridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
	gap: "0.75rem",
	marginBlock: 0,
};

const metaItemStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "0.125rem",
};

const metaLabelStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.75rem",
	textTransform: "uppercase",
	letterSpacing: "0.04em",
};

const metaValueStyle: CSSProperties = {
	color: "#0f172a",
	fontSize: "0.925rem",
	marginInlineStart: 0,
};

const sectionStyle: CSSProperties = {
	marginBlockEnd: "1.5rem",
};

const sectionHeaderStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	flexWrap: "wrap",
	gap: "0.75rem",
	marginBlockEnd: "0.75rem",
};

const sectionTitleStyle: CSSProperties = {
	fontSize: "1.125rem",
	marginBlock: 0,
};

const sectionActionsStyle: CSSProperties = {
	display: "flex",
	gap: "0.5rem",
};

const primaryButtonStyle: CSSProperties = {
	display: "inline-block",
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
	paddingBlock: "0.5rem",
	paddingInline: "0.875rem",
	borderRadius: "0.375rem",
	border: "1px solid #cbd5e1",
	backgroundColor: "white",
	color: "#0f172a",
	cursor: "pointer",
	fontSize: "0.875rem",
};

const dangerLinkStyle: CSSProperties = {
	background: "none",
	border: "none",
	color: "#b91c1c",
	cursor: "pointer",
	fontSize: "0.875rem",
	padding: 0,
};

const tableWrapperStyle: CSSProperties = {
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	overflow: "hidden",
	backgroundColor: "white",
};

const tableStyle: CSSProperties = {
	inlineSize: "100%",
	borderCollapse: "collapse",
	fontSize: "0.925rem",
};

const thStyle: CSSProperties = {
	textAlign: "start",
	paddingBlock: "0.625rem",
	paddingInline: "0.875rem",
	backgroundColor: "#f8fafc",
	borderBlockEnd: "1px solid #e2e8f0",
	fontWeight: 600,
	color: "#334155",
};

const thActionStyle: CSSProperties = {
	...thStyle,
	inlineSize: "5rem",
};

const tdStyle: CSSProperties = {
	paddingBlock: "0.625rem",
	paddingInline: "0.875rem",
	borderBlockStart: "1px solid #f1f5f9",
};

const tdMonoStyle: CSSProperties = {
	...tdStyle,
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
	fontSize: "0.875rem",
	color: "#334155",
};

const tdActionStyle: CSSProperties = {
	...tdStyle,
	textAlign: "end",
};

const badgeStyle: CSSProperties = {
	display: "inline-block",
	paddingBlock: "0.125rem",
	paddingInline: "0.5rem",
	borderRadius: "9999px",
	fontSize: "0.75rem",
	fontWeight: 600,
};

const modalOverlayStyle: CSSProperties = {
	position: "fixed",
	inset: 0,
	backgroundColor: "rgba(15, 23, 42, 0.45)",
	display: "grid",
	placeItems: "center",
	zIndex: 100,
};

const modalStyle: CSSProperties = {
	backgroundColor: "white",
	borderRadius: "0.5rem",
	padding: "1.5rem",
	inlineSize: "min(32rem, 90vw)",
	display: "grid",
	gap: "0.875rem",
	boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
};

const modalTitleStyle: CSSProperties = {
	fontSize: "1.25rem",
	marginBlock: 0,
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
	fontFamily: "inherit",
};

const hintStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.75rem",
};

const inlineErrorStyle: CSSProperties = {
	color: "#991b1b",
	fontSize: "0.875rem",
};

const modalActionsStyle: CSSProperties = {
	display: "flex",
	justifyContent: "flex-end",
	gap: "0.5rem",
	marginBlockStart: "0.25rem",
};

const reportGridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(3, 1fr)",
	gap: "0.5rem",
	marginBlock: 0,
};

const reportDetailsStyle: CSSProperties = {
	borderRadius: "0.375rem",
	backgroundColor: "#f8fafc",
	padding: "0.5rem 0.75rem",
	fontSize: "0.875rem",
};

const reportSummaryStyle: CSSProperties = {
	cursor: "pointer",
	color: "#334155",
	fontWeight: 500,
};

const reportListStyle: CSSProperties = {
	marginBlock: "0.5rem 0",
	paddingInlineStart: "1.25rem",
	color: "#475569",
	maxBlockSize: "12rem",
	overflowY: "auto",
};

const reportListItemStyle: CSSProperties = {
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
	fontSize: "0.8125rem",
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

const emptyStateStyle: CSSProperties = {
	paddingBlock: "1rem",
	paddingInline: "1rem",
	border: "1px dashed #cbd5e1",
	borderRadius: "0.5rem",
	color: "#64748b",
	fontSize: "0.925rem",
};

export default CohortDetailPage;
