import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type FormEvent,
	type ReactElement,
} from "react";

import {
	LmsApiError,
	createApiClient,
	type ApiClient,
	type ReportingQueryInput,
	type ReportingQueryResponse,
} from "./api-client.js";

export interface ReportFilters {
	startDate: string;
	endDate: string;
	courseId: string;
}

export type ReportViewState =
	| {
			kind: "ready";
			query: ReportingQueryInput;
			report: ReportingQueryResponse;
	  }
	| { kind: "loading" }
	| { kind: "error"; message: string };

export interface ReportsViewProps {
	filters: ReportFilters;
	state: ReportViewState;
	now: string;
	onFiltersChange: (filters: ReportFilters) => void;
	onSubmit: () => void;
	onRetry: () => void;
}

export interface ReportsPageProps {
	api?: Pick<ApiClient, "reporting">;
	now?: () => Date;
}

const systemNow = () => new Date();

function utcMidnight(day: string): Date {
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
		throw new Error("Choose valid start and end dates.");
	}
	const value = new Date(`${day}T00:00:00.000Z`);
	if (Number.isNaN(value.valueOf()) || value.toISOString().slice(0, 10) !== day) {
		throw new Error("Choose valid start and end dates.");
	}
	return value;
}

export function reportQueryFromFilters(filters: ReportFilters): ReportingQueryInput {
	const from = utcMidnight(filters.startDate);
	const through = utcMidnight(filters.endDate);
	if (through < from) {
		throw new Error("End date must be on or after start date.");
	}
	const to = new Date(through.valueOf() + 86_400_000);
	const courseId = filters.courseId.trim();
	return {
		from: from.toISOString(),
		to: to.toISOString(),
		...(courseId.length > 0 ? { courseId } : {}),
	};
}

function defaultReportFilters(now: Date): ReportFilters {
	const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const start = end - 6 * 86_400_000;
	return {
		startDate: new Date(start).toISOString().slice(0, 10),
		endDate: new Date(end).toISOString().slice(0, 10),
		courseId: "",
	};
}

