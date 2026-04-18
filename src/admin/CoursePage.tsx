/**
 * Course detail page (T20 / §16.3) — mounts at
 * `/_emdash/admin/plugins/lms-core/courses/:courseId`.
 *
 * The current backend exposes strong read coverage for overview analytics,
 * quiz stats, CSV exports, and the student × lesson progress matrix. A few
 * wireframe actions from §16.3 still depend on routes or core-admin embeds
 * that do not exist in this repo yet (detailed enrollments CRUD, course-
 * scoped cohorts, inline discussions moderation, settings writes). This page
 * keeps those gaps explicit rather than inventing unsupported state.
 *
 * Per §12 Q19, the admin UI still ships as plain React + inline styles in
 * this repo snapshot. Kumo + Lingui wiring lands as a later sweep.
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
	type ApiClient,
	type CatalogPage,
	type Cohort,
	type CompletionFunnel,
	type CourseOverview,
	type ProgressMatrix,
	type QuizStats,
	type TimelinePoint,
} from "./api-client.js";

const PLUGIN_BASE = "/_emdash/admin/plugins/lms-core";
const COURSES_PATH_PREFIX = `${PLUGIN_BASE}/courses/`;
const DASHBOARD_HREF = `${PLUGIN_BASE}/`;
const CONTENT_EDITOR_BASE = "/_emdash/admin/collections/courses";
const MATRIX_PAGE_SIZE = 50;
const MAX_CATALOG_PAGES = 20;

type CourseCatalogEntry = CatalogPage["items"][number];
type MatrixStudent = ProgressMatrix["students"][number];
type CohortListItem = { id: string } & Cohort;
type SortDirection = "asc" | "desc";
type TabKey =
	| "overview"
	| "enrollments"
	| "progress"
	| "quizzes"
	| "cohorts"
	| "discussions"
	| "settings";

interface MatrixSort {
	key: "name" | "average" | "lesson";
	lessonId?: string;
}

interface CoursePageData {
	course: CourseCatalogEntry | null;
	overview: CourseOverview;
	timeline: TimelinePoint[];
	funnel: CompletionFunnel;
	quizStats: QuizStats[];
	cohorts: CohortListItem[];
	cohortsTruncated: boolean;
}

interface SelectedMatrixCell {
	userId: string;
	studentName: string;
	lessonId: string;
	percent: number;
}

type SummaryState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; data: CoursePageData };

type MatrixState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; data: ProgressMatrix };

function formatError(err: unknown): string {
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Extract the `:courseId` segment from URLs like
 * `/_emdash/admin/plugins/lms-core/courses/course_123`.
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

export function formatCount(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return value.toLocaleString("en-US");
}

export function formatPercent(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return `${Math.round(value)}%`;
}

export function formatShortDate(isoTimestamp: string): string {
	const parsed = Date.parse(isoTimestamp);
	if (!Number.isFinite(parsed)) return isoTimestamp;
	const date = new Date(parsed);
	const day = date.getUTCDate();
	const month = date.toLocaleString("en-US", {
		month: "short",
		timeZone: "UTC",
	});
	const year = date.getUTCFullYear();
	return `${day} ${month} ${year}`;
}

export function courseCatalogStatus(
	course: CourseCatalogEntry | null,
): "published" | "not-in-catalog" {
	return course ? "published" : "not-in-catalog";
}

export function enrollmentWindowSummary(
	course: CourseCatalogEntry | null,
): string {
	if (!course) {
		return "Unavailable from the current catalog route. Open the content editor for draft-only details.";
	}
	if (course.enrollmentOpen === false) return "Closed";
	if (!course.enrollmentOpensAt && !course.enrollmentClosesAt) return "Open now";
	if (course.enrollmentOpensAt && course.enrollmentClosesAt) {
		return `${formatShortDate(course.enrollmentOpensAt)} → ${formatShortDate(course.enrollmentClosesAt)}`;
	}
	if (course.enrollmentOpensAt) return `Opens ${formatShortDate(course.enrollmentOpensAt)}`;
	if (course.enrollmentClosesAt) return `Closes ${formatShortDate(course.enrollmentClosesAt)}`;
	return "Open now";
}

export function averageStudentProgress(student: MatrixStudent): number {
	const values = Object.values(student.lessonProgress);
	if (values.length === 0) return 0;
	const sum = values.reduce((acc, value) => acc + value, 0);
	return sum / values.length;
}

export function collectLessonIds(students: MatrixStudent[]): string[] {
	const lessonIds = new Set<string>();
	for (const student of students) {
		for (const lessonId of Object.keys(student.lessonProgress)) lessonIds.add(lessonId);
	}
	return Array.from(lessonIds)
		// oxlint-disable-next-line no-array-sort -- local array
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function sortMatrixStudents(
	students: MatrixStudent[],
	sort: MatrixSort,
	direction: SortDirection = "asc",
): MatrixStudent[] {
	const multiplier = direction === "asc" ? 1 : -1;
	return [...students]
		// oxlint-disable-next-line no-array-sort -- local array copy
		.sort((left, right) => {
			let delta = 0;
			if (sort.key === "name") {
				delta = left.name.localeCompare(right.name, "en", { sensitivity: "base" });
				if (delta === 0) delta = left.userId.localeCompare(right.userId, "en", { sensitivity: "base" });
			} else if (sort.key === "average") {
				delta = averageStudentProgress(left) - averageStudentProgress(right);
				if (delta === 0) {
					delta = left.name.localeCompare(right.name, "en", { sensitivity: "base" });
				}
			} else {
				const lessonId = sort.lessonId ?? "";
				delta =
					(left.lessonProgress[lessonId] ?? 0) -
					(right.lessonProgress[lessonId] ?? 0);
				if (delta === 0) {
					delta = left.name.localeCompare(right.name, "en", { sensitivity: "base" });
				}
			}
			return delta * multiplier;
		});
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

function studentStatus(student: MatrixStudent): string {
	const average = averageStudentProgress(student);
	if (average >= 100) return "Completed";
	if (average > 0) return "In progress";
	return "Not started";
}

function lessonLabel(index: number): string {
	return `L${index + 1}`;
}

function statusMeta(course: CourseCatalogEntry | null): {
	label: string;
	background: string;
	color: string;
} {
	if (courseCatalogStatus(course) === "published") {
		return {
			label: "Published",
			background: "#dcfce7",
			color: "#166534",
		};
	}
	return {
		label: "Not in catalog",
		background: "#e2e8f0",
		color: "#334155",
	};
}

function courseEditorHref(courseId: string): string {
	return `${CONTENT_EDITOR_BASE}/${encodeURIComponent(courseId)}`;
}

function courseLiveHref(course: CourseCatalogEntry | null): string | null {
	if (!course?.slug) return null;
	return `/courses/${encodeURIComponent(course.slug)}`;
}

function timelinePolyline(points: TimelinePoint[]): string {
	if (points.length === 0) return "";
	const width = 560;
	const height = 160;
	const paddingX = 16;
	const paddingY = 12;
	const maxCount = Math.max(...points.map((point) => point.count), 1);
	return points
		.map((point, index) => {
			const x =
				paddingX +
				(points.length === 1
					? (width - paddingX * 2) / 2
					: ((width - paddingX * 2) * index) / (points.length - 1));
			const y = height - paddingY - (point.count / maxCount) * (height - paddingY * 2);
			return `${x},${y}`;
		})
		.join(" ");
}

function csvFilename(courseId: string, kind: "enrollments" | "progress"): string {
	return `${courseId}-${kind}.csv`;
}

function downloadCsv(filename: string, csv: string): void {
	if (typeof window === "undefined") return;
	const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
	const url = window.URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	window.URL.revokeObjectURL(url);
}

async function findCourseInCatalog(
	api: ApiClient,
	courseId: string,
): Promise<CourseCatalogEntry | null> {
	let cursor: string | undefined;
	for (let pageCount = 0; pageCount < MAX_CATALOG_PAGES; pageCount += 1) {
		const page = await api.catalog({ cursor, limit: 100 });
		const found = page.items.find((course) => course.id === courseId);
		if (found) return found;
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}
	return null;
}

const tabs: Array<{ key: TabKey; label: string }> = [
	{ key: "overview", label: "Overview" },
	{ key: "enrollments", label: "Enrollments" },
	{ key: "progress", label: "Progress" },
	{ key: "quizzes", label: "Quizzes" },
	{ key: "cohorts", label: "Cohorts" },
	{ key: "discussions", label: "Discussions" },
	{ key: "settings", label: "Settings" },
];

export function CoursePage(): ReactElement {
	const courseId = useMemo(() => {
		if (typeof window === "undefined") return null;
		return parseCourseIdFromPath(window.location.pathname);
	}, []);

	const api = useMemo(() => createApiClient(), []);
	const [activeTab, setActiveTab] = useState<TabKey>("overview");
	const [summaryState, setSummaryState] = useState<SummaryState>({ kind: "loading" });
	const [matrixState, setMatrixState] = useState<MatrixState>({ kind: "loading" });
	const [matrixCursor, setMatrixCursor] = useState<string | null>(null);
	const [matrixCursorStack, setMatrixCursorStack] = useState<Array<string | null>>([]);
	const [matrixSort, setMatrixSort] = useState<MatrixSort>({ key: "name" });
	const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
	const [selectedCell, setSelectedCell] = useState<SelectedMatrixCell | null>(null);
	const [selectedQuizId, setSelectedQuizId] = useState<string | null>(null);
	const [exporting, setExporting] = useState<"enrollments" | "progress" | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const loadSummary = useCallback(async () => {
		if (!courseId) {
			setSummaryState({
				kind: "error",
				message:
					"Missing course id in URL — expected /_emdash/admin/plugins/lms-core/courses/<id>.",
			});
			return;
		}

		setSummaryState({ kind: "loading" });
		try {
			const coursePromise = findCourseInCatalog(api, courseId).catch(() => null);
			const cohortsPromise = api.cohorts
				.list({ limit: 50 })
				.then((page) => ({ items: page.items as CohortListItem[], hasMore: page.hasMore }))
				.catch(() => ({ items: [] as CohortListItem[], hasMore: false }));

			const [course, overview, timeline, funnel, quizStats, cohortsPage] =
				await Promise.all([
					coursePromise,
					api.instructorAnalytics.courseOverview({ courseId }),
					api.instructorAnalytics.courseEnrollmentsTimeline({ courseId, days: 30 }),
					api.instructorAnalytics.courseCompletionFunnel({ courseId }),
					api.instructorAnalytics.courseQuizStats({ courseId }),
					cohortsPromise,
				]);

			setSummaryState({
				kind: "ready",
				data: {
					course,
					overview,
					timeline,
					funnel,
					quizStats,
					cohorts: cohortsPage.items,
					cohortsTruncated: cohortsPage.hasMore,
				},
			});
		} catch (err) {
			setSummaryState({ kind: "error", message: formatError(err) });
		}
	}, [api, courseId]);

	const loadMatrix = useCallback(
		async (cursor?: string, mode: "reset" | "forward" | "back" = "reset") => {
			if (!courseId) {
				setMatrixState({
					kind: "error",
					message:
						"Missing course id in URL — expected /_emdash/admin/plugins/lms-core/courses/<id>.",
				});
				return;
			}

			setMatrixState({ kind: "loading" });
			try {
				const data = await api.instructorAnalytics.courseProgressMatrix({
					courseId,
					cursor,
					limit: MATRIX_PAGE_SIZE,
				});
				setMatrixState({ kind: "ready", data });
				if (mode === "reset") {
					setMatrixCursor(null);
					setMatrixCursorStack([]);
				} else if (mode === "forward") {
					setMatrixCursorStack((prev) => [...prev, matrixCursor]);
					setMatrixCursor(cursor ?? null);
				} else {
					setMatrixCursorStack((prev) => prev.slice(0, -1));
					setMatrixCursor(cursor ?? null);
				}
			} catch (err) {
				setMatrixState({ kind: "error", message: formatError(err) });
			}
		},
		[api, courseId, matrixCursor],
	);

	useEffect(() => {
		void loadSummary();
		void loadMatrix(undefined, "reset");
	}, [loadMatrix, loadSummary]);

	useEffect(() => {
		setSelectedCell(null);
	}, [matrixCursor]);

	const lessonIds = useMemo(
		() => (matrixState.kind === "ready" ? collectLessonIds(matrixState.data.students) : []),
		[matrixState],
	);

	useEffect(() => {
		if (matrixSort.key === "lesson" && !lessonIds.includes(matrixSort.lessonId ?? "")) {
			setMatrixSort({ key: "name" });
		}
	}, [lessonIds, matrixSort]);

	const sortedStudents = useMemo(() => {
		if (matrixState.kind !== "ready") return [];
		return sortMatrixStudents(matrixState.data.students, matrixSort, sortDirection);
	}, [matrixSort, matrixState, sortDirection]);

	const selectedStudent = useMemo(() => {
		if (!selectedCell || matrixState.kind !== "ready") return null;
		return (
			matrixState.data.students.find((student) => student.userId === selectedCell.userId) ?? null
		);
	}, [matrixState, selectedCell]);

	const selectedQuiz = useMemo(() => {
		if (summaryState.kind !== "ready" || !selectedQuizId) return null;
		return summaryState.data.quizStats.find((quiz) => quiz.quizId === selectedQuizId) ?? null;
	}, [selectedQuizId, summaryState]);

	const downloadExport = useCallback(
		async (kind: "enrollments" | "progress") => {
			if (!courseId) return;
			setActionError(null);
			setExporting(kind);
			try {
				const result =
					kind === "enrollments"
						? await api.instructorAnalytics.enrollmentsExport({ courseId })
						: await api.instructorAnalytics.progressExport({ courseId });
				downloadCsv(csvFilename(courseId, kind), result.csv);
			} catch (err) {
				setActionError(formatError(err));
			} finally {
				setExporting(null);
			}
		},
		[api, courseId],
	);

	const title =
		summaryState.kind === "ready"
			? summaryState.data.overview.title
			: courseId ?? "Course detail";
	const course = summaryState.kind === "ready" ? summaryState.data.course : null;
	const liveHref = courseLiveHref(course);
	const status = statusMeta(course);

	return (
		<section style={pageStyle}>
			<header style={headerStyle}>
				<a href={DASHBOARD_HREF} style={backLinkStyle}>
					← Back to dashboard
				</a>
				<div style={headerRowStyle}>
					<div style={{ flex: 1, minInlineSize: 0 }}>
						<div style={titleRowStyle}>
							<h1 style={pageTitleStyle}>{title}</h1>
							<span
								style={{
									...statusBadgeStyle,
									backgroundColor: status.background,
									color: status.color,
								}}
							>
								{status.label}
							</span>
						</div>
						<p style={subtitleStyle}>
							Seven-tab instructor view for a single course. Data-backed where routes exist;
							 explicit where the current backend stops short.
						</p>
					</div>
					<div style={headerActionsStyle}>
						<a href={courseId ? courseEditorHref(courseId) : CONTENT_EDITOR_BASE} style={primaryLinkStyle}>
							Edit content
						</a>
						{liveHref ? (
							<a href={liveHref} style={secondaryLinkStyle}>
								View live
							</a>
						) : (
							<span style={disabledPillStyle}>View live unavailable</span>
						)}
					</div>
				</div>
			</header>

			<nav aria-label="Course detail tabs" style={tabBarStyle}>
				{tabs.map((tab) => (
					<button
						key={tab.key}
						type="button"
						onClick={() => setActiveTab(tab.key)}
						style={tabButtonStyle(activeTab === tab.key)}
					>
						{tab.label}
					</button>
				))}
			</nav>

			{summaryState.kind === "loading" ? (
				<LoadingBanner message="Loading course detail…" />
			) : summaryState.kind === "error" ? (
				<ErrorBanner message={summaryState.message} onRetry={() => void loadSummary()} />
			) : (
				<CourseTabs
					activeTab={activeTab}
					course={summaryState.data.course}
					courseId={summaryState.data.overview.courseId}
					overview={summaryState.data.overview}
					timeline={summaryState.data.timeline}
					funnel={summaryState.data.funnel}
					quizStats={summaryState.data.quizStats}
					cohorts={summaryState.data.cohorts}
					cohortsTruncated={summaryState.data.cohortsTruncated}
					matrixState={matrixState}
					lessonIds={lessonIds}
					sortedStudents={sortedStudents}
					selectedCell={selectedCell}
					selectedStudent={selectedStudent}
					selectedQuiz={selectedQuiz}
					matrixSort={matrixSort}
					sortDirection={sortDirection}
					actionError={actionError}
					exporting={exporting}
					onRetryMatrix={() => void loadMatrix(matrixCursor ?? undefined, "reset")}
					onNextMatrix={() => {
						if (matrixState.kind !== "ready" || !matrixState.data.nextCursor) return;
						void loadMatrix(matrixState.data.nextCursor, "forward");
					}}
					onPreviousMatrix={() => {
						const previousCursor = matrixCursorStack.at(-1);
						void loadMatrix(previousCursor ?? undefined, "back");
					}}
					onSelectCell={(cell) => {
						setSelectedCell(cell);
						setActiveTab("progress");
					}}
					onSelectQuiz={setSelectedQuizId}
					onChangeSort={setMatrixSort}
					onToggleSortDirection={() =>
						setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"))
					}
					onDownloadExport={(kind) => void downloadExport(kind)}
					canPageBackward={matrixCursorStack.length > 0}
					canPageForward={matrixState.kind === "ready" && Boolean(matrixState.data.nextCursor)}
					currentMatrixPage={matrixCursorStack.length + 1}
				/>
			)}
		</section>
	);
}

interface CourseTabsProps {
	activeTab: TabKey;
	course: CourseCatalogEntry | null;
	courseId: string;
	overview: CourseOverview;
	timeline: TimelinePoint[];
	funnel: CompletionFunnel;
	quizStats: QuizStats[];
	cohorts: CohortListItem[];
	cohortsTruncated: boolean;
	matrixState: MatrixState;
	lessonIds: string[];
	sortedStudents: MatrixStudent[];
	selectedCell: SelectedMatrixCell | null;
	selectedStudent: MatrixStudent | null;
	selectedQuiz: QuizStats | null;
	matrixSort: MatrixSort;
	sortDirection: SortDirection;
	actionError: string | null;
	exporting: "enrollments" | "progress" | null;
	canPageBackward: boolean;
	canPageForward: boolean;
	currentMatrixPage: number;
	onRetryMatrix: () => void;
	onNextMatrix: () => void;
	onPreviousMatrix: () => void;
	onSelectCell: (cell: SelectedMatrixCell) => void;
	onSelectQuiz: (quizId: string | null) => void;
	onChangeSort: (sort: MatrixSort) => void;
	onToggleSortDirection: () => void;
	onDownloadExport: (kind: "enrollments" | "progress") => void;
}

function CourseTabs(props: CourseTabsProps): ReactElement {
	switch (props.activeTab) {
		case "overview":
			return (
				<OverviewTab
					overview={props.overview}
					timeline={props.timeline}
					funnel={props.funnel}
				/>
			);
		case "enrollments":
			return <EnrollmentsTab {...props} />;
		case "progress":
			return <ProgressTab {...props} />;
		case "quizzes":
			return <QuizzesTab {...props} />;
		case "cohorts":
			return <CohortsTab {...props} />;
		case "discussions":
			return <DiscussionsTab {...props} />;
		case "settings":
			return <SettingsTab {...props} />;
	}
}

function OverviewTab({
	overview,
	timeline,
	funnel,
}: {
	overview: CourseOverview;
	timeline: TimelinePoint[];
	funnel: CompletionFunnel;
}): ReactElement {
	return (
		<div style={stackStyle}>
			<section aria-label="Course overview metrics" style={statsGridStyle}>
				<StatCard label="Enrolled" value={formatCount(overview.enrolled)} />
				<StatCard label="Completed" value={formatCount(overview.completed)} />
				<StatCard label="Active 30d" value={formatCount(overview.active30d)} />
				<StatCard label="Avg progress" value={formatPercent(overview.avgProgress)} />
				<StatCard label="Revenue" value="Deferred" hint="Payments are out of scope in v1." />
			</section>

			<section style={panelStyle}>
				<div style={sectionHeaderStyle}>
					<h2 style={sectionTitleStyle}>Enrollments over time</h2>
					<span style={sectionMetaStyle}>Last 30 days</span>
				</div>
				{timeline.length === 0 ? (
					<EmptyState message="No enrollment events were recorded in the last 30 days." />
				) : (
					<>
						<svg viewBox="0 0 560 160" role="img" aria-label="Enrollments over time" style={chartStyle}>
							<path d="M 16 148 H 544" stroke="#cbd5e1" strokeWidth="1" fill="none" />
							<polyline
								points={timelinePolyline(timeline)}
								fill="none"
								stroke="#2563eb"
								strokeWidth="3"
								strokeLinejoin="round"
								strokeLinecap="round"
							/>
						</svg>
						<div style={timelineLegendStyle}>
							{timeline.map((point) => (
								<div key={point.date} style={timelineLegendItemStyle}>
									<span style={timelineLegendCountStyle}>{formatCount(point.count)}</span>
									<span style={timelineLegendDateStyle}>{formatShortDate(point.date)}</span>
								</div>
							))}
						</div>
					</>
				)}
			</section>

			<section style={panelStyle}>
				<div style={sectionHeaderStyle}>
					<h2 style={sectionTitleStyle}>Completion funnel</h2>
				</div>
				<FunnelList funnel={funnel} />
			</section>
		</div>
	);
}

function EnrollmentsTab({
	matrixState,
	sortedStudents,
	actionError,
	exporting,
	onRetryMatrix,
	onDownloadExport,
	onSelectCell,
	lessonIds,
}: CourseTabsProps): ReactElement {
	return (
		<div style={stackStyle}>
			<InfoBanner message="The dedicated instructor enrollments list/grant/revoke routes are not present in this backend yet. This tab uses the course progress matrix as a roster snapshot and keeps CSV exports wired." />
			<div style={toolbarStyle}>
				<div style={toolbarMetaStyle}>Snapshot of active enrollments on the current page.</div>
				<div style={toolbarActionsStyle}>
					<button
						type="button"
						onClick={() => onDownloadExport("enrollments")}
						disabled={exporting !== null}
						style={secondaryButtonStyle}
					>
						{exporting === "enrollments" ? "Exporting…" : "Export enrollments"}
					</button>
					<button
						type="button"
						onClick={() => onDownloadExport("progress")}
						disabled={exporting !== null}
						style={secondaryButtonStyle}
					>
						{exporting === "progress" ? "Exporting…" : "Export progress"}
					</button>
				</div>
			</div>
			{actionError ? <ErrorInline message={actionError} /> : null}
			{matrixState.kind === "loading" ? (
				<LoadingBanner message="Loading enrollment snapshot…" />
			) : matrixState.kind === "error" ? (
				<ErrorBanner message={matrixState.message} onRetry={onRetryMatrix} />
			) : sortedStudents.length === 0 ? (
				<EmptyState message="No active enrollments found for this course." />
			) : (
				<div style={tableWrapperStyle}>
					<table style={tableStyle}>
						<thead>
							<tr>
								<th style={thStyle}>Student</th>
								<th style={thNumStyle}>Lessons tracked</th>
								<th style={thNumStyle}>Avg progress</th>
								<th style={thStyle}>Status</th>
								<th style={thActionStyle} aria-label="Actions" />
							</tr>
						</thead>
						<tbody>
							{sortedStudents.map((student) => {
								const firstLessonId = lessonIds[0];
								const firstPercent = firstLessonId
									? student.lessonProgress[firstLessonId] ?? 0
									: averageStudentProgress(student);
								return (
									<tr key={student.userId}>
										<td style={tdStyle}>{student.name}</td>
										<td style={tdNumStyle}>{formatCount(Object.keys(student.lessonProgress).length)}</td>
										<td style={tdNumStyle}>{formatPercent(averageStudentProgress(student))}</td>
										<td style={tdStyle}>{studentStatus(student)}</td>
										<td style={tdActionStyle}>
											<button
												type="button"
												onClick={() =>
													onSelectCell({
														userId: student.userId,
														studentName: student.name,
														lessonId: firstLessonId ?? "overview",
														percent: firstPercent,
													})
												}
												style={linkButtonStyle}
											>
												Open progress
											</button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function ProgressTab({
	matrixState,
	lessonIds,
	sortedStudents,
	selectedCell,
	selectedStudent,
	matrixSort,
	sortDirection,
	canPageBackward,
	canPageForward,
	currentMatrixPage,
	onRetryMatrix,
	onNextMatrix,
	onPreviousMatrix,
	onSelectCell,
	onChangeSort,
	onToggleSortDirection,
}: CourseTabsProps): ReactElement {
	return (
		<div style={stackStyle}>
			<div style={toolbarStyle}>
				<div style={toolbarGroupStyle}>
					<label style={fieldLabelStyle}>
						Sort by
						<select
							value={matrixSort.key === "lesson" ? `lesson:${matrixSort.lessonId ?? ""}` : matrixSort.key}
							onChange={(event) => {
								const value = event.target.value;
								if (value === "name" || value === "average") {
									onChangeSort({ key: value });
									return;
								}
								onChangeSort({ key: "lesson", lessonId: value.slice("lesson:".length) });
							}}
							style={selectStyle}
						>
							<option value="name">Student name</option>
							<option value="average">Average progress</option>
							{lessonIds.map((lessonId, index) => (
								<option key={lessonId} value={`lesson:${lessonId}`}>
									{lessonLabel(index)}
								</option>
							))}
						</select>
					</label>
					<button type="button" onClick={onToggleSortDirection} style={secondaryButtonStyle}>
						{sortDirection === "asc" ? "Ascending" : "Descending"}
					</button>
				</div>
				<div style={toolbarGroupStyle}>
					<span style={toolbarMetaStyle}>Page {formatCount(currentMatrixPage)} · 50 students</span>
					<button
						type="button"
						onClick={onPreviousMatrix}
						disabled={!canPageBackward}
						style={secondaryButtonStyle}
					>
						Previous
					</button>
					<button
						type="button"
						onClick={onNextMatrix}
						disabled={!canPageForward}
						style={secondaryButtonStyle}
					>
						Next
					</button>
				</div>
			</div>
			<InfoBanner message="Click any cell to inspect that student's course progress snapshot. Lesson ids are rendered as generic L1/L2 labels because the current analytics route does not expose lesson titles." />
			{matrixState.kind === "loading" ? (
				<LoadingBanner message="Loading progress matrix…" />
			) : matrixState.kind === "error" ? (
				<ErrorBanner message={matrixState.message} onRetry={onRetryMatrix} />
			) : lessonIds.length === 0 || sortedStudents.length === 0 ? (
				<EmptyState message="No progress rows have been recorded for this course yet." />
			) : (
				<>
					<div style={matrixWrapperStyle}>
						<table style={matrixTableStyle}>
							<thead>
								<tr>
									<th style={stickyThStyle}>Student</th>
									{lessonIds.map((lessonId, index) => (
										<th key={lessonId} style={matrixThStyle} title={lessonId}>
											{lessonLabel(index)}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{sortedStudents.map((student) => (
									<tr key={student.userId}>
										<th style={stickyTdStyle}>{student.name}</th>
										{lessonIds.map((lessonId) => {
											const percent = student.lessonProgress[lessonId] ?? 0;
											const isSelected =
												selectedCell?.userId === student.userId && selectedCell.lessonId === lessonId;
											return (
												<td key={lessonId} style={matrixCellOuterStyle}>
													<button
														type="button"
														onClick={() =>
															onSelectCell({
																userId: student.userId,
																studentName: student.name,
																lessonId,
																percent,
															})
														}
														style={matrixCellButtonStyle(percent, isSelected)}
													>
														{percent >= 100 ? "✓" : percent > 0 ? formatPercent(percent) : "—"}
													</button>
												</td>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<div style={legendStyle}>
						<span style={legendItemStyle}><span style={legendSwatchStyle("#e2e8f0")} />No progress</span>
						<span style={legendItemStyle}><span style={legendSwatchStyle("#bfdbfe")} />Started</span>
						<span style={legendItemStyle}><span style={legendSwatchStyle("#2563eb")} />High progress</span>
						<span style={legendItemStyle}><span style={legendSwatchStyle("#1d4ed8")} />Complete</span>
					</div>
					{selectedCell && selectedStudent ? (
						<SelectedCellPanel
							cell={selectedCell}
							student={selectedStudent}
							lessonIds={lessonIds}
						/>
					) : null}
				</>
			)}
		</div>
	);
}

function QuizzesTab({
	quizStats,
	selectedQuiz,
	onSelectQuiz,
}: CourseTabsProps): ReactElement {
	return (
		<div style={stackStyle}>
			<InfoBanner message="Quiz stats are course-scoped. The current route set does not expose the lesson attachment, so that column stays explicit instead of guessed." />
			{quizStats.length === 0 ? (
				<EmptyState message="No quiz attempts are associated with this course yet." />
			) : (
				<>
					<div style={tableWrapperStyle}>
						<table style={tableStyle}>
							<thead>
								<tr>
									<th style={thStyle}>Quiz</th>
									<th style={thStyle}>Attached lesson</th>
									<th style={thNumStyle}>Attempts</th>
									<th style={thNumStyle}>Pass rate</th>
									<th style={thNumStyle}>Avg score</th>
									<th style={thActionStyle} aria-label="Actions" />
								</tr>
							</thead>
							<tbody>
								{quizStats.map((quiz) => (
									<tr key={quiz.quizId}>
										<td style={tdStyle}>{quiz.title}</td>
										<td style={tdStyle}>Unavailable from route</td>
										<td style={tdNumStyle}>{formatCount(quiz.attempts)}</td>
										<td style={tdNumStyle}>{formatPercent(quiz.passRate)}</td>
										<td style={tdNumStyle}>{formatPercent(quiz.avgScore)}</td>
										<td style={tdActionStyle}>
											<button
												type="button"
												onClick={() => onSelectQuiz(quiz.quizId)}
												style={linkButtonStyle}
											>
												Inspect
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{selectedQuiz ? (
						<section style={panelStyle}>
							<div style={sectionHeaderStyle}>
								<h2 style={sectionTitleStyle}>{selectedQuiz.title}</h2>
								<span style={sectionMetaStyle}>Inline stats snapshot</span>
							</div>
							<div style={detailGridStyle}>
								<DetailRow label="Attempts" value={formatCount(selectedQuiz.attempts)} />
								<DetailRow label="Pass rate" value={formatPercent(selectedQuiz.passRate)} />
								<DetailRow label="Average score" value={formatPercent(selectedQuiz.avgScore)} />
								<DetailRow label="Quiz id" value={selectedQuiz.quizId} />
							</div>
							<p style={helperTextStyle}>
								The dedicated quiz authoring/edit page ships with T21. This tab keeps the
								course-level quiz health visible in the meantime.
							</p>
						</section>
					) : null}
				</>
			)}
		</div>
	);
}

function CohortsTab({ cohorts, cohortsTruncated }: CourseTabsProps): ReactElement {
	return (
		<div style={stackStyle}>
			<InfoBanner message="The current cohort route is global, not course-scoped. This tab shows the available cohort records so instructors can at least inspect cohort definitions while the course linkage route is still absent." />
			{cohorts.length === 0 ? (
				<EmptyState message="No cohorts are defined yet." />
			) : (
				<div style={tableWrapperStyle}>
					<table style={tableStyle}>
						<thead>
							<tr>
								<th style={thStyle}>Cohort</th>
								<th style={thStyle}>Slug</th>
								<th style={thStyle}>Schedule</th>
								<th style={thNumStyle}>Capacity</th>
							</tr>
						</thead>
						<tbody>
							{cohorts.map((cohort) => (
								<tr key={cohort.id}>
									<td style={tdStyle}>{cohort.title}</td>
									<td style={tdStyle}>{cohort.slug}</td>
									<td style={tdStyle}>
										{cohort.startAt || cohort.endAt
											? `${cohort.startAt ? formatShortDate(cohort.startAt) : "Open"} → ${cohort.endAt ? formatShortDate(cohort.endAt) : "Open"}`
											: "No schedule"}
									</td>
									<td style={tdNumStyle}>{cohort.capacity ? formatCount(cohort.capacity) : "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{cohortsTruncated ? (
				<p style={helperTextStyle}>Only the first 50 cohort records are shown here.</p>
			) : null}
		</div>
	);
}

function DiscussionsTab({ course, courseId }: CourseTabsProps): ReactElement {
	const liveHref = courseLiveHref(course);
	return (
		<div style={stackStyle}>
			<InfoBanner message="Lesson discussions reuse emdash core comments, but this repo does not yet expose a stable course-filtered moderation embed. This tab stays contextual instead of duplicating comment state." />
			<section style={panelStyle}>
				<div style={sectionHeaderStyle}>
					<h2 style={sectionTitleStyle}>Moderation hand-off</h2>
				</div>
				<p style={paragraphStyle}>
					Use the course content editor to inspect lessons, then moderate lesson-level comments from
					 the core admin surfaces. Once emdash exposes a stable comments mount for plugins, this tab
					 can host the queue directly.
				</p>
				<div style={toolbarActionsStyle}>
					<a href={courseEditorHref(courseId)} style={primaryLinkStyle}>
						Edit content
					</a>
					{liveHref ? (
						<a href={liveHref} style={secondaryLinkStyle}>
							View live
						</a>
					) : null}
				</div>
			</section>
		</div>
	);
}

function SettingsTab({ course, courseId }: CourseTabsProps): ReactElement {
	const status = statusMeta(course);
	const liveHref = courseLiveHref(course);
	return (
		<div style={stackStyle}>
			<InfoBanner message="This repo snapshot does not have settings write routes for course detail yet. The values below are read-only, sourced from the catalog route where possible, with content-editor links for actual edits." />
			<section style={panelStyle}>
				<div style={sectionHeaderStyle}>
					<h2 style={sectionTitleStyle}>Course access</h2>
				</div>
				<div style={detailGridStyle}>
					<DetailRow label="Catalog status" value={status.label} />
					<DetailRow label="Enrollment window" value={enrollmentWindowSummary(course)} />
					<DetailRow label="Enrollment open" value={course?.enrollmentOpen === false ? "No" : "Yes"} />
					<DetailRow label="Opens at" value={course?.enrollmentOpensAt ? formatShortDate(course.enrollmentOpensAt) : "Not set"} />
					<DetailRow label="Closes at" value={course?.enrollmentClosesAt ? formatShortDate(course.enrollmentClosesAt) : "Not set"} />
					<DetailRow label="Drip override" value="Not supported by the current backend" />
					<DetailRow label="Public URL" value={liveHref ?? "Unavailable until published"} />
				</div>
				<div style={toolbarActionsStyle}>
					<a href={courseEditorHref(courseId)} style={primaryLinkStyle}>
						Edit content
					</a>
					<button type="button" disabled style={disabledButtonStyle}>
						Archive all enrollments
					</button>
				</div>
				<p style={helperTextStyle}>
					Bulk archive and course-specific drip overrides remain future work once write routes exist.
				</p>
			</section>
		</div>
	);
}

function SelectedCellPanel({
	cell,
	student,
	lessonIds,
}: {
	cell: SelectedMatrixCell;
	student: MatrixStudent;
	lessonIds: string[];
}): ReactElement {
	return (
		<section style={panelStyle}>
			<div style={sectionHeaderStyle}>
				<h2 style={sectionTitleStyle}>Selected student detail</h2>
				<span style={sectionMetaStyle}>{student.userId}</span>
			</div>
			<div style={detailGridStyle}>
				<DetailRow label="Student" value={cell.studentName} />
				<DetailRow label="Lesson" value={cell.lessonId === "overview" ? "Overview" : cell.lessonId} />
				<DetailRow label="Progress" value={cell.lessonId === "overview" ? formatPercent(cell.percent) : formatPercent(cell.percent)} />
				<DetailRow label="Course average" value={formatPercent(averageStudentProgress(student))} />
			</div>
			<div style={miniListStyle}>
				{lessonIds.map((lessonId, index) => (
					<div key={lessonId} style={miniListItemStyle}>
						<span style={miniListKeyStyle}>{lessonLabel(index)}</span>
						<span style={miniListValueStyle}>{formatPercent(student.lessonProgress[lessonId] ?? 0)}</span>
					</div>
				))}
			</div>
		</section>
	);
}

function FunnelList({ funnel }: { funnel: CompletionFunnel }): ReactElement {
	const items = [
		{ label: "Started", value: funnel.started },
		{ label: "25%", value: funnel.q25 },
		{ label: "50%", value: funnel.q50 },
		{ label: "75%", value: funnel.q75 },
		{ label: "100%", value: funnel.completed },
	];
	const base = Math.max(funnel.started, 1);
	return (
		<ul style={funnelListStyle}>
			{items.map((item) => {
				const percent = Math.round((item.value / base) * 100);
				return (
					<li key={item.label} style={funnelItemStyle}>
						<div style={funnelLabelStyle}>{item.label}</div>
						<div style={funnelBarTrackStyle}>
							<div style={funnelBarFillStyle(clampPercent(percent))} />
						</div>
						<div style={funnelValueStyle}>
							{formatCount(item.value)} · {formatPercent(percent)}
						</div>
					</li>
				);
			})}
		</ul>
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

function DetailRow({ label, value }: { label: string; value: string }): ReactElement {
	return (
		<div style={detailRowStyle}>
			<div style={detailKeyStyle}>{label}</div>
			<div style={detailValueStyle}>{value}</div>
		</div>
	);
}

function LoadingBanner({ message }: { message: string }): ReactElement {
	return (
		<div style={mutedBannerStyle} role="status" aria-live="polite">
			{message}
		</div>
	);
}

function ErrorInline({ message }: { message: string }): ReactElement {
	return <div style={errorInlineStyle}>{message}</div>;
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
			<div style={{ marginBlockEnd: "0.5rem" }}>Couldn’t load course detail: {message}</div>
			<button type="button" onClick={onRetry} style={secondaryButtonStyle}>
				Retry
			</button>
		</div>
	);
}

function EmptyState({ message }: { message: string }): ReactElement {
	return <div style={emptyStateStyle}>{message}</div>;
}

function InfoBanner({ message }: { message: string }): ReactElement {
	return <div style={infoBannerStyle}>{message}</div>;
}

const pageStyle: CSSProperties = {
	padding: "2rem",
	maxInlineSize: "76rem",
	marginInline: "auto",
	fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif",
	color: "#0f172a",
};

const headerStyle: CSSProperties = {
	marginBlockEnd: "1rem",
};

const backLinkStyle: CSSProperties = {
	display: "inline-block",
	marginBlockEnd: "0.75rem",
	color: "#2563eb",
	textDecoration: "none",
	fontWeight: 500,
};

const headerRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "flex-start",
	justifyContent: "space-between",
	gap: "1rem",
	flexWrap: "wrap",
};

const titleRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "0.75rem",
	flexWrap: "wrap",
	marginBlockEnd: "0.5rem",
};

const pageTitleStyle: CSSProperties = {
	fontSize: "1.75rem",
	lineHeight: 1.2,
	marginBlock: 0,
};

const subtitleStyle: CSSProperties = {
	marginBlock: 0,
	color: "#475569",
	maxInlineSize: "48rem",
};

const headerActionsStyle: CSSProperties = {
	display: "flex",
	gap: "0.75rem",
	flexWrap: "wrap",
	alignItems: "center",
};

const statusBadgeStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	paddingBlock: "0.25rem",
	paddingInline: "0.625rem",
	borderRadius: "999px",
	fontWeight: 600,
	fontSize: "0.8125rem",
};

const primaryLinkStyle: CSSProperties = {
	display: "inline-block",
	paddingBlock: "0.625rem",
	paddingInline: "1rem",
	borderRadius: "0.5rem",
	backgroundColor: "#2563eb",
	color: "white",
	textDecoration: "none",
	fontWeight: 600,
};

const secondaryLinkStyle: CSSProperties = {
	...primaryLinkStyle,
	backgroundColor: "white",
	color: "#0f172a",
	border: "1px solid #cbd5e1",
};

const disabledPillStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	paddingBlock: "0.625rem",
	paddingInline: "1rem",
	borderRadius: "0.5rem",
	backgroundColor: "#f1f5f9",
	color: "#64748b",
	fontWeight: 600,
	fontSize: "0.925rem",
};

const tabBarStyle: CSSProperties = {
	display: "flex",
	gap: "0.5rem",
	flexWrap: "wrap",
	paddingBlockEnd: "1rem",
	borderBlockEnd: "1px solid #e2e8f0",
	marginBlockEnd: "1.25rem",
};

const tabButtonStyle = (active: boolean): CSSProperties => ({
	paddingBlock: "0.625rem",
	paddingInline: "0.875rem",
	borderRadius: "0.625rem",
	border: active ? "1px solid #2563eb" : "1px solid transparent",
	backgroundColor: active ? "#dbeafe" : "transparent",
	color: active ? "#1d4ed8" : "#334155",
	fontWeight: active ? 700 : 500,
	cursor: "pointer",
});

const stackStyle: CSSProperties = {
	display: "grid",
	gap: "1rem",
};

const panelStyle: CSSProperties = {
	padding: "1rem",
	borderRadius: "0.75rem",
	border: "1px solid #e2e8f0",
	backgroundColor: "white",
};

const statsGridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
	gap: "0.75rem",
};

const statCardStyle: CSSProperties = {
	padding: "1rem",
	borderRadius: "0.75rem",
	border: "1px solid #e2e8f0",
	backgroundColor: "white",
	minBlockSize: "7rem",
};

const statLabelStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.8125rem",
	marginBlockEnd: "0.25rem",
};

const statValueStyle: CSSProperties = {
	fontSize: "1.75rem",
	fontWeight: 700,
	fontVariantNumeric: "tabular-nums",
};

const statHintStyle: CSSProperties = {
	marginBlockStart: "0.5rem",
	fontSize: "0.8125rem",
	color: "#64748b",
};

const sectionHeaderStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "1rem",
	marginBlockEnd: "0.75rem",
	flexWrap: "wrap",
};

const sectionTitleStyle: CSSProperties = {
	fontSize: "1.125rem",
	marginBlock: 0,
};

const sectionMetaStyle: CSSProperties = {
	fontSize: "0.875rem",
	color: "#64748b",
};

const chartStyle: CSSProperties = {
	inlineSize: "100%",
	maxInlineSize: "100%",
	blockSize: "10rem",
	display: "block",
	marginBlockEnd: "0.75rem",
};

const timelineLegendStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(6rem, 1fr))",
	gap: "0.5rem",
};

const timelineLegendItemStyle: CSSProperties = {
	padding: "0.5rem",
	borderRadius: "0.5rem",
	backgroundColor: "#f8fafc",
	border: "1px solid #e2e8f0",
};

const timelineLegendCountStyle: CSSProperties = {
	display: "block",
	fontWeight: 700,
	fontVariantNumeric: "tabular-nums",
};

const timelineLegendDateStyle: CSSProperties = {
	fontSize: "0.8125rem",
	color: "#64748b",
};

const funnelListStyle: CSSProperties = {
	listStyle: "none",
	paddingInlineStart: 0,
	marginBlock: 0,
	display: "grid",
	gap: "0.75rem",
};

const funnelItemStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "4rem 1fr auto",
	alignItems: "center",
	gap: "0.75rem",
};

const funnelLabelStyle: CSSProperties = {
	fontWeight: 600,
};

const funnelBarTrackStyle: CSSProperties = {
	blockSize: "0.75rem",
	borderRadius: "999px",
	backgroundColor: "#e2e8f0",
	overflow: "hidden",
};

const funnelBarFillStyle = (percent: number): CSSProperties => ({
	inlineSize: `${percent}%`,
	blockSize: "100%",
	background: "linear-gradient(90deg, #60a5fa, #2563eb)",
	borderRadius: "999px",
});

const funnelValueStyle: CSSProperties = {
	fontVariantNumeric: "tabular-nums",
	color: "#334155",
	whiteSpace: "nowrap",
};

const toolbarStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "1rem",
	flexWrap: "wrap",
};

const toolbarMetaStyle: CSSProperties = {
	fontSize: "0.875rem",
	color: "#64748b",
};

const toolbarActionsStyle: CSSProperties = {
	display: "flex",
	gap: "0.75rem",
	flexWrap: "wrap",
	alignItems: "center",
};

const toolbarGroupStyle: CSSProperties = {
	display: "flex",
	gap: "0.75rem",
	alignItems: "center",
	flexWrap: "wrap",
};

const fieldLabelStyle: CSSProperties = {
	display: "inline-flex",
	flexDirection: "column",
	gap: "0.25rem",
	fontSize: "0.875rem",
	color: "#475569",
};

const selectStyle: CSSProperties = {
	minInlineSize: "13rem",
	paddingBlock: "0.5rem",
	paddingInline: "0.75rem",
	borderRadius: "0.5rem",
	border: "1px solid #cbd5e1",
	backgroundColor: "white",
	color: "#0f172a",
};

const secondaryButtonStyle: CSSProperties = {
	paddingBlock: "0.5rem",
	paddingInline: "0.75rem",
	borderRadius: "0.5rem",
	border: "1px solid #cbd5e1",
	backgroundColor: "white",
	color: "#0f172a",
	cursor: "pointer",
	fontWeight: 500,
};

const disabledButtonStyle: CSSProperties = {
	...secondaryButtonStyle,
	opacity: 0.6,
	cursor: "not-allowed",
};

const tableWrapperStyle: CSSProperties = {
	border: "1px solid #e2e8f0",
	borderRadius: "0.75rem",
	backgroundColor: "white",
	overflow: "hidden",
};

const tableStyle: CSSProperties = {
	inlineSize: "100%",
	borderCollapse: "collapse",
	fontSize: "0.925rem",
};

const thStyle: CSSProperties = {
	textAlign: "start",
	paddingBlock: "0.75rem",
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
	inlineSize: "8rem",
};

const tdStyle: CSSProperties = {
	paddingBlock: "0.75rem",
	paddingInline: "0.875rem",
	borderBlockStart: "1px solid #f1f5f9",
	verticalAlign: "middle",
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

const linkButtonStyle: CSSProperties = {
	padding: 0,
	border: 0,
	background: "none",
	color: "#2563eb",
	textDecoration: "none",
	fontWeight: 600,
	cursor: "pointer",
};

const matrixWrapperStyle: CSSProperties = {
	overflowX: "auto",
	border: "1px solid #e2e8f0",
	borderRadius: "0.75rem",
	backgroundColor: "white",
};

const matrixTableStyle: CSSProperties = {
	borderCollapse: "separate",
	borderSpacing: 0,
	minInlineSize: "48rem",
	inlineSize: "100%",
};

const stickyThStyle: CSSProperties = {
	...thStyle,
	position: "sticky",
	left: 0,
	zIndex: 2,
	backgroundColor: "#f8fafc",
};

const stickyTdStyle: CSSProperties = {
	...tdStyle,
	position: "sticky",
	left: 0,
	zIndex: 1,
	backgroundColor: "white",
	fontWeight: 600,
};

const matrixThStyle: CSSProperties = {
	...thNumStyle,
	minInlineSize: "4.5rem",
	textAlign: "center",
};

const matrixCellOuterStyle: CSSProperties = {
	padding: "0.375rem",
	borderBlockStart: "1px solid #f1f5f9",
	textAlign: "center",
};

const matrixCellButtonStyle = (percent: number, selected: boolean): CSSProperties => {
	let backgroundColor = "#e2e8f0";
	let color = "#334155";
	if (percent >= 100) {
		backgroundColor = "#1d4ed8";
		color = "white";
	} else if (percent >= 75) {
		backgroundColor = "#2563eb";
		color = "white";
	} else if (percent > 0) {
		backgroundColor = "#bfdbfe";
		color = "#1e3a8a";
	}
	return {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		inlineSize: "100%",
		minInlineSize: "4rem",
		paddingBlock: "0.5rem",
		paddingInline: "0.25rem",
		borderRadius: "0.5rem",
		border: selected ? "2px solid #0f172a" : "1px solid transparent",
		backgroundColor,
		color,
		fontWeight: 700,
		cursor: "pointer",
		fontVariantNumeric: "tabular-nums",
	};
};

const legendStyle: CSSProperties = {
	display: "flex",
	gap: "1rem",
	flexWrap: "wrap",
	fontSize: "0.875rem",
	color: "#475569",
};

const legendItemStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: "0.5rem",
};

const legendSwatchStyle = (color: string): CSSProperties => ({
	display: "inline-block",
	inlineSize: "0.875rem",
	blockSize: "0.875rem",
	borderRadius: "0.25rem",
	backgroundColor: color,
	border: "1px solid rgba(15, 23, 42, 0.08)",
});

const detailGridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
	gap: "0.75rem",
	marginBlockEnd: "0.75rem",
};

const detailRowStyle: CSSProperties = {
	padding: "0.75rem",
	borderRadius: "0.625rem",
	backgroundColor: "#f8fafc",
	border: "1px solid #e2e8f0",
};

const detailKeyStyle: CSSProperties = {
	fontSize: "0.8125rem",
	color: "#64748b",
	marginBlockEnd: "0.25rem",
};

const detailValueStyle: CSSProperties = {
	fontWeight: 600,
	wordBreak: "break-word",
};

const miniListStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
	gap: "0.5rem",
};

const miniListItemStyle: CSSProperties = {
	display: "flex",
	justifyContent: "space-between",
	gap: "0.75rem",
	padding: "0.5rem 0.75rem",
	borderRadius: "0.5rem",
	backgroundColor: "#f8fafc",
	border: "1px solid #e2e8f0",
};

const miniListKeyStyle: CSSProperties = {
	fontWeight: 600,
	color: "#334155",
};

const miniListValueStyle: CSSProperties = {
	fontVariantNumeric: "tabular-nums",
	color: "#0f172a",
};

const paragraphStyle: CSSProperties = {
	marginBlockStart: 0,
	marginBlockEnd: "1rem",
	lineHeight: 1.6,
	color: "#334155",
};

const helperTextStyle: CSSProperties = {
	marginBlock: 0,
	fontSize: "0.875rem",
	color: "#64748b",
};

const mutedBannerStyle: CSSProperties = {
	padding: "0.875rem 1rem",
	borderRadius: "0.75rem",
	border: "1px solid #cbd5e1",
	backgroundColor: "#f1f5f9",
	color: "#334155",
};

const errorBannerStyle: CSSProperties = {
	padding: "0.875rem 1rem",
	borderRadius: "0.75rem",
	border: "1px solid #fecaca",
	backgroundColor: "#fef2f2",
	color: "#991b1b",
};

const errorInlineStyle: CSSProperties = {
	padding: "0.75rem 1rem",
	borderRadius: "0.625rem",
	border: "1px solid #fecaca",
	backgroundColor: "#fff1f2",
	color: "#991b1b",
	fontSize: "0.925rem",
};

const emptyStateStyle: CSSProperties = {
	padding: "1rem",
	border: "1px dashed #cbd5e1",
	borderRadius: "0.75rem",
	color: "#64748b",
	backgroundColor: "white",
};

const infoBannerStyle: CSSProperties = {
	padding: "0.875rem 1rem",
	borderRadius: "0.75rem",
	border: "1px solid #bfdbfe",
	backgroundColor: "#eff6ff",
	color: "#1d4ed8",
	fontSize: "0.925rem",
	lineHeight: 1.5,
};

export default CoursePage;