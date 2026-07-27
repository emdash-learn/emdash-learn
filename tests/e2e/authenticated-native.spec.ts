import { expect, test, type Page } from "@playwright/test";

const authenticatedJourneys = process.env["E2E_AUTHENTICATED"] === "1";
const secondaryToken = process.env["EMDASH_LEARN_E2E_SECONDARY_TOKEN"];
const CHECK_ID = "check_demo_publishing_basics";
const REVISION_ID = "revision_demo_publishing_basics_v1";
const SUBMISSION_ID = "790b7b8e-51d8-4e91-b63f-65a3948de63f";

interface RouteResult<T> {
	status: number;
	body: { data?: T; error?: { code: string; message: string } };
}

async function route<T>(
	page: Page,
	name: string,
	input: unknown,
	options: { token?: string } = {},
): Promise<RouteResult<T>> {
	const headers: Record<string, string> = { "X-EmDash-Request": "1" };
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	const response = await page.request.post(`/_emdash/api/plugins/lms-core/${name}`, {
		data: input,
		headers,
	});
	return {
		status: response.status(),
		// oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Playwright's JSON boundary is validated by the journey's contract assertions.
		body: (await response.json()) as RouteResult<T>["body"],
	};
}

async function browserClient<T>(
	page: Page,
	method: "eraseMyData" | "getCourseProgress" | "importDeviceProgress",
	arg?: string,
): Promise<T> {
	// oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- the browser transport result is validated by the caller's contract assertions.
	return page.evaluate(
		async ({ arg: clientArg, method: clientMethod }) => {
			// oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- the dev-only demo seam installs this exact client instance.
			const client = Reflect.get(window, "__emdashLearnDemoClient") as
				| import("../../src/browser/index.js").LearnBrowserClient
				| undefined;
			if (!client) throw new Error("Learn demo browser client is not ready.");
			if (clientMethod === "eraseMyData") return client.eraseMyData();
			if (clientMethod === "getCourseProgress") {
				return client.getCourseProgress(clientArg ?? "");
			}
			return client.importDeviceProgress(clientArg ?? "");
		},
		{ arg, method },
	) as Promise<T>;
}

function currentUtcRange(): { from: string; to: string } {
	const now = new Date();
	const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const to = new Date(from.valueOf() + 86_400_000);
	return { from: from.toISOString(), to: to.toISOString() };
}