function errorMessage(error: unknown): string {
	if (error instanceof LmsApiError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}

export function ReportsPage({
	api: suppliedApi,
	now = systemNow,
}: ReportsPageProps = {}): ReactElement {
	const api = useMemo(() => suppliedApi ?? createApiClient(), [suppliedApi]);
	const [filters, setFilters] = useState<ReportFilters>(() => defaultReportFilters(now()));
	const initialFilters = useRef(filters);
	const [state, setState] = useState<ReportViewState>({ kind: "loading" });

	const load = useCallback(
		async (nextFilters: ReportFilters) => {
			setState({ kind: "loading" });
			try {
				const query = reportQueryFromFilters(nextFilters);
				const report = await api.reporting.query(query);
				setState({ kind: "ready", query, report });
			} catch (error) {
				setState({ kind: "error", message: errorMessage(error) });
			}
		},
		[api],
	);

	useEffect(() => {
		void load(initialFilters.current);
	}, [load]);

	return (
		<ReportsView
			filters={filters}
			state={state}
			now={now().toISOString()}
			onFiltersChange={setFilters}
			onSubmit={() => void load(filters)}
			onRetry={() => void load(filters)}
		/>
	);
}

function passRate(passed: number, attempts: number): string {
	if (attempts === 0) return "Not available";
	const percentage = (passed / attempts) * 100;
	return `${Number.isInteger(percentage) ? percentage : percentage.toFixed(1)}%`;
}

function scoreBandLabel(minimum: number, maximum: number): string {
	return minimum === maximum ? `${minimum}%` : `${minimum}–${maximum}%`;
}

function formatInstant(instant: string): string {
	return new Intl.DateTimeFormat("en-US", {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "UTC",
	}).format(new Date(instant));
}

function reportIsStale(calculatedThrough: string, queryTo: string, now: string): boolean {
	const calculated = Date.parse(calculatedThrough);
	const rangeEnd = Date.parse(queryTo);
	const current = Date.parse(now);
	if (![calculated, rangeEnd, current].every(Number.isFinite)) return true;
	const coverageTarget = Math.min(rangeEnd, current);
	return coverageTarget - calculated > 86_400_000;
}

export function ReportsView({
	filters,
	state,
	now,
	onFiltersChange,
	onSubmit,
	onRetry,
}: ReportsViewProps): ReactElement {
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		onSubmit();
	}

	return (
		<section style={pageStyle}>
			<header>
				<p style={eyebrowStyle}>EmDash Learn</p>
				<h1 style={titleStyle}>Engagement reporting</h1>
				<p style={introStyle}>Review anonymous directional engagement for an exact date range.</p>
			</header>

			<form onSubmit={submit} style={filterStyle}>
				<label style={fieldStyle}>
					<span>Start date</span>
					<input
						type="date"
						required
						value={filters.startDate}
						onChange={(event) =>
							onFiltersChange({ ...filters, startDate: event.currentTarget.value })
						}
					/>
				</label>
				<label style={fieldStyle}>
					<span>End date (inclusive)</span>
					<input
						type="date"
						required
						min={filters.startDate}
						value={filters.endDate}
						onChange={(event) =>
							onFiltersChange({ ...filters, endDate: event.currentTarget.value })
						}
					/>
				</label>
				<label style={fieldStyle}>
					<span>Course ID (optional)</span>
					<input
						type="text"
						value={filters.courseId}
						onChange={(event) =>
							onFiltersChange({ ...filters, courseId: event.currentTarget.value })
						}
					/>
				</label>
				<button type="submit">Apply filters</button>
			</form>

			<aside style={noteStyle}>
				<p>Metrics are anonymous directional browser observations, not unique visitors.</p>
				<p>Calculated through is the report snapshot time, not the latest visitor activity.</p>
			</aside>

			{state.kind === "loading" ? (
				<p role="status" aria-live="polite">
					Loading engagement report…
				</p>
			) : null}

			{state.kind === "error" ? (
				<div role="alert">
					<p>{state.message}</p>
					<button type="button" onClick={onRetry}>
						Retry report
					</button>
				</div>
			) : null}

			{state.kind === "ready" ? (
				<div>
					<p role="status">
						{state.report.calculatedThrough ? (
							<>
								<strong>
									{reportIsStale(state.report.calculatedThrough, state.query.to, now)
										? "Data may be stale."
										: "Data is current."}
								</strong>{" "}
								Calculated through{" "}
								<time dateTime={state.report.calculatedThrough}>
									{formatInstant(state.report.calculatedThrough)}
								</time>
								.
							</>
						) : (
							<>
								<strong>Freshness is unavailable.</strong> No calculation watermark was returned.
							</>
						)}
					</p>
					{state.report.courses.length === 0 ? (
						<div role="status" aria-live="polite">
							<h2>No engagement activity</h2>
							<p>No engagement activity matched these filters.</p>
						</div>
					) : (
						<div style={courseListStyle}>
							{state.report.courses.map((course) => (
								<article key={course.courseId} style={courseStyle}>
									<h2 style={courseTitleStyle}>Course {course.courseId}</h2>
									<dl style={metricGridStyle}>
										<Metric label="Course opens" value={String(course.opens)} />
										<Metric label="Lesson opens" value={String(course.lessonOpens)} />
										<Metric label="Check opens" value={String(course.checkOpens)} />
										<Metric
											label="Self-check submissions"
											value={String(course.checkSubmissions)}
										/>
										<Metric label="Passed self-checks" value={String(course.passedSubmissions)} />
										<Metric
											label="Pass rate"
											value={passRate(course.passedSubmissions, course.checkSubmissions)}
										/>
									</dl>
									<div>
										<h3>Score bands</h3>
										{course.scoreBands && course.scoreBands.length > 0 ? (
											<ul>
												{course.scoreBands.map((band) => (
													<li key={`${band.minimum}-${band.maximum}`}>
														{scoreBandLabel(band.minimum, band.maximum)}: {band.count}
													</li>
												))}
											</ul>
										) : (
											<p>No scored attempts in this range.</p>
										)}
									</div>
								</article>
							))}
						</div>
					)}
				</div>
			) : null}
		</section>
	);
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
	return (
		<div style={metricStyle}>
			<dt>{label}</dt>
			<dd style={metricValueStyle}>{value}</dd>
		</div>
	);
}

const pageStyle: CSSProperties = {
	maxWidth: "80rem",
	marginInline: "auto",
	padding: "2rem",
	color: "#0f172a",
};

const eyebrowStyle: CSSProperties = {
	margin: 0,
	color: "#4f46e5",
	fontSize: "0.75rem",
	fontWeight: 700,
	letterSpacing: "0.08em",
	textTransform: "uppercase",
};

const titleStyle: CSSProperties = {
	marginBlock: "0.5rem",
	fontSize: "2rem",
};

const introStyle: CSSProperties = {
	color: "#475569",
};

const filterStyle: CSSProperties = {
	display: "flex",
	flexWrap: "wrap",
	alignItems: "end",
	gap: "1rem",
	marginBlock: "1.5rem",
	padding: "1rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.75rem",
};

const fieldStyle: CSSProperties = {
	display: "grid",
	gap: "0.35rem",
	fontWeight: 600,
};

const noteStyle: CSSProperties = {
	padding: "0.75rem 1rem",
	borderRadius: "0.75rem",
	background: "#f8fafc",
	color: "#475569",
	fontSize: "0.9rem",
};

const courseListStyle: CSSProperties = {
	display: "grid",
	gap: "1rem",
};

const courseStyle: CSSProperties = {
	padding: "1.25rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.75rem",
	background: "#fff",
};

const courseTitleStyle: CSSProperties = {
	marginBlockStart: 0,
};

const metricGridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
	gap: "0.75rem",
	margin: 0,
};

const metricStyle: CSSProperties = {
	padding: "0.75rem",
	borderRadius: "0.5rem",
	background: "#f8fafc",
};

const metricValueStyle: CSSProperties = {
	margin: "0.25rem 0 0",
	fontSize: "1.5rem",
	fontWeight: 700,
};

export default ReportsPage;
