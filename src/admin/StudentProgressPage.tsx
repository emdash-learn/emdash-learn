/**
 * Per-student progress view (T25 / §16.10a) — mounts at
 * `/_emdash/admin/plugins/lms-core/students/:userId`.
 *
 * Instructor drill-down: one route call (`instructor:student-progress`) shows
 * all of the caller's courses the student is enrolled in. The engine scopes
 * results to courses where the caller has a `course_instructors` row.
 *
 * The engine's `StudentProgress` shape (per `src/engine/analytics.ts:88`) is
 * `{ studentId, courses: Array<{ courseId, courseTitle, enrolledAt,
 * percentComplete, lessonsCompleted, lessonsTotal, completedAt?,
 * lastActivityAt? }> }` — no user profile, no per-course quizzes breakdown.
 * The §16.10a wireframe's "Quizzes" row pre-dates the engine; this page shows
 * what the route actually returns (progress bar + counters) and leaves the
 * quiz summary for a follow-up once the route is enriched.
 *
 * Per §12 Q19, T25 ships plain HTML + inline styles — Kumo + Lingui adoption
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

import { LmsApiError, createApiClient, type StudentProgress } from "./api-client.js";

const PLUGIN_BASE = "/_emdash/admin/plugins/lms-core";
const STUDENTS_PATH_PREFIX = `${PLUGIN_BASE}/students/`;
const DASHBOARD_HREF = `${PLUGIN_BASE}/`;

type StudentCourse = StudentProgress["courses"][number];

type LoadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; data: StudentProgress };

function formatError(err: unknown): string {
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Extract the `:userId` segment from an admin-shell URL like
 * `/_emdash/admin/plugins/lms-core/students/usr_abc`. Returns `null` if the
 * path doesn't match or the segment is empty. Handles `%`-encoded ids so the
 * caller can feed a studentId straight into `encodeURIComponent` when linking
 * here.
 */
