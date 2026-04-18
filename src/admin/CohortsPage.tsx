/**
 * Cohort list page (T22 / §16.6) — mounts at
 * `/_emdash/admin/plugins/lms-core/cohorts`.
 *
 * Renders `cohort:list` as a table (Slug, Title, Start–end, Members, Capacity,
 * Actions) and lets the admin create a new cohort via an inline modal. Each
 * row links to the detail page (§16.6).
 *
 * Per §12 Q19, T22 ships plain HTML + inline styles like T19/T25. The Kumo +
 * Lingui adoption is the Wave 6 batch refactor that happens after T19–T25
 * land together.
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
	type CohortListResponse,
} from "./api-client.js";

const PLUGIN_BASE = "/_emdash/admin/plugins/lms-core";
const COHORT_DETAIL_BASE = `${PLUGIN_BASE}/cohorts`;

type CohortRow = CohortListResponse["items"][number];

type LoadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; items: CohortRow[] };

function formatError(err: unknown): string {
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

/** `2026-05-01T...` → `1 May 2026` — UTC slices so the test output is stable. */
export function formatShortDate(isoTimestamp: string): string {
	const parsed = Date.parse(isoTimestamp);
	if (!Number.isFinite(parsed)) return isoTimestamp;
	const d = new Date(parsed);
	const day = d.getUTCDate();
	const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
	const year = d.getUTCFullYear();
	return `${day} ${month} ${year}`;
}

/**
 * "1 May 2026 – 31 Jul 2026" / "Starts 1 May 2026" / "Ends 31 Jul 2026" / "—".
 * The admin needs a compact, read-at-a-glance summary in the list table.
 */
export function formatDateRange(startAt?: string, endAt?: string): string {
	if (startAt && endAt) {
		return `${formatShortDate(startAt)} – ${formatShortDate(endAt)}`;
	}
	if (startAt) return `Starts ${formatShortDate(startAt)}`;
	if (endAt) return `Ends ${formatShortDate(endAt)}`;
	return "—";
}

/** "34 / 50" when a cap exists, otherwise just the member count. */
export function formatCapacity(memberCount: number, capacity?: number): string {
	if (typeof capacity === "number") return `${memberCount} / ${capacity}`;
	return `${memberCount}`;
}

/** True when memberCount exceeds capacity — surfaced as a warning pill. */
export function isOverCapacity(memberCount: number, capacity?: number): boolean {
	if (typeof capacity !== "number") return false;
	return memberCount > capacity;
}

