/**
 * Instructor teaching dashboard — mounts at `/_emdash/admin/plugins/lms-core/`.
 *
 * Renders the three instructor-analytics queries (§16.2):
 *   - `instructor:dashboard-stats`    — headline counters
 *   - `instructor:dashboard-courses`  — courses the caller owns
 *   - `instructor:recent-activity`    — last N events scoped to those courses
 *
 * Shapes reflect what T15 actually returns (`DashboardStats`, `CourseSummary`,
 * `ActivityItem`) — §16.2's wireframe labels pre-date the engine and use
 * slightly different field names; wireframe intent is preserved, field names
 * follow the engine.
 *
 * Per §12 Q19, T19 ships plain HTML + inline styles (same strategy as T01's
 * SetupWizardPage). Kumo + Lingui adoption is the Wave 6 batch refactor that
 * happens after all of T19–T25 land together; that's why no runtime Kumo
 * import appears here yet.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type CSSProperties,
	type ReactElement,
} from "react";

import { COURSES_COLLECTION_SLUG } from "../constants.js";
import {
	LmsApiError,
	createApiClient,
	type ActivityItem,
	type CourseSummary,
	type DashboardStats,
} from "./api-client.js";

const CREATE_COURSE_HREF = `/_emdash/admin/collections/${COURSES_COLLECTION_SLUG}/new`;
const COURSE_DETAIL_BASE = "/_emdash/admin/plugins/lms-core/courses";
const RECENT_ACTIVITY_LIMIT = 10;

interface DashboardData {
	stats: DashboardStats;
	courses: CourseSummary[];
	activity: ActivityItem[];
}

type LoadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; data: DashboardData };

function formatError(err: unknown): string {
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

export function formatPercent(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return `${Math.round(value)}%`;
}

export function formatCount(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return value.toLocaleString("en-US");
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

function activityKey(item: ActivityItem): string {
	const subject = item.quizId ?? item.lessonId ?? item.courseId ?? "";
	return `${item.type}:${item.userId}:${subject}:${item.at}`;
}

export function describeActivity(item: ActivityItem): string {
	const who = item.userName ?? `User ${item.userId.slice(0, 8)}`;
	const where = item.courseTitle ?? "a course";
	switch (item.type) {
		case "enrolled":
			return `${who} enrolled in ${where}`;
		case "completed-course":
			return `${who} completed ${where} — certificate issued`;
		case "lesson-completed":
			return `${who} completed a lesson in ${where}`;
		case "quiz-submitted":
			return `${who} submitted a quiz in ${where}`;
		default:
			return `${who} — ${where}`;
	}
}

export function DashboardPage(): ReactElement {
	const api = useMemo(() => createApiClient(), []);
	const [state, setState] = useState<LoadState>({ kind: "loading" });

	const load = useCallback(async () => {
		setState({ kind: "loading" });
		try {
			const [stats, courses, activity] = await Promise.all([
				api.instructorAnalytics.dashboardStats(),
				api.instructorAnalytics.dashboardCourses(),
				api.instructorAnalytics.recentActivity({ limit: RECENT_ACTIVITY_LIMIT }),
			]);
			setState({ kind: "ready", data: { stats, courses, activity } });
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
					<h1 style={pageTitleStyle}>Teaching dashboard</h1>
					<a href={CREATE_COURSE_HREF} style={primaryLinkStyle}>
						+ Create course
					</a>
				</div>
				<p style={subtitleStyle}>An overview of the learners and courses you teach.</p>
			</header>

			{state.kind === "loading" ? (
				<LoadingBanner />
			) : state.kind === "error" ? (
				<ErrorBanner message={state.message} onRetry={() => void load()} />
			) : (
				<DashboardBody data={state.data} />
			)}
		</section>
	);
}

function DashboardBody({ data }: { data: DashboardData }): ReactElement {
	return (
		<>
			<StatsGrid stats={data.stats} />
			<CoursesTable courses={data.courses} />
			<RecentActivity items={data.activity} />
		</>
	);
}

function StatsGrid({ stats }: { stats: DashboardStats }): ReactElement {
	return (
		<section aria-label="Key metrics" style={statsGridStyle}>
			<StatCard label="Students" value={formatCount(stats.totalStudents)} />
			<StatCard label="Active (30d)" value={formatCount(stats.active30d)} />
			<StatCard label="Avg. completion" value={formatPercent(stats.avgCompletion)} />
			<StatCard label="Quiz pass rate" value={formatPercent(stats.quizPassRate)} />
		</section>
	);
}

function StatCard({ label, value }: { label: string; value: string }): ReactElement {
	return (
		<div style={statCardStyle}>
			<div style={statLabelStyle}>{label}</div>
			<div style={statValueStyle}>{value}</div>
		</div>
	);
}

function CoursesTable({ courses }: { courses: CourseSummary[] }): ReactElement {
	return (
		<section aria-label="Your courses" style={sectionStyle}>
			<h2 style={sectionTitleStyle}>Your courses</h2>
			{courses.length === 0 ? (
				<EmptyState message="You don't have any courses yet. Create one to get started." />
			) : (
				<div style={tableWrapperStyle}>
					<table style={tableStyle}>
						<thead>
							<tr>
								<th style={thStyle}>Title</th>
								<th style={thNumStyle}>Students</th>
								<th style={thNumStyle}>Active (30d)</th>
								<th style={thNumStyle}>Completion</th>
								<th style={thActionStyle} aria-label="Actions" />
							</tr>
						</thead>
						<tbody>
							{courses.map((c) => (
								<tr key={c.courseId}>
									<td style={tdStyle}>{c.title}</td>
									<td style={tdNumStyle}>{formatCount(c.enrolled)}</td>
									<td style={tdNumStyle}>{formatCount(c.active30d)}</td>
									<td style={tdNumStyle}>{formatPercent(c.completionRate)}</td>
									<td style={tdActionStyle}>
										<a
											href={`${COURSE_DETAIL_BASE}/${encodeURIComponent(c.courseId)}`}
											style={linkStyle}
										>
											Open →
										</a>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

function RecentActivity({ items }: { items: ActivityItem[] }): ReactElement {
	return (
		<section aria-label="Recent activity" style={sectionStyle}>
			<h2 style={sectionTitleStyle}>Recent activity</h2>
			{items.length === 0 ? (
				<EmptyState message="No activity yet — once learners enroll or complete work it'll show up here." />
			) : (
				<ul style={activityListStyle}>
					{items.map((item) => (
						<li key={activityKey(item)} style={activityItemStyle}>
							<span>{describeActivity(item)}</span>
							<span style={activityTimeStyle}>{formatRelativeTime(item.at)}</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function LoadingBanner(): ReactElement {
	return (
		<div style={mutedBannerStyle} role="status" aria-live="polite">
			Loading dashboard…
		</div>
	);
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
	return (
		<div role="alert" style={errorBannerStyle}>
			<div style={{ marginBlockEnd: "0.5rem" }}>Couldn't load dashboard: {message}</div>
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

const statsGridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
	gap: "0.75rem",
	marginBlockEnd: "1.5rem",
};

const statCardStyle: CSSProperties = {
	padding: "1rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	backgroundColor: "white",
};

const statLabelStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.8125rem",
	marginBlockEnd: "0.25rem",
};

const statValueStyle: CSSProperties = {
	fontSize: "1.75rem",
	fontWeight: 600,
	fontVariantNumeric: "tabular-nums",
};

const sectionStyle: CSSProperties = {
	marginBlockEnd: "1.5rem",
};

const sectionTitleStyle: CSSProperties = {
	fontSize: "1.125rem",
	marginBlockStart: 0,
	marginBlockEnd: "0.75rem",
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

const activityListStyle: CSSProperties = {
	listStyle: "none",
	paddingInlineStart: 0,
	marginBlock: 0,
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	backgroundColor: "white",
};

const activityItemStyle: CSSProperties = {
	display: "flex",
	justifyContent: "space-between",
	alignItems: "center",
	gap: "1rem",
	paddingBlock: "0.625rem",
	paddingInline: "0.875rem",
	borderBlockStart: "1px solid #f1f5f9",
};

const activityTimeStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.8125rem",
	whiteSpace: "nowrap",
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

export default DashboardPage;
