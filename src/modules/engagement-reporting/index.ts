export type EngagementObservation =
	| {
			type: "course_opened";
			courseId: string;
	  }
	| {
			type: "lesson_opened";
			courseId: string;
			lessonId: string;
	  }
	| {
			type: "check_opened";
			courseId: string;
			checkId: string;
	  }
	| {
			type: "check_submitted";
			courseId: string;
			checkId: string;
			passed: boolean;
			score: number;
	  };

export interface StoredEngagementObservation {
	id: string;
	type: EngagementObservation["type"];
	courseId: string;
	lessonId?: string;
	checkId?: string;
	passed?: boolean;
	scoreBand?: number;
	observedAt: string;
	day: string;
}

export interface CourseEngagementReport {
	courseId: string;
	opens: number;
	lessonOpens: number;
	checkOpens: number;
	checkSubmissions: number;
	passedSubmissions: number;
	scoreBands?: Array<{
		minimum: number;
		maximum: number;
		count: number;
	}>;
}

export interface EngagementStore {
	appendObservation(observation: StoredEngagementObservation): Promise<void>;
	listObservations(input: { from: string; to: string }): Promise<StoredEngagementObservation[]>;
	deleteObservationsBefore(cutoff: string): Promise<number>;
}

export interface EngagementReportQuery {
	/** Inclusive UTC midnight, as an ISO timestamp. */
	from: string;
	/** Exclusive UTC midnight, as an ISO timestamp. */
	to: string;
	courseId?: string;
}

export interface EngagementReport {
	calculatedThrough: string | null;
	courses: CourseEngagementReport[];
}

export interface EngagementPruneResult {
	observationsPruned: number;
}

export interface EngagementReporting {
	observe(observation: EngagementObservation): Promise<void>;
	query(input: EngagementReportQuery): Promise<EngagementReport>;
	pruneExpired(): Promise<EngagementPruneResult>;
}

export interface EngagementReportingDependencies {
	store: EngagementStore;
	clock: () => Date;
	nextId: () => string;
}

export const ENGAGEMENT_OBSERVATION_RETENTION_DAYS = 90;
const ENGAGEMENT_OBSERVATION_RETENTION_MS = ENGAGEMENT_OBSERVATION_RETENTION_DAYS * 86_400_000;

export class EngagementReportingError extends Error {
	constructor(
		readonly code: "LEARN_REPORT_INVALID_RANGE",
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "EngagementReportingError";
	}
}

interface MutableCourseReport extends CourseEngagementReport {
	scoreBandCounts: Map<number, number>;
}

function utcDay(instant: string): string {
	return instant.slice(0, 10);
}

function utcDayStart(day: string): string {
	return `${day}T00:00:00.000Z`;
}

function requireUtcDayRange(input: EngagementReportQuery): void {
	const fromDay = utcDay(input.from);
	const toDay = utcDay(input.to);
	if (
		input.from !== utcDayStart(fromDay) ||
		input.to !== utcDayStart(toDay) ||
		input.from >= input.to
	) {
		throw new EngagementReportingError(
			"LEARN_REPORT_INVALID_RANGE",
			"Reporting ranges must use increasing UTC-midnight ISO timestamps.",
		);
	}
}

function scoreBand(score: number): number {
	return Math.max(0, Math.min(100, Math.floor(score / 10) * 10));
}

function mutableCourse(courseId: string): MutableCourseReport {
	return {
		courseId,
		opens: 0,
		lessonOpens: 0,
		checkOpens: 0,
		checkSubmissions: 0,
		passedSubmissions: 0,
		scoreBandCounts: new Map(),
	};
}

function courseFor(
	courses: Map<string, MutableCourseReport>,
	courseId: string,
): MutableCourseReport {
	const existing = courses.get(courseId);
	if (existing) return existing;
	const created = mutableCourse(courseId);
	courses.set(courseId, created);
	return created;
}

function addObservation(
	courses: Map<string, MutableCourseReport>,
	observation: StoredEngagementObservation,
): void {
	const course = courseFor(courses, observation.courseId);
	switch (observation.type) {
		case "course_opened": {
			course.opens += 1;
			break;
		}
		case "lesson_opened": {
			course.lessonOpens += 1;
			break;
		}
		case "check_opened": {
			course.checkOpens += 1;
			break;
		}
		case "check_submitted": {
			course.checkSubmissions += 1;
			if (observation.passed) course.passedSubmissions += 1;
			if (observation.scoreBand !== undefined) {
				course.scoreBandCounts.set(
					observation.scoreBand,
					(course.scoreBandCounts.get(observation.scoreBand) ?? 0) + 1,
				);
			}
			break;
		}
	}
}

function finishReports(
	courses: Map<string, MutableCourseReport>,
	courseId?: string,
): CourseEngagementReport[] {
	return (
		[...courses.values()]
			.filter((course) => courseId === undefined || course.courseId === courseId)
			.map(({ scoreBandCounts, ...course }) => {
				if (scoreBandCounts.size > 0) {
					const orderedBands = [...scoreBandCounts.entries()];
					// oxlint-disable-next-line no-array-sort -- sorting a new local array
					orderedBands.sort(([left], [right]) => left - right);
					course.scoreBands = orderedBands.map(([minimum, count]) => ({
						minimum,
						maximum: minimum === 100 ? 100 : minimum + 9,
						count,
					}));
				}
				return course;
			})
			// oxlint-disable-next-line no-array-sort -- sorting a new local array
			.sort((left, right) => left.courseId.localeCompare(right.courseId))
	);
}

function reportsFromObservations(
	observations: StoredEngagementObservation[],
	courseId?: string,
): CourseEngagementReport[] {
	const courses = new Map<string, MutableCourseReport>();
	for (const observation of observations) addObservation(courses, observation);
	return finishReports(courses, courseId);
}

export function createEngagementReporting(
	dependencies: EngagementReportingDependencies,
): EngagementReporting {
	return {
		async observe(observation) {
			const observedAt = dependencies.clock().toISOString();
			const stored: StoredEngagementObservation = {
				id: dependencies.nextId(),
				type: observation.type,
				courseId: observation.courseId,
				observedAt,
				day: utcDay(observedAt),
			};
			if ("lessonId" in observation) stored.lessonId = observation.lessonId;
			if ("checkId" in observation) stored.checkId = observation.checkId;
			if (observation.type === "check_submitted") {
				stored.passed = observation.passed;
				stored.scoreBand = scoreBand(observation.score);
			}
			await dependencies.store.appendObservation(stored);
		},

		async query(input) {
			requireUtcDayRange(input);
			const observations = await dependencies.store.listObservations({
				from: input.from,
				to: input.to,
			});
			return {
				calculatedThrough: dependencies.clock().toISOString(),
				courses: reportsFromObservations(observations, input.courseId),
			};
		},

		async pruneExpired() {
			const cutoff = new Date(
				dependencies.clock().valueOf() - ENGAGEMENT_OBSERVATION_RETENTION_MS,
			).toISOString();
			return {
				observationsPruned: await dependencies.store.deleteObservationsBefore(cutoff),
			};
		},
	};
}

export function createNullEngagementReporting(): EngagementReporting {
	return {
		async observe() {},
		async query() {
			return {
				calculatedThrough: null,
				courses: [],
			};
		},
		async pruneExpired() {
			return { observationsPruned: 0 };
		},
	};
}