export function CohortsPage(): ReactElement {
	const api = useMemo(() => createApiClient(), []);
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [showCreate, setShowCreate] = useState(false);

	const load = useCallback(async () => {
		setState({ kind: "loading" });
		try {
			const page = await api.cohorts.list();
			setState({ kind: "ready", items: page.items });
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api]);

	useEffect(() => {
		void load();
	}, [load]);

	const onCreated = useCallback(() => {
		setShowCreate(false);
		void load();
	}, [load]);

	return (
		<section style={pageStyle}>
			<header style={headerStyle}>
				<div style={headerRowStyle}>
					<h1 style={pageTitleStyle}>Cohorts</h1>
					<button
						type="button"
						onClick={() => setShowCreate(true)}
						style={primaryButtonStyle}
					>
						+ New cohort
					</button>
				</div>
				<p style={subtitleStyle}>
					Group learners into cohorts for time-boxed, synchronous courses.
				</p>
			</header>

			{state.kind === "loading" ? (
				<LoadingBanner />
			) : state.kind === "error" ? (
				<ErrorBanner message={state.message} onRetry={() => void load()} />
			) : state.items.length === 0 ? (
				<EmptyState message="You don't have any cohorts yet. Create one to enroll groups of learners at once." />
			) : (
				<CohortsTable items={state.items} />
			)}

			{showCreate ? (
				<CreateCohortModal
					onCancel={() => setShowCreate(false)}
					onCreated={onCreated}
					api={api}
				/>
			) : null}
		</section>
	);
}

function CohortsTable({ items }: { items: CohortRow[] }): ReactElement {
	return (
		<div style={tableWrapperStyle}>
			<table style={tableStyle}>
				<thead>
					<tr>
						<th style={thStyle}>Slug</th>
						<th style={thStyle}>Title</th>
						<th style={thStyle}>Start–end</th>
						<th style={thNumStyle}>Members</th>
						<th style={thNumStyle}>Capacity</th>
						<th style={thActionStyle} aria-label="Actions" />
					</tr>
				</thead>
				<tbody>
					{items.map((row) => (
						<CohortRow key={row.id} row={row} />
					))}
				</tbody>
			</table>
		</div>
	);
}

function CohortRow({ row }: { row: CohortRow }): ReactElement {
	const over = isOverCapacity(row.memberCount, row.capacity);
	return (
		<tr>
			<td style={tdMonoStyle}>{row.slug}</td>
			<td style={tdStyle}>{row.title}</td>
			<td style={tdStyle}>{formatDateRange(row.startAt, row.endAt)}</td>
			<td style={tdNumStyle}>{row.memberCount}</td>
			<td style={tdNumStyle}>
				{formatCapacity(row.memberCount, row.capacity)}
				{over ? (
					<span style={warningBadgeStyle} title="Over capacity">
						!
					</span>
				) : null}
			</td>
			<td style={tdActionStyle}>
				<a
					href={`${COHORT_DETAIL_BASE}/${encodeURIComponent(row.id)}`}
					style={linkStyle}
				>
					Open →
				</a>
			</td>
		</tr>
	);
}

// ── Create-cohort modal ──────────────────────────────────────────────────────

interface CreateCohortModalProps {
	onCancel: () => void;
	onCreated: () => void;
	api: ReturnType<typeof createApiClient>;
}

function CreateCohortModal({
	onCancel,
	onCreated,
	api,
}: CreateCohortModalProps): ReactElement {
	const [slug, setSlug] = useState("");
	const [title, setTitle] = useState("");
	const [startAt, setStartAt] = useState("");
	const [endAt, setEndAt] = useState("");
	const [capacity, setCapacity] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		setSubmitting(true);
		try {
			const input: Parameters<typeof api.cohorts.create>[0] = {
				slug: slug.trim(),
				title: title.trim(),
			};
			if (startAt) input.startAt = new Date(startAt).toISOString();
			if (endAt) input.endAt = new Date(endAt).toISOString();
			const capNum = capacity.trim() === "" ? undefined : Number(capacity);
			if (typeof capNum === "number" && Number.isFinite(capNum)) {
				input.capacity = capNum;
			}
			await api.cohorts.create(input);
			onCreated();
		} catch (err) {
			setError(formatError(err));
			setSubmitting(false);
		}
	};

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="create-cohort-title"
			style={modalOverlayStyle}
		>
			<form onSubmit={onSubmit} style={modalStyle}>
				<h2 id="create-cohort-title" style={modalTitleStyle}>
					New cohort
				</h2>

				<label style={fieldLabelStyle}>
					Slug
					<input
						type="text"
						value={slug}
						onChange={(e) => setSlug(e.target.value)}
						required
						pattern="^[a-z0-9][a-z0-9-]*$"
						maxLength={63}
						placeholder="spring-2026"
						style={inputStyle}
					/>
					<span style={hintStyle}>Lowercase letters, digits, and dashes.</span>
				</label>

				<label style={fieldLabelStyle}>
					Title
					<input
						type="text"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						required
						maxLength={200}
						placeholder="Spring 2026 Bootcamp"
						style={inputStyle}
					/>
				</label>

				<div style={fieldRowStyle}>
					<label style={fieldLabelStyle}>
						Starts
						<input
							type="date"
							value={startAt}
							onChange={(e) => setStartAt(e.target.value)}
							style={inputStyle}
						/>
					</label>
					<label style={fieldLabelStyle}>
						Ends
						<input
							type="date"
							value={endAt}
							onChange={(e) => setEndAt(e.target.value)}
							style={inputStyle}
						/>
					</label>
				</div>

				<label style={fieldLabelStyle}>
					Capacity (optional)
					<input
						type="number"
						min={1}
						value={capacity}
						onChange={(e) => setCapacity(e.target.value)}
						placeholder="50"
						style={inputStyle}
					/>
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
						{submitting ? "Creating…" : "Create cohort"}
					</button>
				</div>
			</form>
		</div>
	);
}

// ── Shared presentational pieces ─────────────────────────────────────────────

function LoadingBanner(): ReactElement {
	return (
		<div style={mutedBannerStyle} role="status" aria-live="polite">
			Loading cohorts…
		</div>
	);
}

function ErrorBanner({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}): ReactElement {
	return (
		<div role="alert" style={errorBannerStyle}>
			<div style={{ marginBlockEnd: "0.5rem" }}>
				Couldn't load cohorts: {message}
			</div>
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

const headerRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "1rem",
	marginBlockEnd: "0.25rem",
};

const pageTitleStyle: CSSProperties = {
	fontSize: "1.5rem",
	marginBlock: 0,
};

const subtitleStyle: CSSProperties = {
	color: "#475569",
	marginBlockStart: 0,
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
	paddingBlock: "0.375rem",
	paddingInline: "0.75rem",
	borderRadius: "0.375rem",
	border: "1px solid #cbd5e1",
	backgroundColor: "white",
	color: "#0f172a",
	cursor: "pointer",
	fontSize: "0.875rem",
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

const thNumStyle: CSSProperties = {
	...thStyle,
	textAlign: "end",
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
	fontFamily:
		"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
	fontSize: "0.875rem",
	color: "#334155",
};

const tdNumStyle: CSSProperties = {
	...tdStyle,
	textAlign: "end",
	fontVariantNumeric: "tabular-nums",
};

const tdActionStyle: CSSProperties = {
	...tdStyle,
	textAlign: "end",
};

const linkStyle: CSSProperties = {
	color: "#2563eb",
	textDecoration: "none",
	fontWeight: 500,
};

const warningBadgeStyle: CSSProperties = {
	display: "inline-block",
	marginInlineStart: "0.375rem",
	paddingInline: "0.375rem",
	borderRadius: "9999px",
	backgroundColor: "#fef3c7",
	color: "#92400e",
	fontSize: "0.75rem",
	fontWeight: 700,
	lineHeight: 1,
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
	inlineSize: "min(28rem, 90vw)",
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

const fieldRowStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "1fr 1fr",
	gap: "0.75rem",
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

export default CohortsPage;
