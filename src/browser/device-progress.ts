export const DEVICE_PROGRESS_STORAGE_KEY = "emdash-learn:device-progress:v1";

const MAX_COURSES = 100;
const MAX_LESSONS_PER_COURSE = 1000;
const MAX_SELF_CHECKS_PER_COURSE = 500;
const MAX_ID_LENGTH = 200;

export interface BrowserStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface DeviceSelfCheck {
	checkId: string;
	revisionId: string;
	score: number;
	passed: boolean;
	completedAt: string;
}

export interface DeviceCourseProgress {
	courseId: string;
	completedLessonIds: string[];
	selfChecks: DeviceSelfCheck[];
	updatedAt: string;
}

interface DeviceProgressSnapshot {
	version: 1;
	courses: DeviceCourseProgress[];
}

export interface DeviceProgressStore {
	getCourse(courseId: string): DeviceCourseProgress | null;
	completeLesson(courseId: string, lessonId: string): DeviceCourseProgress;
	recordSelfCheck(
		courseId: string,
		result: {
			checkId: string;
			revisionId: string;
			score: number;
			passed: boolean;
		},
	): DeviceCourseProgress;
	resetCourse(courseId: string): void;
	resetAll(): void;
	exportSnapshot(): string;
	importSnapshot(serialized: string): {
		importedCourses: number;
		importedLessons: number;
		importedSelfChecks: number;
	};
}

export class DeviceProgressError extends Error {
	readonly code = "LEARN_DEVICE_PROGRESS_INVALID";

	constructor(message: string) {
		super(message);
		this.name = "DeviceProgressError";
	}
}

function validId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isIsoTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		!Number.isNaN(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}

function parseSelfCheck(value: unknown): DeviceSelfCheck | null {
	if (typeof value !== "object" || value === null) return null;
	const checkId = Reflect.get(value, "checkId");
	const revisionId = Reflect.get(value, "revisionId");
	const score = Reflect.get(value, "score");
	const passed = Reflect.get(value, "passed");
	const completedAt = Reflect.get(value, "completedAt");
	if (
		!validId(checkId) ||
		!validId(revisionId) ||
		typeof score !== "number" ||
		!Number.isInteger(score) ||
		score < 0 ||
		score > 100 ||
		typeof passed !== "boolean" ||
		!isIsoTimestamp(completedAt)
	) {
		return null;
	}
	return { checkId, revisionId, score, passed, completedAt };
}

function parseCourse(value: unknown): DeviceCourseProgress | null {
	if (typeof value !== "object" || value === null) return null;
	const courseId = Reflect.get(value, "courseId");
	const lessonIds = Reflect.get(value, "completedLessonIds");
	const selfChecks = Reflect.get(value, "selfChecks");
	const updatedAt = Reflect.get(value, "updatedAt");
	if (
		!validId(courseId) ||
		!Array.isArray(lessonIds) ||
		lessonIds.length > MAX_LESSONS_PER_COURSE ||
		!lessonIds.every(validId) ||
		new Set(lessonIds).size !== lessonIds.length ||
		!Array.isArray(selfChecks) ||
		selfChecks.length > MAX_SELF_CHECKS_PER_COURSE ||
		!isIsoTimestamp(updatedAt)
	) {
		return null;
	}
	const parsedChecks = selfChecks.map(parseSelfCheck);
	if (parsedChecks.some((check) => check === null)) return null;
	return {
		courseId,
		completedLessonIds: [...lessonIds],
		selfChecks: parsedChecks.filter((check): check is DeviceSelfCheck => check !== null),
		updatedAt,
	};
}

function parseSnapshot(serialized: string): DeviceProgressSnapshot {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new DeviceProgressError("Device progress is not valid JSON.");
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Reflect.get(value, "version") !== 1 ||
		!Array.isArray(Reflect.get(value, "courses"))
	) {
		throw new DeviceProgressError("Device progress uses an unsupported format.");
	}
	const coursesValue = Reflect.get(value, "courses");
	if (!Array.isArray(coursesValue) || coursesValue.length > MAX_COURSES) {
		throw new DeviceProgressError("Device progress contains too many courses.");
	}
	const courses = coursesValue.map(parseCourse);
	if (courses.some((course) => course === null)) {
		throw new DeviceProgressError("Device progress contains an invalid course record.");
	}
	const parsed = courses.filter((course): course is DeviceCourseProgress => course !== null);
	if (new Set(parsed.map((course) => course.courseId)).size !== parsed.length) {
		throw new DeviceProgressError("Device progress contains duplicate courses.");
	}
	return { version: 1, courses: parsed };
}

function emptySnapshot(): DeviceProgressSnapshot {
	return { version: 1, courses: [] };
}

function cloneCourse(course: DeviceCourseProgress): DeviceCourseProgress {
	return structuredClone(course);
}

