/**
 * Course detail page (T20 / §16.3) — mounts at
 * `/_emdash/admin/plugins/lms-core/courses/:courseId`.
 *
 * Seven tabs: Overview · Enrollments · Progress · Quizzes · Cohorts ·
 * Discussions · Settings (§16.3).
 *
 * Data sources (all via `src/admin/api-client.ts` per §17.2 rule #2):
 *   - Overview: `instructor:course-overview`,
 *     `instructor:course-enrollments-timeline`,
 *     `instructor:course-completion-funnel`.
 *   - Enrollments: `instructor:course-progress-matrix` +
 *     `instructor:enrollments-export` (CSV download). The §16.4 wireframe's
 *     filter chrome + bulk actions require routes that don't exist in v1;
 *     this tab ships the data we have — student name + overall progress —
 *     plus an "Export CSV" action.
 *   - Progress: `instructor:course-progress-matrix` rendered as a
 *     student × lesson heatmap. Lesson columns are derived from the union
 *     of lessonIds across the returned students (the matrix response is the
 *     only per-course lesson listing available to the admin client in v1).
 *   - Quizzes: `instructor:course-quiz-stats`. The wireframe's "Attached to
 *     lesson" column isn't included in `QuizStats` and is omitted until the
 *     route is enriched.
 *   - Cohorts: stubbed — cohorts attach to enrollments, not courses, and
 *     there is no per-course cohort-listing route in v1. The tab links out
 *     to the global cohorts admin page.
 *   - Discussions: stubbed per the task prompt — emdash's built-in comments
 *     UI isn't embeddable from a plugin; the tab links out to the core
 *     admin shell.
 *   - Settings: stubbed — `enrollment_open`, `enrollment_opens_at`,
 *     `enrollment_closes_at`, and the drip-mode override are schema fields
 *     on the `courses` content collection, edited via the emdash content
 *     editor. The plugin has no per-course admin mutation route in v1, so
 *     the tab links out to the content editor and explains what to change
 *     there. "Archive all enrollments" has no backend route either; it's
 *     listed as a v2 gap, not an inert button.
 *
 * Per §12 Q19, T20 ships plain HTML + inline styles like T19/T22/T23/T25 —
 * Kumo + Lingui adoption is the Wave 6 batch refactor that lands after
 * T19–T25 together.
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
	type CompletionFunnel,
	type CourseOverview,
	type ProgressMatrix,
	type QuizStats,
	type TimelinePoint,
} from "./api-client.js";

// ---------------------------------------------------------------------------
// URL constants + parser
// ---------------------------------------------------------------------------

const PLUGIN_BASE = "/_emdash/admin/plugins/lms-core";
const COURSES_PATH_PREFIX = `${PLUGIN_BASE}/courses/`;
const DASHBOARD_HREF = `${PLUGIN_BASE}/`;
const COHORTS_HREF = `${PLUGIN_BASE}/cohorts`;
const QUIZ_EDIT_BASE = `${PLUGIN_BASE}/quizzes`;
const STUDENT_DETAIL_BASE = `${PLUGIN_BASE}/students`;
const CONTENT_EDITOR_BASE = `/_emdash/admin/collections/${COURSES_COLLECTION_SLUG}`;
// TODO(T20): emdash's built-in comments admin URL isn't re-exported from the
// plugin API. Link to the core admin root; verify the exact path once
// emdash's admin shell settles.
const CORE_ADMIN_COMMENTS_HREF = "/_emdash/admin";

const PROGRESS_PAGE_LIMIT = 50;
const TIMELINE_DAYS = 30;

/**
 * Extract the `:courseId` segment from an admin-shell URL like
 * `/_emdash/admin/plugins/lms-core/courses/crs_abc`. Returns `null` if the
 * path doesn't match or the segment is empty. Handles `%`-encoded ids so a
 * caller can feed a courseId straight into `encodeURIComponent` when linking
 * here.
 */
