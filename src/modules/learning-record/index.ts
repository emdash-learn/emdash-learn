import type { VerifiedLearner } from "../learner-principal.js";

export type CompletionSource = "learner" | "device_import";

export interface CompletionFact {
	learnerKey: string;
	courseId: string;
	lessonId: string;
	completedAt: string;
	source: CompletionSource;
	operationId: string;
}

export interface CompletionFactCreateResult {
	created: boolean;
	fact: CompletionFact;
}

export interface CompletionFactStore {
	get(learnerKey: string, lessonId: string): Promise<CompletionFact | null>;
	/**
	 * Creates one immutable fact per learner and lesson, or returns the fact
	 * that won a concurrent create.
	 */
	create(fact: CompletionFact): Promise<CompletionFactCreateResult>;
	listForLessons(learnerKey: string, lessonIds: string[]): Promise<CompletionFact[]>;
	deleteForLearner(learnerKey: string): Promise<number>;
}

export interface LearningContent {
	getPublishedLesson(lessonId: string): Promise<{ lessonId: string; courseId: string } | null>;
	listPublishedLessons(courseId: string): Promise<{ courseId: string; lessonIds: string[] } | null>;
}

export interface CourseProgress {
	courseId: string;
	totalLessons: number;
	completedLessons: number;
	percentComplete: number;
}

export interface LessonCompletionResult {
	newlyCompleted: boolean;
	completedAt: string;
	progress: CourseProgress;
}

export interface LearningRecord {
	completeLesson(
		learner: VerifiedLearner,
		input: { lessonId: string; operationId: string },
	): Promise<LessonCompletionResult>;
	getCourseProgress(learner: VerifiedLearner, input: { courseId: string }): Promise<CourseProgress>;
	importDeviceProgress(
		learner: VerifiedLearner,
		input: {
			courseId: string;
			lessonIds: string[];
			operationId: string;
		},
	): Promise<{
		importedLessons: number;
		importedLessonIds: string[];
		ignoredLessons: number;
		progress: CourseProgress;
	}>;
	eraseLearner(learner: VerifiedLearner): Promise<{ deletedCompletions: number }>;
}

export interface LearningRecordDependencies {
	content: LearningContent;
	completions: CompletionFactStore;
	clock: () => Date;
	hash: {
		/** Produces an installation-keyed, one-way ownership key. */
		digest(value: string): Promise<string>;
	};
}

export class LearningRecordError extends Error {
	constructor(
		readonly code: "LEARN_CONTENT_NOT_FOUND",
		message = "Published learning content was not found.",
		readonly status = 404,
	) {
		super(message);
		this.name = "LearningRecordError";
	}
}

export function createLearningRecord(dependencies: LearningRecordDependencies): LearningRecord {
	async function learnerKey(learner: VerifiedLearner): Promise<string> {
		return dependencies.hash.digest(JSON.stringify(["learner", learner.learnerId]));
	}

	async function getCourseProgress(
		learner: VerifiedLearner,
		input: { courseId: string },
	): Promise<CourseProgress> {
		const outline = await dependencies.content.listPublishedLessons(input.courseId);
		if (!outline) throw new LearningRecordError("LEARN_CONTENT_NOT_FOUND");

		const publishedLessons = new Set(outline.lessonIds);
		const completions = await dependencies.completions.listForLessons(await learnerKey(learner), [
			...publishedLessons,
		]);
		const completedLessons = new Set(
			completions
				.filter((completion) => publishedLessons.has(completion.lessonId))
				.map((completion) => completion.lessonId),
		).size;
		const totalLessons = publishedLessons.size;
		const percentComplete =
			totalLessons === 0 ? 0 : Math.round((completedLessons / totalLessons) * 100);
		return {
			courseId: input.courseId,
			totalLessons,
			completedLessons,
			percentComplete,
		};
	}

	return {
		async completeLesson(learner, input) {
			const lesson = await dependencies.content.getPublishedLesson(input.lessonId);
			if (!lesson) throw new LearningRecordError("LEARN_CONTENT_NOT_FOUND");

			const ownerKey = await learnerKey(learner);
			const completedAt = dependencies.clock().toISOString();
			const completion = await dependencies.completions.create({
				learnerKey: ownerKey,
				courseId: lesson.courseId,
				lessonId: input.lessonId,
				completedAt,
				source: "learner",
				operationId: input.operationId,
			});
			return {
				newlyCompleted: completion.created,
				completedAt: completion.fact.completedAt,
				progress: await getCourseProgress(learner, { courseId: lesson.courseId }),
			};
		},
		getCourseProgress,
		async importDeviceProgress(learner, input) {
			const outline = await dependencies.content.listPublishedLessons(input.courseId);
			if (!outline) throw new LearningRecordError("LEARN_CONTENT_NOT_FOUND");

			const publishedLessons = new Set(outline.lessonIds);
			const uniqueCandidates: string[] = [];
			const seen = new Set<string>();
			for (const lessonId of input.lessonIds) {
				if (!publishedLessons.has(lessonId) || seen.has(lessonId)) continue;
				seen.add(lessonId);
				uniqueCandidates.push(lessonId);
			}

			const ownerKey = await learnerKey(learner);
			const completedAt = dependencies.clock().toISOString();
			const completions = await Promise.all(
				uniqueCandidates.map((lessonId) =>
					dependencies.completions.create({
						learnerKey: ownerKey,
						courseId: input.courseId,
						lessonId,
						completedAt,
						source: "device_import",
						operationId: input.operationId,
					}),
				),
			);
			const newLessonIds = uniqueCandidates.filter(
				(_, index) => completions[index]?.created === true,
			);
			return {
				importedLessons: newLessonIds.length,
				importedLessonIds: newLessonIds,
				ignoredLessons: input.lessonIds.length - newLessonIds.length,
				progress: await getCourseProgress(learner, { courseId: input.courseId }),
			};
		},
		async eraseLearner(learner) {
			return {
				deletedCompletions: await dependencies.completions.deleteForLearner(
					await learnerKey(learner),
				),
			};
		},
	};
}