export function createDeviceProgressStore(
	storage: BrowserStorage,
	dependencies: { now: () => string } = { now: () => new Date().toISOString() },
): DeviceProgressStore {
	function read(): DeviceProgressSnapshot {
		const serialized = storage.getItem(DEVICE_PROGRESS_STORAGE_KEY);
		if (serialized === null) return emptySnapshot();
		try {
			return parseSnapshot(serialized);
		} catch {
			return emptySnapshot();
		}
	}

	function write(snapshot: DeviceProgressSnapshot): void {
		storage.setItem(DEVICE_PROGRESS_STORAGE_KEY, JSON.stringify(snapshot));
	}

	function getOrCreate(snapshot: DeviceProgressSnapshot, courseId: string): DeviceCourseProgress {
		const existing = snapshot.courses.find((course) => course.courseId === courseId);
		if (existing) return existing;
		if (!validId(courseId)) throw new DeviceProgressError("courseId is invalid.");
		if (snapshot.courses.length >= MAX_COURSES) {
			throw new DeviceProgressError("Device progress reached its course limit.");
		}
		const created: DeviceCourseProgress = {
			courseId,
			completedLessonIds: [],
			selfChecks: [],
			updatedAt: dependencies.now(),
		};
		snapshot.courses.push(created);
		return created;
	}

	return {
		getCourse(courseId) {
			const course = read().courses.find((item) => item.courseId === courseId);
			return course ? cloneCourse(course) : null;
		},
		completeLesson(courseId, lessonId) {
			if (!validId(lessonId)) throw new DeviceProgressError("lessonId is invalid.");
			const snapshot = read();
			const course = getOrCreate(snapshot, courseId);
			if (!course.completedLessonIds.includes(lessonId)) {
				if (course.completedLessonIds.length >= MAX_LESSONS_PER_COURSE) {
					throw new DeviceProgressError("Device progress reached its lesson limit.");
				}
				course.completedLessonIds.push(lessonId);
				course.updatedAt = dependencies.now();
				write(snapshot);
			}
			return cloneCourse(course);
		},
		recordSelfCheck(courseId, result) {
			if (!validId(result.checkId) || !validId(result.revisionId)) {
				throw new DeviceProgressError("Knowledge Check identifiers are invalid.");
			}
			if (!Number.isInteger(result.score) || result.score < 0 || result.score > 100) {
				throw new DeviceProgressError("Knowledge Check score must be an integer from 0 to 100.");
			}
			if (typeof result.passed !== "boolean") {
				throw new DeviceProgressError("Knowledge Check passed status must be a boolean.");
			}
			const snapshot = read();
			const course = getOrCreate(snapshot, courseId);
			const existingIndex = course.selfChecks.findIndex(
				(check) => check.checkId === result.checkId,
			);
			const selfCheck: DeviceSelfCheck = {
				...result,
				completedAt: dependencies.now(),
			};
			if (existingIndex === -1) {
				if (course.selfChecks.length >= MAX_SELF_CHECKS_PER_COURSE) {
					throw new DeviceProgressError("Device progress reached its self-check limit.");
				}
				course.selfChecks.push(selfCheck);
			} else {
				course.selfChecks[existingIndex] = selfCheck;
			}
			course.updatedAt = dependencies.now();
			write(snapshot);
			return cloneCourse(course);
		},
		resetCourse(courseId) {
			const snapshot = read();
			snapshot.courses = snapshot.courses.filter((course) => course.courseId !== courseId);
			if (snapshot.courses.length === 0) {
				storage.removeItem(DEVICE_PROGRESS_STORAGE_KEY);
			} else {
				write(snapshot);
			}
		},
		resetAll() {
			storage.removeItem(DEVICE_PROGRESS_STORAGE_KEY);
		},
		exportSnapshot() {
			return JSON.stringify(read());
		},
		importSnapshot(serialized) {
			const incoming = parseSnapshot(serialized);
			const current = read();
			let importedLessons = 0;
			let importedSelfChecks = 0;
			for (const incomingCourse of incoming.courses) {
				const course = getOrCreate(current, incomingCourse.courseId);
				const mergedLessonCount = new Set([
					...course.completedLessonIds,
					...incomingCourse.completedLessonIds,
				]).size;
				if (mergedLessonCount > MAX_LESSONS_PER_COURSE) {
					throw new DeviceProgressError("Imported device progress exceeds the lesson limit.");
				}
				const mergedSelfCheckCount = new Set([
					...course.selfChecks.map((check) => check.checkId),
					...incomingCourse.selfChecks.map((check) => check.checkId),
				]).size;
				if (mergedSelfCheckCount > MAX_SELF_CHECKS_PER_COURSE) {
					throw new DeviceProgressError("Imported device progress exceeds the self-check limit.");
				}
				for (const lessonId of incomingCourse.completedLessonIds) {
					if (course.completedLessonIds.includes(lessonId)) continue;
					course.completedLessonIds.push(lessonId);
					importedLessons += 1;
				}
				for (const check of incomingCourse.selfChecks) {
					const index = course.selfChecks.findIndex(
						(existing) => existing.checkId === check.checkId,
					);
					if (index === -1) {
						course.selfChecks.push(structuredClone(check));
						importedSelfChecks += 1;
					} else if (course.selfChecks[index]!.completedAt < check.completedAt) {
						course.selfChecks[index] = structuredClone(check);
						importedSelfChecks += 1;
					}
				}
				course.updatedAt = dependencies.now();
			}
			if (incoming.courses.length > 0) write(current);
			return {
				importedCourses: incoming.courses.length,
				importedLessons,
				importedSelfChecks,
			};
		},
	};
}