test.describe("authenticated native EmDash host", () => {
	test.skip(!authenticatedJourneys, "Requires the EmDash 0.32 principal contract.");

	test("preserves account learning facts, isolation, reporting, setup, and erasure", async ({
		context,
		page,
	}) => {
		expect(secondaryToken).toMatch(/^ec_pat_/u);

		const locked = await route(page, "catalog", {});
		expect(locked.status).toBe(409);
		expect(locked.body.error?.code).toBe("LEARN_SETUP_INCOMPLETE");

		const coreSetupResponse = await page.request.get("/_emdash/api/setup/dev-bypass?token=1");
		expect(coreSetupResponse.status()).toBe(200);
		// oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- the token is checked before it is used.
		const coreSetup = (await coreSetupResponse.json()) as {
			data?: { token?: string };
		};
		const adminToken = coreSetup.data?.token;
		expect(adminToken).toMatch(/^ec_pat_/u);
		const setup = await route(page, "setup:run", {}, { token: adminToken });
		expect(setup.status).toBe(200);
		expect(setup.body.data).toMatchObject({
			state: {
				verification: {
					contractVersion: expect.any(Number),
					schema: "compatible",
					projection: "repaired",
				},
			},
		});

		const courses = await route<{
			items: Array<{ id: string; slug: string }>;
		}>(page, "catalog", {}, { token: adminToken });
		expect(courses.status).toBe(200);
		const course = courses.body.data?.items.find(
			(item) => item.slug === "course-publishing-essentials",
		);
		expect(course).toBeDefined();
		const courseId = course?.id ?? "";

		const detail = await route<{
			lessons: Array<{ id: string; order: number }>;
		}>(page, "course:get", { courseId });
		expect(detail.status).toBe(200);
		const lessons = detail.body.data?.lessons ?? [];
		expect(lessons).toHaveLength(2);
		const [firstLesson, secondLesson] = lessons;
		expect(firstLesson).toBeDefined();
		expect(secondLesson).toBeDefined();

		await context.clearCookies();
		await page.goto(`/courses/course-publishing-essentials/lessons/${firstLesson?.id ?? ""}`);
		await page.getByRole("button", { name: "Mark lesson complete" }).click();
		await expect(page.getByTestId("device-progress")).toContainText("Completed on this device.");

		await page.goto(`/courses/course-publishing-essentials/lessons/${secondLesson?.id ?? ""}`);
		const check = page.getByTestId("knowledge-check");
		await check.getByLabel("Published courses").check();
		await check.getByLabel("False").check();
		await check.getByTestId("check-submit").click();
		await expect(check.getByTestId("check-result")).toContainText("100% — Passed");

		await page.goto(
			`/_emdash/api/auth/dev-bypass?redirect=/courses/course-publishing-essentials/lessons/${firstLesson?.id ?? ""}`,
		);
		await page.waitForURL(/\/courses\/course-publishing-essentials\/lessons\//u);
		await page.waitForLoadState("networkidle");
		await expect
			.poll(() => page.evaluate(() => Reflect.has(window, "__emdashLearnDemoClient")))
			.toBe(true);

		const imported = await browserClient<{
			importedLessons: number;
			importedLessonIds: string[];
			progress: { completedLessons: number; totalLessons: number };
		}>(page, "importDeviceProgress", courseId);
		expect(imported).toMatchObject({
			importedLessons: 1,
			importedLessonIds: [firstLesson?.id],
			progress: { completedLessons: 1, totalLessons: 2 },
		});
		const noImportedAnonymousAttempt = await route<{ items: unknown[] }>(
			page,
			"assessment:attempts",
			{},
		);
		expect(noImportedAnonymousAttempt.body.data?.items).toEqual([]);

		await page.reload();
		await expect(browserClient(page, "getCourseProgress", courseId)).resolves.toMatchObject({
			completedLessons: 1,
			totalLessons: 2,
			percentComplete: 50,
		});

		const completed = await route<{
			newlyCompleted: boolean;
			progress: { completedLessons: number; totalLessons: number; percentComplete: number };
		}>(page, "learning:complete-lesson", {
			lessonId: secondLesson?.id,
			operationId: "d1084642-077e-482e-989d-5f4042d49182",
		});
		expect(completed.body.data).toMatchObject({
			newlyCompleted: true,
			progress: { completedLessons: 2, totalLessons: 2, percentComplete: 100 },
		});

		const correctAnswers = [
			{ questionId: "public-boundary", answer: "published" },
			{ questionId: "device-result", answer: false },
		];
		const attemptInput = {
			courseId,
			checkId: CHECK_ID,
			revisionId: REVISION_ID,
			submissionId: SUBMISSION_ID,
			answers: correctAnswers,
		};
		const firstAttempt = await route<{ newlyRecorded: boolean; attemptId: string }>(
			page,
			"assessment:submit-attempt",
			attemptInput,
		);
		const retriedAttempt = await route<{ newlyRecorded: boolean; attemptId: string }>(
			page,
			"assessment:submit-attempt",
			attemptInput,
		);
		expect(firstAttempt.status).toBe(200);
		expect(firstAttempt.body.data).toMatchObject({ newlyRecorded: true });
		expect(retriedAttempt.body.data).toEqual({
			...firstAttempt.body.data,
			newlyRecorded: false,
		});

		const conflict = await route(page, "assessment:submit-attempt", {
			...attemptInput,
			answers: [
				{ questionId: "public-boundary", answer: "draft" },
				{ questionId: "device-result", answer: true },
			],
		});
		expect(conflict.status).toBe(409);
		expect(conflict.body.error?.code).toBe("LEARN_ASSESSMENT_SUBMISSION_CONFLICT");

		const isolatedProgress = await route(
			page,
			"learning:progress",
			{ courseId },
			{ token: secondaryToken },
		);
		expect(isolatedProgress.body.data).toMatchObject({
			completedLessons: 0,
			totalLessons: 2,
		});
		const isolatedAttempts = await route<{ items: unknown[] }>(
			page,
			"assessment:attempts",
			{},
			{ token: secondaryToken },
		);
		expect(isolatedAttempts.body.data?.items).toEqual([]);

		const range = currentUtcRange();
		const beforeErasure = await route<{
			courses: Array<{
				verifiedAccountDays: number;
				lessonCompletions: { total: number; anonymous: number; verified: number };
				checkSubmissions: { total: number; anonymous: number; verified: number };
				scoreBands?: Array<{
					count: { total: number; anonymous: number; verified: number };
				}>;
			}>;
		}>(page, "reporting:query", { ...range, courseId });
		const beforeCourse = beforeErasure.body.data?.courses[0];
		expect(beforeCourse?.verifiedAccountDays).toBe(1);
		expect(beforeCourse?.lessonCompletions.verified).toBe(2);
		expect(beforeCourse?.checkSubmissions.anonymous).toBeGreaterThanOrEqual(1);
		expect(beforeCourse?.checkSubmissions.verified).toBe(1);
		for (const count of [
			beforeCourse?.lessonCompletions,
			beforeCourse?.checkSubmissions,
			...(beforeCourse?.scoreBands?.map((band) => band.count) ?? []),
		]) {
			expect(count?.total).toBe((count?.anonymous ?? 0) + (count?.verified ?? 0));
		}

		const erased = await browserClient<{
			deleted: {
				lessonCompletions: number;
				assessmentAttempts: number;
				rawEngagementObservations: number;
			};
		}>(page, "eraseMyData");
		expect(erased.deleted).toMatchObject({
			lessonCompletions: 2,
			assessmentAttempts: 1,
		});
		expect(erased.deleted.rawEngagementObservations).toBeGreaterThanOrEqual(3);

		await expect(browserClient(page, "getCourseProgress", courseId)).resolves.toMatchObject({
			completedLessons: 0,
			totalLessons: 2,
			percentComplete: 0,
		});
		const attemptsAfterErasure = await route<{ items: unknown[] }>(page, "assessment:attempts", {});
		expect(attemptsAfterErasure.body.data?.items).toEqual([]);

		const afterErasure = await route<{
			courses: Array<{
				verifiedAccountDays: number;
				lessonCompletions: { verified: number };
				checkSubmissions: { anonymous: number; verified: number };
			}>;
		}>(page, "reporting:query", { ...range, courseId });
		expect(afterErasure.body.data?.courses[0]).toMatchObject({
			verifiedAccountDays: 0,
			lessonCompletions: { verified: 0 },
			checkSubmissions: {
				anonymous: beforeCourse?.checkSubmissions.anonymous,
				verified: 0,
			},
		});
	});
});