export function parseStudentIdFromPath(pathname: string): string | null {
	if (!pathname.startsWith(STUDENTS_PATH_PREFIX)) return null;
	const rest = pathname.slice(STUDENTS_PATH_PREFIX.length);
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

export function formatPercent(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return `${Math.round(value)}%`;
}

export function formatCount(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return value.toLocaleString("en-US");
}

/** `2026-04-18T...` → `18 Apr 2026`. Falls back to the raw string if unparseable. */
export function formatShortDate(isoTimestamp: string): string {
	const parsed = Date.parse(isoTimestamp);
	if (!Number.isFinite(parsed)) return isoTimestamp;
	const d = new Date(parsed);
	// Use UTC slices so the output is deterministic across test machines.
	const day = d.getUTCDate();
	const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
	const year = d.getUTCFullYear();
	return `${day} ${month} ${year}`;
}

export function formatRelativeTime(isoTimestamp: string, now: number = Date.now()): string {
	const then = Date.parse(isoTimestamp);
	if (!Number.isFinite(then)) return isoTimestamp;
	const diffMs = now - then;
	if (diffMs < 0) return "just now";
	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	const years = Math.floor(days / 365);
	return `${years}y ago`;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

export function courseStatus(course: StudentCourse): "completed" | "in-progress" | "not-started" {
	if (course.completedAt) return "completed";
	if (course.lessonsCompleted > 0 || course.percentComplete > 0) return "in-progress";
	return "not-started";
}

export function StudentProgressPage(): ReactElement {
	const studentId = useMemo(() => {
		if (typeof window === "undefined") return null;
		return parseStudentIdFromPath(window.location.pathname);
	}, []);

	const api = useMemo(() => createApiClient(), []);
	const [state, setState] = useState<LoadState>({ kind: "loading" });

	const load = useCallback(async () => {
		if (!studentId) {
			setState({
				kind: "error",
				message:
					"Missing student id in URL — expected /_emdash/admin/plugins/lms-core/students/<id>.",
			});
			return;
		}
		setState({ kind: "loading" });
		try {
			const data = await api.instructorAnalytics.studentProgress({ studentId });
			setState({ kind: "ready", data });
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api, studentId]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<section style={pageStyle}>
			<header style={headerStyle}>
				<a href={DASHBOARD_HREF} style={backLinkStyle}>
					← Back to dashboard
				</a>
				<div style={headerRowStyle}>
					<h1 style={pageTitleStyle}>
						Student progress
						{studentId ? <span style={studentIdStyle}> · {studentId}</span> : null}
					</h1>
				</div>
				<p style={subtitleStyle}>
					Cross-course progress for this student, limited to courses you teach.
				</p>
			</header>

			{state.kind === "loading" ? (
				<LoadingBanner />
			) : state.kind === "error" ? (
				<ErrorBanner message={state.message} onRetry={() => void load()} />
			) : (
				<CoursesList data={state.data} />
			)}
		</section>
	);
}

function CoursesList({ data }: { data: StudentProgress }): ReactElement {
	if (data.courses.length === 0) {
		return <EmptyState message="This student isn't enrolled in any of your courses." />;
	}
	return (
		<>
			<p style={courseCountStyle}>Enrolled in {formatCount(data.courses.length)} of your courses</p>
			<ul style={courseListStyle}>
				{data.courses.map((c) => (
					<CourseCard key={c.courseId} course={c} />
				))}
			</ul>
		</>
	);
}

function CourseCard({ course }: { course: StudentCourse }): ReactElement {
	const status = courseStatus(course);
	const percent = clampPercent(course.percentComplete);
	return (
		<li style={courseCardStyle}>
			<div style={courseHeaderStyle}>
				<h2 style={courseTitleStyle}>{course.courseTitle}</h2>
				<div style={courseMetaStyle}>
					<span>Enrolled {formatShortDate(course.enrolledAt)}</span>
					{course.completedAt ? (
						<span>
							{" · Completed "}
							{formatShortDate(course.completedAt)}
						</span>
					) : course.lastActivityAt ? (
						<span>
							{" · Last active "}
							{formatRelativeTime(course.lastActivityAt)}
						</span>
					) : (
						<span>{" · No activity yet"}</span>
					)}
				</div>
			</div>

			<div style={progressRowStyle}>
				<span style={progressLabelStyle}>Progress</span>
				<div
					style={progressBarTrackStyle}
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(percent)}
				>
					<div style={{ ...progressBarFillStyle, inlineSize: `${percent}%` }} />
				</div>
				<span style={progressValueStyle}>{formatPercent(percent)}</span>
			</div>

			<dl style={metricsStyle}>
				<div style={metricStyle}>
					<dt style={metricLabelStyle}>Lessons</dt>
					<dd style={metricValueStyle}>
						{formatCount(course.lessonsCompleted)} / {formatCount(course.lessonsTotal)} complete
					</dd>
				</div>
				<div style={metricStyle}>
					<dt style={metricLabelStyle}>Status</dt>
					<dd style={metricValueStyle}>
						<StatusBadge status={status} />
					</dd>
				</div>
			</dl>
		</li>
	);
}

function StatusBadge({ status }: { status: ReturnType<typeof courseStatus> }): ReactElement {
	const palette = statusPalette[status];
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

function LoadingBanner(): ReactElement {
	return (
		<div style={mutedBannerStyle} role="status" aria-live="polite">
			Loading student progress…
		</div>
	);
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
	return (
		<div role="alert" style={errorBannerStyle}>
			<div style={{ marginBlockEnd: "0.5rem" }}>Couldn't load student progress: {message}</div>
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

const backLinkStyle: CSSProperties = {
	display: "inline-block",
	color: "#2563eb",
	textDecoration: "none",
	fontSize: "0.875rem",
	marginBlockEnd: "0.75rem",
};

const pageTitleStyle: CSSProperties = {
	fontSize: "1.5rem",
	marginBlock: 0,
};

const studentIdStyle: CSSProperties = {
	color: "#64748b",
	fontWeight: 400,
	fontSize: "1rem",
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
};

const subtitleStyle: CSSProperties = {
	color: "#475569",
	marginBlockStart: 0,
};

const courseCountStyle: CSSProperties = {
	color: "#475569",
	marginBlockStart: 0,
	marginBlockEnd: "0.75rem",
};

const courseListStyle: CSSProperties = {
	listStyle: "none",
	paddingInlineStart: 0,
	marginBlock: 0,
	display: "grid",
	gap: "0.75rem",
};

const courseCardStyle: CSSProperties = {
	padding: "1rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	backgroundColor: "white",
	display: "grid",
	gap: "0.625rem",
};

const courseHeaderStyle: CSSProperties = {
	display: "flex",
	flexWrap: "wrap",
	alignItems: "baseline",
	justifyContent: "space-between",
	gap: "0.5rem",
};

const courseTitleStyle: CSSProperties = {
	fontSize: "1.125rem",
	marginBlock: 0,
};

const courseMetaStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.875rem",
};

const progressRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "0.75rem",
};

const progressLabelStyle: CSSProperties = {
	color: "#475569",
	fontSize: "0.8125rem",
	inlineSize: "4.5rem",
	flexShrink: 0,
};

const progressBarTrackStyle: CSSProperties = {
	flex: 1,
	blockSize: "0.5rem",
	backgroundColor: "#e2e8f0",
	borderRadius: "9999px",
	overflow: "hidden",
};

const progressBarFillStyle: CSSProperties = {
	blockSize: "100%",
	backgroundColor: "#2563eb",
};

const progressValueStyle: CSSProperties = {
	color: "#0f172a",
	fontSize: "0.875rem",
	fontVariantNumeric: "tabular-nums",
	inlineSize: "3rem",
	textAlign: "end",
	flexShrink: 0,
};

const metricsStyle: CSSProperties = {
	display: "flex",
	flexWrap: "wrap",
	gap: "1.5rem",
	marginBlock: 0,
};

const metricStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "0.125rem",
};

const metricLabelStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.75rem",
	textTransform: "uppercase",
	letterSpacing: "0.04em",
};

const metricValueStyle: CSSProperties = {
	color: "#0f172a",
	fontSize: "0.925rem",
	marginInlineStart: 0,
};

const badgeStyle: CSSProperties = {
	display: "inline-block",
	paddingBlock: "0.125rem",
	paddingInline: "0.5rem",
	borderRadius: "9999px",
	fontSize: "0.75rem",
	fontWeight: 600,
};

const statusPalette: Record<
	ReturnType<typeof courseStatus>,
	{ label: string; bg: string; fg: string }
> = {
	completed: { label: "Completed", bg: "#dcfce7", fg: "#166534" },
	"in-progress": { label: "In progress", bg: "#dbeafe", fg: "#1e40af" },
	"not-started": { label: "Not started", bg: "#f1f5f9", fg: "#475569" },
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

export default StudentProgressPage;
