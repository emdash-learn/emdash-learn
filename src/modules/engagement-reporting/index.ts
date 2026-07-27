import type { LearnerPrincipal } from "../learner-principal.js";

export type EngagementObservation =
	| {
			type: "course_opened";
			courseId: string;
			actor: LearnerPrincipal;
	  }
	| {
			type: "lesson_opened" | "lesson_completed";
			courseId: string;
			lessonId: string;
			actor: LearnerPrincipal;
	  }
	| {
			type: "check_opened";
			courseId: string;
			checkId: string;
			actor: LearnerPrincipal;
	  }
	| {
			type: "check_submitted";
			courseId: string;
			checkId: string;
			passed: boolean;
			score: number;
			actor: LearnerPrincipal;
	  };

export interface StoredEngagementObservation {
	id: string;
	type: EngagementObservation["type"];
	courseId: string;
	lessonId?: string;
	checkId?: string;
	actorKind: LearnerPrincipal["kind"];
	actorKey?: string;
	passed?: boolean;
	scoreBand?: number;
	observedAt: string;
	day: string;
}

export interface ActorCount {
	total: number;
	anonymous: number;
	verified: number;
}

export interface CourseEngagementReport {
	courseId: string;
	opens: ActorCount;
	/**
	 * Sum of distinct verified accounts active in each UTC day.
	 *
	 * This intentionally is not presented as cross-day unique people because
	 * day-scoped pseudonyms are not joinable across UTC days.
	 */
	verifiedAccountDays: number;
	lessonOpens: ActorCount;
	lessonCompletions: ActorCount;
	checkOpens: ActorCount;
	checkSubmissions: ActorCount;
	passedSubmissions: ActorCount;
	scoreBands?: Array<{
		minimum: number;
		maximum: number;
		count: ActorCount;
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
	pseudonymize: (learnerId: string, day: string) => string | Promise<string>;
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
	verifiedActorDays: Set<string>;
	scoreBandCounts: Map<number, ActorCount>;
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

function emptyActorCount(): ActorCount {
	return {
		total: 0,
		anonymous: 0,
		verified: 0,
	};
}

function incrementActorCount(
	count: ActorCount,
	actorKind: StoredEngagementObservation["actorKind"],
): void {
	count.total += 1;
	count[actorKind] += 1;
}

function mutableCourse(courseId: string): MutableCourseReport {
	return {
		courseId,
		opens: emptyActorCount(),
		verifiedAccountDays: 0,
		lessonOpens: emptyActorCount(),
		lessonCompletions: emptyActorCount(),
		checkOpens: emptyActorCount(),
		checkSubmissions: emptyActorCount(),
		passedSubmissions: emptyActorCount(),
		verifiedActorDays: new Set(),
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
	if (observation.actorKey) {
		course.verifiedActorDays.add(`${observation.day}:${observation.actorKey}`);
	}
	switch (observation.type) {
		case "course_opened": {
			incrementActorCount(course.opens, observation.actorKind);
			break;
		}
		case "lesson_opened": {
			incrementActorCount(course.lessonOpens, observation.actorKind);
			break;
		}
		case "lesson_completed": {
			incrementActorCount(course.lessonCompletions, observation.actorKind);
			break;
		}
		case "check_opened": {
			incrementActorCount(course.checkOpens, observation.actorKind);
			break;
		}
		case "check_submitted": {
			incrementActorCount(course.checkSubmissions, observation.actorKind);
			if (observation.passed) {
				incrementActorCount(course.passedSubmissions, observation.actorKind);
			}
			if (observation.scoreBand !== undefined) {
				const count = course.scoreBandCounts.get(observation.scoreBand) ?? emptyActorCount();
				incrementActorCount(count, observation.actorKind);
				course.scoreBandCounts.set(observation.scoreBand, count);
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
			.map(({ scoreBandCounts, verifiedActorDays, ...course }) => {
				course.verifiedAccountDays += verifiedActorDays.size;
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
			let observedAt = dependencies.clock().toISOString();
			let day = utcDay(observedAt);
			let actorKey: string | undefined;
			if (observation.actor.kind === "verified") {
				// Pseudonym generation may straddle midnight. Finalize the event
				// timestamp after that await and recompute until its day and key
				// agree.
				for (;;) {
					// oxlint-disable-next-line no-await-in-loop -- the loop runs again only across UTC midnight
					actorKey = await dependencies.pseudonymize(observation.actor.learnerId, day);
					observedAt = dependencies.clock().toISOString();
					const finalizedDay = utcDay(observedAt);
					if (finalizedDay === day) break;
					day = finalizedDay;
				}
			}
			const stored: StoredEngagementObservation = {
				id: dependencies.nextId(),
				type: observation.type,
				courseId: observation.courseId,
				actorKind: observation.actor.kind,
				observedAt,
				day,
			};
			if (actorKey !== undefined) stored.actorKey = actorKey;
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