export function parseCourseIdFromPath(pathname: string): string | null {
	if (!pathname.startsWith(COURSES_PATH_PREFIX)) return null;
	const rest = pathname.slice(COURSES_PATH_PREFIX.length);
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

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatCount(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return value.toLocaleString("en-US");
}

export function formatPercent(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return `${Math.round(value)}%`;
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

function formatError(err: unknown): string {
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

// ---------------------------------------------------------------------------
// Tab model
// ---------------------------------------------------------------------------

type TabKey =
	| "overview"
	| "enrollments"
	| "progress"
	| "quizzes"
	| "cohorts"
	| "discussions"
	| "settings";

const TABS: Array<{ key: TabKey; label: string }> = [
	{ key: "overview", label: "Overview" },
	{ key: "enrollments", label: "Enrollments" },
	{ key: "progress", label: "Progress" },
	{ key: "quizzes", label: "Quizzes" },
	{ key: "cohorts", label: "Cohorts" },
	{ key: "discussions", label: "Discussions" },
	{ key: "settings", label: "Settings" },
];

type Api = ReturnType<typeof createApiClient>;

type HeaderState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; overview: CourseOverview };

export function CoursePage(): ReactElement {
	const courseId = useMemo(() => {
		if (typeof window === "undefined") return null;
		return parseCourseIdFromPath(window.location.pathname);
	}, []);

	const api = useMemo(() => createApiClient(), []);
	const [activeTab, setActiveTab] = useState<TabKey>("overview");
	const [headerState, setHeaderState] = useState<HeaderState>({
		kind: "loading",
	});

	const loadHeader = useCallback(async () => {
		if (!courseId) {
			setHeaderState({
				kind: "error",
				message:
					"Missing course id in URL — expected /_emdash/admin/plugins/lms-core/courses/<id>.",
			});
			return;
		}
		setHeaderState({ kind: "loading" });
		try {
			const overview = await api.instructorAnalytics.courseOverview({
				courseId,
			});
			setHeaderState({ kind: "ready", overview });
		} catch (err) {
			setHeaderState({ kind: "error", message: formatError(err) });
		}
	}, [api, courseId]);

	useEffect(() => {
		void loadHeader();
	}, [loadHeader]);

	return (
		<section style={pageStyle}>
			<header style={pageHeaderStyle}>
				<a href={DASHBOARD_HREF} style={backLinkStyle}>
					← Back to dashboard
				</a>
				<CourseHeader state={headerState} courseId={courseId} />
			</header>

			{!courseId ? (
				<ErrorBanner
					message={headerState.kind === "error" ? headerState.message : "Missing course id."}
					onRetry={() => void loadHeader()}
				/>
			) : (
				<>
					<TabNav active={activeTab} onChange={setActiveTab} />
					<TabPanel activeTab={activeTab} api={api} courseId={courseId} headerState={headerState} />
				</>
			)}
		</section>
	);
}

function CourseHeader({
	state,
	courseId,
}: {
	state: HeaderState;
	courseId: string | null;
}): ReactElement {
	const editHref = courseId
		? `${CONTENT_EDITOR_BASE}/${encodeURIComponent(courseId)}`
		: CONTENT_EDITOR_BASE;

	if (state.kind === "loading") {
		return (
			<div style={headerRowStyle}>
				<h1 style={pageTitleStyle}>Course</h1>
				<a href={editHref} style={secondaryLinkStyle}>
					Edit content
				</a>
			</div>
		);
	}
	if (state.kind === "error") {
		return (
			<div style={headerRowStyle}>
				<h1 style={pageTitleStyle}>Course</h1>
				<a href={editHref} style={secondaryLinkStyle}>
					Edit content
				</a>
			</div>
		);
	}
	const { overview } = state;
	return (
		<div style={headerRowStyle}>
			<h1 style={pageTitleStyle}>{overview.title}</h1>
			<a href={editHref} style={secondaryLinkStyle}>
				Edit content
			</a>
		</div>
	);
}

function TabNav({
	active,
	onChange,
}: {
	active: TabKey;
	onChange: (key: TabKey) => void;
}): ReactElement {
	return (
		<nav aria-label="Course sections" style={tabNavStyle}>
			<ul style={tabListStyle}>
				{TABS.map((tab) => {
					const isActive = tab.key === active;
					return (
						<li key={tab.key} style={tabListItemStyle}>
							<button
								type="button"
								onClick={() => onChange(tab.key)}
								aria-current={isActive ? "page" : undefined}
								style={isActive ? tabButtonActiveStyle : tabButtonStyle}
							>
								{tab.label}
							</button>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

function TabPanel({
	activeTab,
	api,
	courseId,
	headerState,
}: {
	activeTab: TabKey;
	api: Api;
	courseId: string;
	headerState: HeaderState;
}): ReactElement {
	if (activeTab === "overview") {
		return <OverviewTab api={api} courseId={courseId} headerState={headerState} />;
	}
	if (activeTab === "enrollments") {
		return <EnrollmentsTab api={api} courseId={courseId} />;
	}
	if (activeTab === "progress") {
		return <ProgressTab api={api} courseId={courseId} />;
	}
	if (activeTab === "quizzes") {
		return <QuizzesTab api={api} courseId={courseId} />;
	}
	if (activeTab === "cohorts") return <CohortsTab />;
	if (activeTab === "discussions") return <DiscussionsTab courseId={courseId} />;
	return <SettingsTab courseId={courseId} />;
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

interface OverviewData {
	overview: CourseOverview;
	timeline: TimelinePoint[];
	funnel: CompletionFunnel;
}

type OverviewState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; data: OverviewData };

function OverviewTab({
	api,
	courseId,
	headerState,
}: {
	api: Api;
	courseId: string;
	headerState: HeaderState;
}): ReactElement {
	const [state, setState] = useState<OverviewState>({ kind: "loading" });

	const load = useCallback(async () => {
		setState({ kind: "loading" });
		try {
			const [overview, timeline, funnel] = await Promise.all([
				// Prefer the header-state overview when already fetched, otherwise
				// request it (cheap and keeps this tab self-contained if a parent
				// refactor drops the shared fetch).
				headerState.kind === "ready"
					? Promise.resolve(headerState.overview)
					: api.instructorAnalytics.courseOverview({ courseId }),
				api.instructorAnalytics.courseEnrollmentsTimeline({
					courseId,
					days: TIMELINE_DAYS,
				}),
				api.instructorAnalytics.courseCompletionFunnel({ courseId }),
			]);
			setState({ kind: "ready", data: { overview, timeline, funnel } });
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api, courseId, headerState]);

	useEffect(() => {
		void load();
	}, [load]);

	if (state.kind === "loading") return <LoadingBanner label="Loading overview…" />;
	if (state.kind === "error") {
		return <ErrorBanner message={state.message} onRetry={() => void load()} />;
	}

	return (
		<div style={tabBodyStyle}>
			<StatsGrid overview={state.data.overview} />
			<section aria-label="Enrollments over time" style={sectionStyle}>
				<h2 style={sectionTitleStyle}>Enrollments — last 30 days</h2>
				<TimelineChart points={state.data.timeline} />
			</section>
			<section aria-label="Completion funnel" style={sectionStyle}>
				<h2 style={sectionTitleStyle}>Completion funnel</h2>
				<FunnelChart funnel={state.data.funnel} />
			</section>
		</div>
	);
}

function StatsGrid({ overview }: { overview: CourseOverview }): ReactElement {
	return (
		<section aria-label="Key metrics" style={statsGridStyle}>
			<StatCard label="Enrolled" value={formatCount(overview.enrolled)} />
			<StatCard label="Completed" value={formatCount(overview.completed)} />
			<StatCard label="Active (30d)" value={formatCount(overview.active30d)} />
			<StatCard label="Avg progress" value={formatPercent(overview.avgProgress)} />
			{/* Revenue card intentionally omitted — payments aren't wired in v1 per §16.3 note. */}
			<StatCard label="Revenue" value="—" hint="Deferred to v2" />
		</section>
	);
}

function StatCard({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
	hint?: string;
}): ReactElement {
	return (
		<div style={statCardStyle}>
			<div style={statLabelStyle}>{label}</div>
			<div style={statValueStyle}>{value}</div>
			{hint ? <div style={statHintStyle}>{hint}</div> : null}
		</div>
	);
}

/**
 * Tiny inline-SVG line chart. No external dep (per §12 Q19 "plain HTML"
 * decision) — draws a single polyline across the `points` array with a
 * baseline axis and a simple "peak" marker. Falls back to an empty state
 * when every bucket is zero.
 */
function TimelineChart({ points }: { points: TimelinePoint[] }): ReactElement {
	if (points.length === 0) {
		return <EmptyState message="No enrollments in the last 30 days." />;
	}
	const max = points.reduce((acc, p) => (p.count > acc ? p.count : acc), 0);
	if (max === 0) {
		return <EmptyState message="No enrollments in the last 30 days." />;
	}

	const chartWidth = 600;
	const chartHeight = 160;
	const padX = 24;
	const padY = 16;
	const innerW = chartWidth - padX * 2;
	const innerH = chartHeight - padY * 2;
	const step = points.length > 1 ? innerW / (points.length - 1) : 0;

	const coords = points.map((p, i) => {
		const x = padX + i * step;
		const y = padY + innerH - (p.count / max) * innerH;
		return { x, y, point: p };
	});
	const pathD = coords
		.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
		.join(" ");
	const totalEnrolled = points.reduce((acc, p) => acc + p.count, 0);

	return (
		<div style={chartWrapperStyle}>
			<svg
				viewBox={`0 0 ${chartWidth} ${chartHeight}`}
				role="img"
				aria-label={`Enrollments timeline, ${points.length} days, peak ${max}`}
				style={chartSvgStyle}
				preserveAspectRatio="none"
			>
				<line
					x1={padX}
					x2={chartWidth - padX}
					y1={chartHeight - padY}
					y2={chartHeight - padY}
					stroke="#cbd5e1"
					strokeWidth={1}
				/>
				<path
					d={pathD}
					fill="none"
					stroke="#2563eb"
					strokeWidth={2}
					strokeLinejoin="round"
					strokeLinecap="round"
				/>
				{coords.map((c) => (
					<circle key={c.point.date} cx={c.x} cy={c.y} r={2.5} fill="#2563eb">
						<title>{`${formatShortDate(c.point.date)}: ${formatCount(c.point.count)}`}</title>
					</circle>
				))}
			</svg>
			<dl style={chartSummaryStyle}>
				<div style={metaItemStyle}>
					<dt style={metaLabelStyle}>Total</dt>
					<dd style={metaValueStyle}>{formatCount(totalEnrolled)}</dd>
				</div>
				<div style={metaItemStyle}>
					<dt style={metaLabelStyle}>Peak day</dt>
					<dd style={metaValueStyle}>{formatCount(max)}</dd>
				</div>
				<div style={metaItemStyle}>
					<dt style={metaLabelStyle}>Range</dt>
					<dd style={metaValueStyle}>
						{formatShortDate(points[0]!.date)} — {formatShortDate(points[points.length - 1]!.date)}
					</dd>
				</div>
			</dl>
		</div>
	);
}

function FunnelChart({ funnel }: { funnel: CompletionFunnel }): ReactElement {
	const started = funnel.started;
	if (started === 0) {
		return (
			<EmptyState message="No enrollments yet — the funnel populates after the first student enrolls." />
		);
	}
	const rows: Array<{ label: string; value: number }> = [
		{ label: "Started", value: funnel.started },
		{ label: "25% complete", value: funnel.q25 },
		{ label: "50% complete", value: funnel.q50 },
		{ label: "75% complete", value: funnel.q75 },
		{ label: "Completed", value: funnel.completed },
	];
	return (
		<ul style={funnelListStyle}>
			{rows.map((row) => {
				const pct = started > 0 ? (row.value / started) * 100 : 0;
				return (
					<li key={row.label} style={funnelItemStyle}>
						<div style={funnelHeaderStyle}>
							<span style={funnelLabelStyle}>{row.label}</span>
							<span style={funnelValueStyle}>
								{formatCount(row.value)} · {formatPercent(pct)}
							</span>
						</div>
						<div
							style={funnelTrackStyle}
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round(pct)}
						>
							<div
								style={{
									...funnelFillStyle,
									inlineSize: `${Math.max(pct, 0).toFixed(1)}%`,
								}}
							/>
						</div>
					</li>
				);
			})}
		</ul>
	);
}

// ---------------------------------------------------------------------------
// Enrollments tab
// ---------------------------------------------------------------------------

type EnrollmentsState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; matrix: ProgressMatrix; exporting: boolean };

/**
 * §16.4 wireframe filters + bulk actions require routes that don't exist in
 * v1 (source/cohort filter, grant, revoke-many, message, move-to-cohort).
 * This tab renders the one per-course student signal we have — overall
 * progress — plus a CSV export button. Clicking a row deep-links to the
 * per-student page (§16.10a).
 */
function EnrollmentsTab({ api, courseId }: { api: Api; courseId: string }): ReactElement {
	const [state, setState] = useState<EnrollmentsState>({ kind: "loading" });

	const load = useCallback(async () => {
		setState({ kind: "loading" });
		try {
			const matrix = await api.instructorAnalytics.courseProgressMatrix({
				courseId,
				limit: PROGRESS_PAGE_LIMIT,
			});
			setState({ kind: "ready", matrix, exporting: false });
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api, courseId]);

	useEffect(() => {
		void load();
	}, [load]);

	const onExport = useCallback(async () => {
		setState((prev) => (prev.kind === "ready" ? { ...prev, exporting: true } : prev));
		try {
			const res = await api.instructorAnalytics.enrollmentsExport({ courseId });
			downloadCsv(res.csv, `enrollments-${courseId}.csv`);
		} catch (err) {
			if (typeof window !== "undefined") window.alert(formatError(err));
		} finally {
			setState((prev) => (prev.kind === "ready" ? { ...prev, exporting: false } : prev));
		}
	}, [api, courseId]);

	if (state.kind === "loading") {
		return <LoadingBanner label="Loading enrollments…" />;
	}
	if (state.kind === "error") {
		return <ErrorBanner message={state.message} onRetry={() => void load()} />;
	}

	const { matrix } = state;
	if (matrix.students.length === 0) {
		return (
			<div style={tabBodyStyle}>
				<EmptyState message="No enrollments in this course yet." />
			</div>
		);
	}

	const lessonIds = collectLessonIds(matrix);
	return (
		<div style={tabBodyStyle}>
			<div style={sectionHeaderStyle}>
				<p style={mutedTextStyle}>
					Showing {formatCount(matrix.students.length)} students. Advanced filters and bulk actions
					are planned for v2; use CSV export below for offline analysis.
				</p>
				<div style={sectionActionsStyle}>
					<button
						type="button"
						onClick={() => void onExport()}
						disabled={state.exporting}
						style={secondaryButtonStyle}
					>
						{state.exporting ? "Exporting…" : "Export CSV"}
					</button>
				</div>
			</div>
			<div style={tableWrapperStyle}>
				<table style={tableStyle}>
					<thead>
						<tr>
							<th style={thStyle}>Student</th>
							<th style={thNumStyle}>Overall progress</th>
							<th style={thNumStyle}>Lessons seen</th>
							<th style={thActionStyle} aria-label="Actions" />
						</tr>
					</thead>
					<tbody>
						{matrix.students.map((student) => {
							const pct = computeOverallPercent(student.lessonProgress, lessonIds);
							const seen = Object.keys(student.lessonProgress).length;
							const href = `${STUDENT_DETAIL_BASE}/${encodeURIComponent(student.userId)}`;
							return (
								<tr key={student.userId}>
									<td style={tdStyle}>
										<a href={href} style={linkStyle}>
											{student.name || student.userId}
										</a>
									</td>
									<td style={tdNumStyle}>{formatPercent(pct)}</td>
									<td style={tdNumStyle}>{formatCount(seen)}</td>
									<td style={tdActionStyle}>
										<a href={href} style={linkStyle}>
											Open →
										</a>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{matrix.nextCursor ? (
				<p style={mutedTextStyle}>
					More students available. Page-through in the Progress tab loads additional records.
				</p>
			) : null}
		</div>
	);
}

function collectLessonIds(matrix: ProgressMatrix): string[] {
	const set = new Set<string>();
	for (const s of matrix.students) {
		for (const id of Object.keys(s.lessonProgress)) set.add(id);
	}
	const ids = Array.from(set);
	// oxlint-disable-next-line no-array-sort -- stable, deterministic column order
	ids.sort();
	return ids;
}

function computeOverallPercent(progress: Record<string, number>, lessonIds: string[]): number {
	if (lessonIds.length === 0) return 0;
	let sum = 0;
	for (const id of lessonIds) {
		const v = progress[id];
		if (typeof v === "number" && Number.isFinite(v)) sum += v;
	}
	return sum / lessonIds.length;
}

function downloadCsv(csv: string, filename: string): void {
	if (typeof window === "undefined" || typeof document === "undefined") return;
	const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Progress tab (heatmap)
// ---------------------------------------------------------------------------

type Sort =
	| { key: "name"; dir: "asc" | "desc" }
	| { key: "overall"; dir: "asc" | "desc" }
	| { key: "lesson"; lessonId: string; dir: "asc" | "desc" };

type ProgressState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| {
			kind: "ready";
			pages: ProgressMatrix[];
			pageIndex: number;
			loadingMore: boolean;
			sort: Sort;
	  };

const INITIAL_SORT: Sort = { key: "name", dir: "asc" };

function ProgressTab({ api, courseId }: { api: Api; courseId: string }): ReactElement {
	const [state, setState] = useState<ProgressState>({ kind: "loading" });

	const load = useCallback(async () => {
		setState({ kind: "loading" });
		try {
			const first = await api.instructorAnalytics.courseProgressMatrix({
				courseId,
				limit: PROGRESS_PAGE_LIMIT,
			});
			setState({
				kind: "ready",
				pages: [first],
				pageIndex: 0,
				loadingMore: false,
				sort: INITIAL_SORT,
			});
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api, courseId]);

	useEffect(() => {
		void load();
	}, [load]);

	const gotoNext = useCallback(async () => {
		if (state.kind !== "ready") return;
		const { pages, pageIndex } = state;
		// Already have the next page cached?
		if (pageIndex + 1 < pages.length) {
			setState({ ...state, pageIndex: pageIndex + 1 });
			return;
		}
		const current = pages[pageIndex]!;
		if (!current.nextCursor) return;
		setState({ ...state, loadingMore: true });
		try {
			const next = await api.instructorAnalytics.courseProgressMatrix({
				courseId,
				cursor: current.nextCursor,
				limit: PROGRESS_PAGE_LIMIT,
			});
			setState({
				kind: "ready",
				pages: [...pages, next],
				pageIndex: pageIndex + 1,
				loadingMore: false,
				sort: state.sort,
			});
		} catch (err) {
			if (typeof window !== "undefined") window.alert(formatError(err));
			setState({ ...state, loadingMore: false });
		}
	}, [api, courseId, state]);

	const gotoPrev = useCallback(() => {
		if (state.kind !== "ready") return;
		if (state.pageIndex === 0) return;
		setState({ ...state, pageIndex: state.pageIndex - 1 });
	}, [state]);

	const setSort = useCallback(
		(next: Sort) => {
			if (state.kind !== "ready") return;
			setState({ ...state, sort: next });
		},
		[state],
	);

	if (state.kind === "loading") return <LoadingBanner label="Loading progress…" />;
	if (state.kind === "error") {
		return <ErrorBanner message={state.message} onRetry={() => void load()} />;
	}

	const current = state.pages[state.pageIndex]!;
	if (current.students.length === 0) {
		return (
			<div style={tabBodyStyle}>
				<EmptyState message="No student progress yet." />
			</div>
		);
	}

	const lessonIds = collectLessonIds(current);
	const sortedStudents = sortStudents(current.students, lessonIds, state.sort);
	const hasPrev = state.pageIndex > 0;
	const hasNext = state.pageIndex + 1 < state.pages.length || Boolean(current.nextCursor);

	return (
		<div style={tabBodyStyle}>
			<div style={sectionHeaderStyle}>
				<p style={mutedTextStyle}>
					Page {state.pageIndex + 1}. {formatCount(sortedStudents.length)} students ×{" "}
					{formatCount(lessonIds.length)} lessons. Click a cell to open that student's progress.
				</p>
				<div style={sectionActionsStyle}>
					<button type="button" onClick={gotoPrev} disabled={!hasPrev} style={secondaryButtonStyle}>
						← Previous
					</button>
					<button
						type="button"
						onClick={() => void gotoNext()}
						disabled={!hasNext || state.loadingMore}
						style={secondaryButtonStyle}
					>
						{state.loadingMore ? "Loading…" : "Next →"}
					</button>
				</div>
			</div>
			<div style={heatmapScrollStyle}>
				<table style={heatmapTableStyle}>
					<thead>
						<tr>
							<th style={heatmapStickyThStyle}>
								<button
									type="button"
									onClick={() =>
										setSort({
											key: "name",
											dir: state.sort.key === "name" && state.sort.dir === "asc" ? "desc" : "asc",
										})
									}
									style={heatmapSortButtonStyle}
								>
									Student {renderSortIndicator(state.sort, "name")}
								</button>
							</th>
							<th style={heatmapOverallThStyle}>
								<button
									type="button"
									onClick={() =>
										setSort({
											key: "overall",
											dir:
												state.sort.key === "overall" && state.sort.dir === "desc" ? "asc" : "desc",
										})
									}
									style={heatmapSortButtonStyle}
								>
									Overall {renderSortIndicator(state.sort, "overall")}
								</button>
							</th>
							{lessonIds.map((lid, i) => (
								<th key={lid} style={heatmapLessonThStyle} title={lid}>
									<button
										type="button"
										onClick={() =>
											setSort({
												key: "lesson",
												lessonId: lid,
												dir:
													state.sort.key === "lesson" &&
													state.sort.lessonId === lid &&
													state.sort.dir === "desc"
														? "asc"
														: "desc",
											})
										}
										style={heatmapSortButtonStyle}
									>
										L{i + 1}
										{state.sort.key === "lesson" && state.sort.lessonId === lid
											? state.sort.dir === "desc"
												? " ↓"
												: " ↑"
											: ""}
									</button>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{sortedStudents.map((student) => {
							const overall = computeOverallPercent(student.lessonProgress, lessonIds);
							return (
								<tr key={student.userId}>
									<th scope="row" style={heatmapStickyRowThStyle}>
										<a
											href={`${STUDENT_DETAIL_BASE}/${encodeURIComponent(student.userId)}`}
											style={linkStyle}
										>
											{student.name || student.userId}
										</a>
									</th>
									<td style={heatmapOverallCellStyle(overall)}>{formatPercent(overall)}</td>
									{lessonIds.map((lid) => {
										const pct = student.lessonProgress[lid];
										const href = `${STUDENT_DETAIL_BASE}/${encodeURIComponent(student.userId)}`;
										return (
											<td
												key={lid}
												style={heatmapCellStyle(pct)}
												title={`${student.name || student.userId} · ${lid}: ${
													typeof pct === "number" ? `${Math.round(pct)}%` : "—"
												}`}
											>
												<a href={href} style={heatmapCellLinkStyle}>
													{renderHeatmapCell(pct)}
												</a>
											</td>
										);
									})}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function renderSortIndicator(sort: Sort, key: Sort["key"]): string {
	if (sort.key !== key) return "";
	if (key === "lesson") return "";
	return sort.dir === "desc" ? " ↓" : " ↑";
}

function sortStudents(
	students: ProgressMatrix["students"],
	lessonIds: string[],
	sort: Sort,
): ProgressMatrix["students"] {
	const copy = [...students];
	if (sort.key === "name") {
		copy.sort((a, b) => {
			const an = (a.name || a.userId).toLowerCase();
			const bn = (b.name || b.userId).toLowerCase();
			if (an < bn) return sort.dir === "asc" ? -1 : 1;
			if (an > bn) return sort.dir === "asc" ? 1 : -1;
			return 0;
		});
		return copy;
	}
	if (sort.key === "overall") {
		copy.sort((a, b) => {
			const av = computeOverallPercent(a.lessonProgress, lessonIds);
			const bv = computeOverallPercent(b.lessonProgress, lessonIds);
			return sort.dir === "asc" ? av - bv : bv - av;
		});
		return copy;
	}
	// lesson
	const { lessonId, dir } = sort;
	copy.sort((a, b) => {
		const av = a.lessonProgress[lessonId] ?? -1;
		const bv = b.lessonProgress[lessonId] ?? -1;
		return dir === "asc" ? av - bv : bv - av;
	});
	return copy;
}

function renderHeatmapCell(pct: number | undefined): string {
	if (typeof pct !== "number" || !Number.isFinite(pct)) return "·";
	if (pct >= 100) return "✓";
	if (pct <= 0) return "·";
	return `${Math.round(pct)}`;
}

function heatmapCellStyle(pct: number | undefined): CSSProperties {
	const palette = heatmapPalette(pct);
	return {
		...heatmapCellBaseStyle,
		backgroundColor: palette.bg,
		color: palette.fg,
	};
}

function heatmapOverallCellStyle(pct: number): CSSProperties {
	const palette = heatmapPalette(pct);
	return {
		...heatmapOverallCellBaseStyle,
		backgroundColor: palette.bg,
		color: palette.fg,
	};
}

function heatmapPalette(pct: number | undefined): { bg: string; fg: string } {
	if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0) {
		return { bg: "#f8fafc", fg: "#94a3b8" };
	}
	if (pct >= 100) return { bg: "#15803d", fg: "white" };
	if (pct >= 75) return { bg: "#22c55e", fg: "white" };
	if (pct >= 50) return { bg: "#facc15", fg: "#78350f" };
	if (pct >= 25) return { bg: "#fed7aa", fg: "#7c2d12" };
	return { bg: "#fee2e2", fg: "#991b1b" };
}

// ---------------------------------------------------------------------------
// Quizzes tab
// ---------------------------------------------------------------------------

type QuizzesState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; items: QuizStats[] };

function QuizzesTab({ api, courseId }: { api: Api; courseId: string }): ReactElement {
	const [state, setState] = useState<QuizzesState>({ kind: "loading" });

	const load = useCallback(async () => {
		setState({ kind: "loading" });
		try {
			const items = await api.instructorAnalytics.courseQuizStats({ courseId });
			setState({ kind: "ready", items });
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api, courseId]);

	useEffect(() => {
		void load();
	}, [load]);

	if (state.kind === "loading") return <LoadingBanner label="Loading quizzes…" />;
	if (state.kind === "error") {
		return <ErrorBanner message={state.message} onRetry={() => void load()} />;
	}
	if (state.items.length === 0) {
		return (
			<div style={tabBodyStyle}>
				<EmptyState message="No quizzes attached to this course yet." />
			</div>
		);
	}

	return (
		<div style={tabBodyStyle}>
			<div style={tableWrapperStyle}>
				<table style={tableStyle}>
					<thead>
						<tr>
							<th style={thStyle}>Quiz</th>
							<th style={thNumStyle}>Attempts</th>
							<th style={thNumStyle}>Pass rate</th>
							<th style={thNumStyle}>Avg score</th>
							<th style={thActionStyle} aria-label="Actions" />
						</tr>
					</thead>
					<tbody>
						{state.items.map((quiz) => {
							const href = `${QUIZ_EDIT_BASE}/${encodeURIComponent(quiz.quizId)}`;
							return (
								<tr key={quiz.quizId}>
									<td style={tdStyle}>
										<a href={href} style={linkStyle}>
											{quiz.title || quiz.quizId}
										</a>
									</td>
									<td style={tdNumStyle}>{formatCount(quiz.attempts)}</td>
									<td style={tdNumStyle}>{formatPercent(quiz.passRate)}</td>
									<td style={tdNumStyle}>{formatPercent(quiz.avgScore)}</td>
									<td style={tdActionStyle}>
										<a href={href} style={linkStyle}>
											Edit →
										</a>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			<p style={mutedTextStyle}>
				The "Attached to lesson" column from §16.3 will land once `instructor:course-quiz-stats`
				returns a lessonId alongside the quiz aggregates.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Cohorts tab — stub
// ---------------------------------------------------------------------------

function CohortsTab(): ReactElement {
	return (
		<div style={tabBodyStyle}>
			<div style={stubCardStyle}>
				<h2 style={sectionTitleStyle}>Cohorts</h2>
				<p style={mutedTextStyle}>
					Per-course cohort listing isn't available in v1 — cohorts attach to enrollments rather
					than courses, and there's no <code>instructor:course-cohorts</code> route yet. Manage
					cohorts from the global cohort admin page; the detail view lists members and the courses
					they were enrolled in.
				</p>
				<div style={sectionActionsStyle}>
					<a href={COHORTS_HREF} style={primaryLinkStyle}>
						Open cohort admin →
					</a>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Discussions tab — stub
// ---------------------------------------------------------------------------

function DiscussionsTab({ courseId }: { courseId: string }): ReactElement {
	return (
		<div style={tabBodyStyle}>
			<div style={stubCardStyle}>
				<h2 style={sectionTitleStyle}>Discussions</h2>
				<p style={mutedTextStyle}>
					Lesson discussions reuse emdash's built-in comments UI, which isn't embeddable from a
					plugin surface. Moderate comments from the core admin comments view; filter by lesson slug
					to scope to this course.
				</p>
				{/* TODO(T20): swap CORE_ADMIN_COMMENTS_HREF for the real comments URL
				    once emdash exports it. Tracking the missing lesson-scoped filter
				    in follow-up. */}
				<div style={sectionActionsStyle}>
					<a
						href={`${CONTENT_EDITOR_BASE}/${encodeURIComponent(courseId)}`}
						style={secondaryLinkStyle}
					>
						Jump to course content
					</a>
					<a href={CORE_ADMIN_COMMENTS_HREF} style={primaryLinkStyle}>
						Open core admin →
					</a>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Settings tab — stub
// ---------------------------------------------------------------------------

function SettingsTab({ courseId }: { courseId: string }): ReactElement {
	const editHref = `${CONTENT_EDITOR_BASE}/${encodeURIComponent(courseId)}`;
	return (
		<div style={tabBodyStyle}>
			<div style={stubCardStyle}>
				<h2 style={sectionTitleStyle}>Course settings</h2>
				<p style={mutedTextStyle}>
					Per-course settings — <code>enrollment_open</code>, <code>enrollment_opens_at</code>,{" "}
					<code>enrollment_closes_at</code>, and the drip-mode override — live as schema fields on
					the <code>courses</code> collection. Edit them in the emdash content editor; changes apply
					instantly to the engine.
				</p>
				<ul style={bulletListStyle}>
					<li>
						<strong>Enrollment open:</strong> toggles whether{" "}
						<code>engine.enrollments.grant()</code> accepts new students.
					</li>
					<li>
						<strong>Enrollment window:</strong> open/close dates gate enrollment outside the window
						(returns <code>LEARN_ENROLLMENT_CLOSED</code>).
					</li>
					<li>
						<strong>Drip mode:</strong> per-course override of the plugin-wide default; controls how{" "}
						<code>drip_offset_days</code> on lessons is interpreted.
					</li>
				</ul>
				<div style={sectionActionsStyle}>
					<a href={editHref} style={primaryLinkStyle}>
						Edit course fields →
					</a>
				</div>
				{/* TODO(T20): "Archive all enrollments" bulk action (§16.3 danger zone)
				    has no backend route in v1 — add once `instructor:enrollments-archive`
				    (or an engine equivalent) exists; needs ConfirmDialog + admin
				    authorization check. */}
				<p style={stubDangerHintStyle}>
					Archive-all-enrollments is planned for v2 (requires an{" "}
					<code>instructor:enrollments-archive</code> route that doesn't ship in v1).
				</p>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Shared presentational
// ---------------------------------------------------------------------------

function LoadingBanner({ label }: { label: string }): ReactElement {
	return (
		<div style={mutedBannerStyle} role="status" aria-live="polite">
			{label}
		</div>
	);
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
	return (
		<div role="alert" style={errorBannerStyle}>
			<div style={{ marginBlockEnd: "0.5rem" }}>Couldn't load: {message}</div>
			<button type="button" onClick={onRetry} style={secondaryButtonStyle}>
				Retry
			</button>
		</div>
	);
}

function EmptyState({ message }: { message: string }): ReactElement {
	return <div style={emptyStateStyle}>{message}</div>;
}

// ---------------------------------------------------------------------------
// Styles (logical CSS per §24 rule #5; matches T19/T22/T23/T25)
// ---------------------------------------------------------------------------

const pageStyle: CSSProperties = {
	padding: "2rem",
	maxInlineSize: "80rem",
	marginInline: "auto",
	fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif",
	color: "#0f172a",
};

const pageHeaderStyle: CSSProperties = {
	marginBlockEnd: "1rem",
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
	justifyContent: "space-between",
	gap: "1rem",
	flexWrap: "wrap",
};

const pageTitleStyle: CSSProperties = {
	fontSize: "1.5rem",
	marginBlock: 0,
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

const secondaryLinkStyle: CSSProperties = {
	display: "inline-block",
	paddingBlock: "0.5rem",
	paddingInline: "0.875rem",
	borderRadius: "0.375rem",
	border: "1px solid #cbd5e1",
	backgroundColor: "white",
	color: "#0f172a",
	fontWeight: 500,
	textDecoration: "none",
	fontSize: "0.875rem",
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

const tabNavStyle: CSSProperties = {
	marginBlockEnd: "1rem",
	borderBlockEnd: "1px solid #e2e8f0",
};

const tabListStyle: CSSProperties = {
	listStyle: "none",
	paddingInlineStart: 0,
	marginBlock: 0,
	display: "flex",
	gap: "0.25rem",
	overflowX: "auto",
};

const tabListItemStyle: CSSProperties = {
	flex: "0 0 auto",
};

const tabButtonBaseStyle: CSSProperties = {
	appearance: "none",
	border: "none",
	background: "transparent",
	paddingBlock: "0.625rem",
	paddingInline: "0.875rem",
	fontSize: "0.925rem",
	color: "#475569",
	cursor: "pointer",
	borderBlockEnd: "2px solid transparent",
	fontFamily: "inherit",
};

const tabButtonStyle: CSSProperties = {
	...tabButtonBaseStyle,
};

const tabButtonActiveStyle: CSSProperties = {
	...tabButtonBaseStyle,
	color: "#2563eb",
	fontWeight: 600,
	borderBlockEnd: "2px solid #2563eb",
};

const tabBodyStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "1.25rem",
};

const statsGridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
	gap: "0.75rem",
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

const statHintStyle: CSSProperties = {
	marginBlockStart: "0.25rem",
	color: "#94a3b8",
	fontSize: "0.75rem",
};

const sectionStyle: CSSProperties = {};

const sectionTitleStyle: CSSProperties = {
	fontSize: "1.125rem",
	marginBlockStart: 0,
	marginBlockEnd: "0.75rem",
};

const sectionHeaderStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	flexWrap: "wrap",
	gap: "0.75rem",
};

const sectionActionsStyle: CSSProperties = {
	display: "flex",
	gap: "0.5rem",
	flexWrap: "wrap",
};

const mutedTextStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.875rem",
	marginBlock: 0,
};

const chartWrapperStyle: CSSProperties = {
	padding: "1rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	backgroundColor: "white",
	display: "grid",
	gap: "0.75rem",
};

const chartSvgStyle: CSSProperties = {
	inlineSize: "100%",
	blockSize: "auto",
	maxBlockSize: "14rem",
};

const chartSummaryStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))",
	gap: "0.5rem",
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

const funnelListStyle: CSSProperties = {
	listStyle: "none",
	paddingInlineStart: 0,
	marginBlock: 0,
	display: "grid",
	gap: "0.5rem",
	padding: "1rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	backgroundColor: "white",
};

const funnelItemStyle: CSSProperties = {
	display: "grid",
	gap: "0.25rem",
};

const funnelHeaderStyle: CSSProperties = {
	display: "flex",
	justifyContent: "space-between",
	fontSize: "0.875rem",
};

const funnelLabelStyle: CSSProperties = {
	color: "#0f172a",
	fontWeight: 500,
};

const funnelValueStyle: CSSProperties = {
	color: "#475569",
	fontVariantNumeric: "tabular-nums",
};

const funnelTrackStyle: CSSProperties = {
	inlineSize: "100%",
	blockSize: "0.5rem",
	borderRadius: "9999px",
	backgroundColor: "#f1f5f9",
	overflow: "hidden",
};

const funnelFillStyle: CSSProperties = {
	blockSize: "100%",
	backgroundColor: "#2563eb",
	borderStartStartRadius: "9999px",
	borderEndStartRadius: "9999px",
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

// ── Heatmap ─────────────────────────────────────────────────────────────────

const heatmapScrollStyle: CSSProperties = {
	overflowX: "auto",
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	backgroundColor: "white",
};

const heatmapTableStyle: CSSProperties = {
	borderCollapse: "separate",
	borderSpacing: 0,
	fontSize: "0.8125rem",
	minInlineSize: "100%",
};

const heatmapStickyThStyle: CSSProperties = {
	position: "sticky",
	insetInlineStart: 0,
	backgroundColor: "#f8fafc",
	borderBlockEnd: "1px solid #e2e8f0",
	borderInlineEnd: "1px solid #e2e8f0",
	paddingBlock: "0.5rem",
	paddingInline: "0.75rem",
	textAlign: "start",
	zIndex: 2,
	minInlineSize: "12rem",
};

const heatmapOverallThStyle: CSSProperties = {
	backgroundColor: "#f8fafc",
	borderBlockEnd: "1px solid #e2e8f0",
	borderInlineEnd: "1px solid #e2e8f0",
	paddingBlock: "0.5rem",
	paddingInline: "0.5rem",
	textAlign: "center",
	minInlineSize: "4.5rem",
};

const heatmapLessonThStyle: CSSProperties = {
	backgroundColor: "#f8fafc",
	borderBlockEnd: "1px solid #e2e8f0",
	paddingBlock: "0.5rem",
	paddingInline: "0.25rem",
	textAlign: "center",
	minInlineSize: "2.25rem",
	fontWeight: 600,
	color: "#334155",
};

const heatmapSortButtonStyle: CSSProperties = {
	appearance: "none",
	background: "transparent",
	border: "none",
	padding: 0,
	color: "inherit",
	cursor: "pointer",
	font: "inherit",
	fontWeight: "inherit",
};

const heatmapStickyRowThStyle: CSSProperties = {
	position: "sticky",
	insetInlineStart: 0,
	backgroundColor: "white",
	borderInlineEnd: "1px solid #e2e8f0",
	borderBlockStart: "1px solid #f1f5f9",
	paddingBlock: "0.5rem",
	paddingInline: "0.75rem",
	textAlign: "start",
	fontWeight: 500,
	minInlineSize: "12rem",
	zIndex: 1,
};

const heatmapCellBaseStyle: CSSProperties = {
	borderBlockStart: "1px solid #f1f5f9",
	padding: 0,
	textAlign: "center",
	minInlineSize: "2.25rem",
	fontVariantNumeric: "tabular-nums",
	fontSize: "0.75rem",
};

const heatmapOverallCellBaseStyle: CSSProperties = {
	...heatmapCellBaseStyle,
	borderInlineEnd: "1px solid #e2e8f0",
	fontWeight: 600,
	paddingBlock: "0.375rem",
	paddingInline: "0.5rem",
};

const heatmapCellLinkStyle: CSSProperties = {
	display: "block",
	inlineSize: "100%",
	paddingBlock: "0.375rem",
	paddingInline: "0.25rem",
	color: "inherit",
	textDecoration: "none",
};

// ── Stub cards (Cohorts/Discussions/Settings) ───────────────────────────────

const stubCardStyle: CSSProperties = {
	padding: "1.5rem",
	border: "1px dashed #cbd5e1",
	borderRadius: "0.5rem",
	backgroundColor: "#f8fafc",
	display: "grid",
	gap: "0.75rem",
};

const bulletListStyle: CSSProperties = {
	marginBlock: 0,
	paddingInlineStart: "1.25rem",
	color: "#334155",
	fontSize: "0.875rem",
	display: "grid",
	gap: "0.25rem",
};

const stubDangerHintStyle: CSSProperties = {
	marginBlock: 0,
	color: "#92400e",
	fontSize: "0.8125rem",
};

// ── Banners ─────────────────────────────────────────────────────────────────

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

export default CoursePage;
