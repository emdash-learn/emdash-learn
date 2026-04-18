/**
 * Quiz list (T21 / §16.5) — mounts at
 * `/_emdash/admin/plugins/lms-core/quizzes`.
 *
 * One route call (`quiz:list`) renders the table.
 *
 * §16.5's wireframe shows Attempts and Pass rate columns alongside Title and
 * Questions. Those aggregates are only returned per-course by
 * `instructor:course-quiz-stats`; there is no cross-course quiz-stats route in
 * v1, and fanning out from the client would N+1 for every course the caller
 * teaches. This page therefore ships Title + Question-count + created-at; the
 * attempt/pass aggregates land when a cross-course stats route is added.
 *
 * Per §12 Q19, T21 ships plain HTML + inline styles — Kumo + Lingui adoption
 * is the Wave 6 batch refactor that lands after T19–T25 together.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type CSSProperties,
	type ReactElement,
} from "react";

import {
	LmsApiError,
	createApiClient,
	type QuizListResponse,
} from "./api-client.js";

const PLUGIN_BASE = "/_emdash/admin/plugins/lms-core";
const QUIZ_EDIT_BASE = `${PLUGIN_BASE}/quizzes`;
const NEW_QUIZ_HREF = `${PLUGIN_BASE}/quizzes/new`;
const PAGE_LIMIT = 50;

type QuizRow = QuizListResponse["items"][number];

type LoadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; items: QuizRow[] };

function formatError(err: unknown): string {
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

export function formatCount(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return value.toLocaleString("en-US");
}

/** `2026-04-18T...` → `18 Apr 2026`. Falls back to the raw string. */
export function formatShortDate(isoTimestamp: string): string {
	const parsed = Date.parse(isoTimestamp);
	if (!Number.isFinite(parsed)) return isoTimestamp;
	const d = new Date(parsed);
	const day = d.getUTCDate();
	const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
	const year = d.getUTCFullYear();
	return `${day} ${month} ${year}`;
}

export function quizEditHref(quizId: string): string {
	return `${QUIZ_EDIT_BASE}/${encodeURIComponent(quizId)}`;
}

export function QuizListPage(): ReactElement {
	const api = useMemo(() => createApiClient(), []);
	const [state, setState] = useState<LoadState>({ kind: "loading" });

	const load = useCallback(async () => {
		setState({ kind: "loading" });
		try {
			const page = await api.quizzes.list({ limit: PAGE_LIMIT });
			setState({ kind: "ready", items: page.items });
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<section style={pageStyle}>
			<header style={headerStyle}>
				<div style={headerRowStyle}>
					<h1 style={pageTitleStyle}>Quizzes</h1>
					<a href={NEW_QUIZ_HREF} style={primaryLinkStyle}>
						+ New quiz
					</a>
				</div>
				<p style={subtitleStyle}>
					Author and manage server-graded quizzes used in your lessons.
				</p>
			</header>

			{state.kind === "loading" ? (
				<LoadingBanner />
			) : state.kind === "error" ? (
				<ErrorBanner message={state.message} onRetry={() => void load()} />
			) : (
				<QuizTable items={state.items} />
			)}
		</section>
	);
}

function QuizTable({ items }: { items: QuizRow[] }): ReactElement {
	if (items.length === 0) {
		return (
			<EmptyState message="No quizzes yet. Create one to grade lesson knowledge checks." />
		);
	}
	return (
		<div style={tableWrapperStyle}>
			<table style={tableStyle}>
				<thead>
					<tr>
						<th style={thStyle}>Title</th>
						<th style={thNumStyle}>Questions</th>
						<th style={thStyle}>Updated</th>
						<th style={thActionStyle} aria-label="Actions" />
					</tr>
				</thead>
				<tbody>
					{items.map((q) => (
						<tr key={q.id}>
							<td style={tdStyle}>{q.title}</td>
							<td style={tdNumStyle}>{formatCount(q.questions.length)}</td>
							<td style={tdStyle}>{formatShortDate(q.updatedAt)}</td>
							<td style={tdActionStyle}>
								<a href={quizEditHref(q.id)} style={linkStyle}>
									Edit →
								</a>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function LoadingBanner(): ReactElement {
	return (
		<div style={mutedBannerStyle} role="status" aria-live="polite">
			Loading quizzes…
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
				Couldn't load quizzes: {message}
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

const primaryLinkStyle: CSSProperties = {
	display: "inline-block",
	paddingBlock: "0.5rem",
	paddingInline: "1rem",
	borderRadius: "0.375rem",
	backgroundColor: "#2563eb",
	color: "white",
	fontWeight: 600,
	textDecoration: "none",
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

export default QuizListPage;
