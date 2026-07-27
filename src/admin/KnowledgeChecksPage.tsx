import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type CSSProperties,
	type ReactElement,
	type ReactNode,
} from "react";

import {
	LmsApiError,
	createApiClient,
	type ApiClient,
	type ChoiceOption,
	type DraftCheck,
	type DraftCheckInput,
	type DraftQuestion,
	type PublishedCheckPresentation,
} from "./api-client.js";

const ADMIN_PATH = "/_emdash/admin/plugins/lms-core/checks";

type AssessmentApi = ApiClient["assessment"];
type CourseCatalogApi = ApiClient["courses"];
type QuestionType = DraftQuestion["type"];
type BusyAction = "save" | "publish" | "archive" | "delete" | null;

interface CourseOption {
	id: string;
	title: string;
}

interface QuestionCommon {
	id: string;
	prompt: string;
	points: number;
	explanation?: string;
}

export function checkEditorHref(checkId: string): string {
	return `${ADMIN_PATH}?check=${encodeURIComponent(checkId)}`;
}

export function parseSelectedCheckId(search: string): string | null {
	const value = new URLSearchParams(search).get("check");
	return value && value.trim().length > 0 ? value : null;
}

function nextId(prefix: string): string {
	return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function choiceOptions(): ChoiceOption[] {
	return [
		{ id: nextId("option"), text: "Answer one" },
		{ id: nextId("option"), text: "Answer two" },
	];
}

function questionForType(type: QuestionType, source?: QuestionCommon): DraftQuestion {
	const base: QuestionCommon = source ?? {
		id: nextId("question"),
		prompt: "What should a reader understand?",
		points: 1,
	};

	switch (type) {
		case "single_choice": {
			const options = choiceOptions();
			return { ...base, type, options, correctOptionId: options[0]!.id };
		}
		case "multiple_choice": {
			const options = choiceOptions();
			return { ...base, type, options, correctOptionIds: [options[0]!.id] };
		}
		case "true_false":
			return { ...base, type, correctAnswer: true };
		case "short_text":
			return { ...base, type, acceptedAnswers: [""] };
		default:
			return assertNever(type);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unsupported question type: ${String(value)}`);
}

function defaultQuestion(): DraftQuestion {
	return questionForType("single_choice");
}

export function emptyKnowledgeCheck(): DraftCheckInput {
	return {
		courseId: "",
		title: "Untitled knowledge check",
		description: "",
		passingScore: 70,
		questions: [defaultQuestion()],
	};
}

export function validateKnowledgeCheck(check: DraftCheckInput): string[] {
	const errors: string[] = [];
	if (check.courseId.trim().length === 0) errors.push("Select a course.");
	if (check.courseId.length > 200) errors.push("Course ID must be 200 characters or fewer.");
	if (check.title.trim().length === 0) errors.push("Add a title.");
	if (!Number.isInteger(check.passingScore) || check.passingScore < 0 || check.passingScore > 100) {
		errors.push("Passing score must be a whole number from 0 to 100.");
	}
	if (check.questions.length === 0) errors.push("Add at least one question.");

	check.questions.forEach((question, index) => {
		const label = `Question ${index + 1}`;
		if (question.prompt.trim().length === 0) errors.push(`${label} needs a prompt.`);
		if (!Number.isInteger(question.points) || question.points < 1) {
			errors.push(`${label} points must be a positive whole number.`);
		}

		switch (question.type) {
			case "single_choice": {
				const nonEmptyOptions = question.options.filter((option) => option.text.trim().length > 0);
				if (question.options.length < 2 || nonEmptyOptions.length !== question.options.length) {
					errors.push(`${label} needs at least two non-empty answers.`);
				}
				if (!nonEmptyOptions.some((option) => option.id === question.correctOptionId)) {
					errors.push(`${label} must have exactly one correct answer.`);
				}
				break;
			}
			case "multiple_choice": {
				const nonEmptyOptions = question.options.filter((option) => option.text.trim().length > 0);
				if (question.options.length < 2 || nonEmptyOptions.length !== question.options.length) {
					errors.push(`${label} needs at least two non-empty answers.`);
				}
				if (
					question.correctOptionIds.length === 0 ||
					question.correctOptionIds.some(
						(id) => !nonEmptyOptions.some((option) => option.id === id),
					)
				) {
					errors.push(`${label} needs at least one correct answer.`);
				}
				break;
			}
			case "true_false":
				if (typeof question.correctAnswer !== "boolean") {
					errors.push(`${label} must have one correct True/False answer.`);
				}
				break;
			case "short_text":
				if (
					question.acceptedAnswers.length === 0 ||
					question.acceptedAnswers.some((answer) => answer.trim().length === 0)
				) {
					errors.push(`${label} needs at least one accepted answer.`);
				}
				break;
		}
	});

	return errors;
}

type AssessmentDraftWriter = Pick<AssessmentApi, "createDraft" | "updateDraft">;

export function saveAssessmentDraft(
	api: AssessmentDraftWriter,
	checkId: string | null,
	draft: DraftCheckInput,
): Promise<DraftCheck> {
	return checkId === null ? api.createDraft(draft) : api.updateDraft(checkId, draft);
}

type AssessmentPublisher = Pick<AssessmentApi, "updateDraft" | "publish">;

export async function publishAssessmentDraft(
	api: AssessmentPublisher,
	checkId: string,
	draft: DraftCheckInput,
): Promise<{ draft: DraftCheck; published: PublishedCheckPresentation }> {
	const savedDraft = await api.updateDraft(checkId, draft);
	const published = await api.publish(checkId);
	return { draft: savedDraft, published };
}

function toDraftInput(draft: DraftCheck): DraftCheckInput {
	return {
		courseId: draft.courseId,
		title: draft.title,
		...(draft.description === undefined ? {} : { description: draft.description }),
		passingScore: draft.passingScore,
		questions: draft.questions,
	};
}

function formatError(error: unknown): string {
	if (error instanceof LmsApiError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}

export interface KnowledgeChecksPageProps {
	api?: Pick<ApiClient, "assessment"> & Partial<Pick<ApiClient, "courses">>;
	search?: string;
}

export function KnowledgeChecksPage({
	api: providedApi,
	search,
}: KnowledgeChecksPageProps = {}): ReactElement {
	const fallbackApi = useMemo(() => createApiClient(), []);
	const assessment = providedApi?.assessment ?? fallbackApi.assessment;
	const courses = providedApi?.courses ?? fallbackApi.courses;
	const selectedId = parseSelectedCheckId(
		search ?? (typeof window === "undefined" ? "" : window.location.search),
	);

	return selectedId === null ? (
		<KnowledgeCheckList api={assessment} />
	) : (
		<KnowledgeCheckEditor api={assessment} courses={courses} checkId={selectedId} />
	);
}

function KnowledgeCheckList({ api }: { api: AssessmentApi }): ReactElement {
	const [items, setItems] = useState<DraftCheck[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await api.listDrafts();
			setItems(result.items);
		} catch (cause) {
			setError(formatError(cause));
		} finally {
			setLoading(false);
		}
	}, [api]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<section style={pageStyle}>
			<header style={headerRowStyle}>
				<div>
					<h1 style={titleStyle}>Knowledge checks</h1>
					<p style={subtitleStyle}>
						Author drafts here. Publishing creates an immutable revision for visitors.
					</p>
				</div>
				<a href={checkEditorHref("new")} style={primaryLinkStyle}>
					New check
				</a>
			</header>

			{error ? (
				<Message tone="error">
					<p style={messageParagraphStyle}>{error}</p>
					<button type="button" onClick={() => void load()} style={textButtonStyle}>
						Retry
					</button>
				</Message>
			) : null}
			{loading ? (
				<Message>Loading drafts…</Message>
			) : items.length === 0 ? (
				<div style={emptyStyle}>
					<h2 style={{ marginBlockStart: 0 }}>No knowledge-check drafts yet</h2>
					<p>Create a draft, then publish its first immutable revision.</p>
					<a href={checkEditorHref("new")} style={primaryLinkStyle}>
						Create the first draft
					</a>
				</div>
			) : (
				<div style={listStyle}>
					{items.map((item) => (
						<a key={item.checkId} href={checkEditorHref(item.checkId)} style={listItemStyle}>
							<span>
								<strong>{item.title}</strong>
								<span style={itemMetaStyle}>
									{item.questions.length} question
									{item.questions.length === 1 ? "" : "s"} · Pass at {item.passingScore}%
								</span>
							</span>
							<span style={draftBadgeStyle}>Draft</span>
						</a>
					))}
				</div>
			)}
		</section>
	);
}

function KnowledgeCheckEditor({
	api,
	courses,
	checkId,
}: {
	api: AssessmentApi;
	courses: CourseCatalogApi;
	checkId: string;
}): ReactElement {
	const isNew = checkId === "new";
	const [draft, setDraft] = useState<DraftCheckInput | null>(() =>
		isNew ? emptyKnowledgeCheck() : null,
	);
	const [loading, setLoading] = useState(!isNew);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [busyAction, setBusyAction] = useState<BusyAction>(null);
	const [courseOptions, setCourseOptions] = useState<CourseOption[]>([]);
	const [coursesLoading, setCoursesLoading] = useState(true);
	const [coursesError, setCoursesError] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (isNew) {
			setDraft(emptyKnowledgeCheck());
			setLoading(false);
			setLoadError(null);
			return;
		}

		setLoading(true);
		setLoadError(null);
		try {
			setDraft(toDraftInput(await api.getDraft(checkId)));
		} catch (cause) {
			setDraft(null);
			setLoadError(formatError(cause));
		} finally {
			setLoading(false);
		}
	}, [api, checkId, isNew]);

	useEffect(() => {
		void load();
	}, [load]);

	const loadCourseOptions = useCallback(async () => {
		setCoursesLoading(true);
		setCoursesError(null);
		try {
			const items: CourseOption[] = [];
			let cursor: string | undefined;
			let pagesRead = 0;
			/* oxlint-disable no-await-in-loop -- the catalog cursor makes pagination sequential */
			do {
				pagesRead += 1;
				const page = await courses.listPublished({
					limit: 100,
					...(cursor === undefined ? {} : { cursor }),
				});
				items.push(...page.items.map(({ id, title }) => ({ id, title })));
				if (page.hasMore && !page.cursor) {
					throw new Error("Course pagination could not continue.");
				}
				if (page.hasMore && pagesRead >= 100) {
					throw new Error("Course selection is limited to 10,000 published courses.");
				}
				cursor = page.hasMore ? page.cursor : undefined;
			} while (cursor);
			/* oxlint-enable no-await-in-loop */
			setCourseOptions(items);
		} catch (cause) {
			setCourseOptions([]);
			setCoursesError(formatError(cause));
		} finally {
			setCoursesLoading(false);
		}
	}, [courses]);

	useEffect(() => {
		void loadCourseOptions();
	}, [loadCourseOptions]);

	function isValid(current: DraftCheckInput): boolean {
		const nextErrors = validateKnowledgeCheck(current);
		setErrors(nextErrors);
		setNotice(null);
		return nextErrors.length === 0;
	}

	async function save(): Promise<void> {
		if (!draft || !isValid(draft)) return;
		setBusyAction("save");
		try {
			const saved = await saveAssessmentDraft(api, isNew ? null : checkId, draft);
			if (isNew) {
				window.location.assign(checkEditorHref(saved.checkId));
				return;
			}
			setDraft(toDraftInput(saved));
			setNotice("Draft saved.");
		} catch (cause) {
			setErrors([formatError(cause)]);
		} finally {
			setBusyAction(null);
		}
	}

	async function publish(): Promise<void> {
		if (isNew || !draft || !isValid(draft)) return;
		setBusyAction("publish");
		try {
			const result = await publishAssessmentDraft(api, checkId, draft);
			setDraft(toDraftInput(result.draft));
			setNotice(`Published immutable revision ${result.published.revisionId}.`);
		} catch (cause) {
			setErrors([formatError(cause)]);
		} finally {
			setBusyAction(null);
		}
	}

	async function archive(): Promise<void> {
		if (isNew) return;
		setErrors([]);
		setNotice(null);
		setBusyAction("archive");
		try {
			const result = await api.archive(checkId);
			setNotice(
				result.archived
					? "Archived the published revision. The draft is still available."
					: "This check did not have an active published revision.",
			);
		} catch (cause) {
			setErrors([formatError(cause)]);
		} finally {
			setBusyAction(null);
		}
	}

	async function remove(): Promise<void> {
		if (
			isNew ||
			!window.confirm(
				"Delete this draft? Published revisions are managed separately and this cannot be undone.",
			)
		) {
			return;
		}
		setErrors([]);
		setNotice(null);
		setBusyAction("delete");
		try {
			await api.deleteDraft(checkId);
			window.location.assign(ADMIN_PATH);
		} catch (cause) {
			setErrors([formatError(cause)]);
			setBusyAction(null);
		}
	}

	if (loading) {
		return (
			<section style={pageStyle}>
				<Message>Loading draft…</Message>
			</section>
		);
	}

	if (!draft) {
		return (
			<section style={pageStyle}>
				<a href={ADMIN_PATH} style={backLinkStyle}>
					← All drafts
				</a>
				<Message tone="error">
					<p style={messageParagraphStyle}>{loadError ?? "Draft not found."}</p>
					<button type="button" onClick={() => void load()} style={textButtonStyle}>
						Retry
					</button>
				</Message>
			</section>
		);
	}

	return (
		<KnowledgeCheckEditorView
			checkId={isNew ? null : checkId}
			draft={draft}
			errors={errors}
			notice={notice}
			busyAction={busyAction}
			courseOptions={courseOptions}
			coursesLoading={coursesLoading}
			coursesError={coursesError}
			onDraftChange={setDraft}
			onSave={() => void save()}
			onPublish={() => void publish()}
			onArchive={() => void archive()}
			onDelete={() => void remove()}
		/>
	);
}

export interface KnowledgeCheckEditorViewProps {
	checkId: string | null;
	draft: DraftCheckInput;
	errors: string[];
	notice: string | null;
	busyAction: BusyAction;
	courseOptions?: CourseOption[];
	coursesLoading?: boolean;
	coursesError?: string | null;
	onDraftChange: (draft: DraftCheckInput) => void;
	onSave: () => void;
	onPublish: () => void;
	onArchive: () => void;
	onDelete: () => void;
}

export function KnowledgeCheckEditorView({
	checkId,
	draft,
	errors,
	notice,
	busyAction,
	courseOptions = [],
	coursesLoading = false,
	coursesError = null,
	onDraftChange,
	onSave,
	onPublish,
	onArchive,
	onDelete,
}: KnowledgeCheckEditorViewProps): ReactElement {
	const isNew = checkId === null;
	const disabled = busyAction !== null;
	const selectedCourseIsUnavailable =
		draft.courseId.length > 0 && !courseOptions.some((course) => course.id === draft.courseId);

	function replaceQuestion(index: number, replacement: DraftQuestion): void {
		onDraftChange({
			...draft,
			questions: draft.questions.map((question, questionIndex) =>
				questionIndex === index ? replacement : question,
			),
		});
	}

	function updateQuestionCommon(index: number, update: Partial<Omit<QuestionCommon, "id">>): void {
		const question = draft.questions[index];
		if (!question) return;
		replaceQuestion(index, { ...question, ...update });
	}

	function changeQuestionType(index: number, type: QuestionType): void {
		const question = draft.questions[index];
		if (!question) return;
		replaceQuestion(
			index,
			questionForType(type, {
				id: question.id,
				prompt: question.prompt,
				points: question.points,
				...(question.explanation === undefined ? {} : { explanation: question.explanation }),
			}),
		);
	}

	function updateChoice(index: number, optionIndex: number, text: string): void {
		const question = draft.questions[index];
		if (!question || (question.type !== "single_choice" && question.type !== "multiple_choice")) {
			return;
		}
		const options = question.options.map((option, currentIndex) =>
			currentIndex === optionIndex ? { ...option, text } : option,
		);
		replaceQuestion(index, { ...question, options });
	}

	function markChoice(index: number, optionId: string, checked: boolean): void {
		const question = draft.questions[index];
		if (!question) return;
		if (question.type === "single_choice") {
			replaceQuestion(index, { ...question, correctOptionId: optionId });
		}
		if (question.type === "multiple_choice") {
			const selected = new Set(question.correctOptionIds);
			if (checked) selected.add(optionId);
			else selected.delete(optionId);
			replaceQuestion(index, {
				...question,
				correctOptionIds: [...selected],
			});
		}
	}

	function addChoice(index: number): void {
		const question = draft.questions[index];
		if (!question || (question.type !== "single_choice" && question.type !== "multiple_choice")) {
			return;
		}
		replaceQuestion(index, {
			...question,
			options: [...question.options, { id: nextId("option"), text: "" }],
		});
	}

	function removeChoice(index: number, optionIndex: number): void {
		const question = draft.questions[index];
		if (
			!question ||
			(question.type !== "single_choice" && question.type !== "multiple_choice") ||
			question.options.length <= 2
		) {
			return;
		}
		const removed = question.options[optionIndex];
		if (!removed) return;
		const options = question.options.filter((_, currentIndex) => currentIndex !== optionIndex);
		if (question.type === "single_choice") {
			replaceQuestion(index, {
				...question,
				options,
				correctOptionId:
					question.correctOptionId === removed.id
						? (options[0]?.id ?? "")
						: question.correctOptionId,
			});
		} else {
			replaceQuestion(index, {
				...question,
				options,
				correctOptionIds: question.correctOptionIds.filter((id) => id !== removed.id),
			});
		}
	}

	function updateAcceptedAnswer(index: number, answerIndex: number, text: string): void {
		const question = draft.questions[index];
		if (!question || question.type !== "short_text") return;
		replaceQuestion(index, {
			...question,
			acceptedAnswers: question.acceptedAnswers.map((answer, currentIndex) =>
				currentIndex === answerIndex ? text : answer,
			),
		});
	}

	function removeAcceptedAnswer(index: number, answerIndex: number): void {
		const question = draft.questions[index];
		if (!question || question.type !== "short_text" || question.acceptedAnswers.length <= 1) {
			return;
		}
		replaceQuestion(index, {
			...question,
			acceptedAnswers: question.acceptedAnswers.filter(
				(_, currentIndex) => currentIndex !== answerIndex,
			),
		});
	}

	return (
		<section style={pageStyle}>
			<a href={ADMIN_PATH} style={backLinkStyle}>
				← All drafts
			</a>
			<header style={headerRowStyle}>
				<div>
					<h1 style={titleStyle}>{isNew ? "New knowledge check" : "Edit knowledge check"}</h1>
					<p style={subtitleStyle}>
						{isNew
							? "Create the draft first, then publish an immutable revision."
							: "Publishing saves this draft and creates a new immutable revision."}
					</p>
				</div>
				<div style={actionsStyle}>
					{!isNew ? (
						<>
							<button
								type="button"
								onClick={onArchive}
								disabled={disabled}
								style={secondaryButtonStyle}
							>
								{busyAction === "archive" ? "Archiving…" : "Archive published revision"}
							</button>
							<button
								type="button"
								onClick={onDelete}
								disabled={disabled}
								style={dangerButtonStyle}
							>
								{busyAction === "delete" ? "Deleting…" : "Delete draft"}
							</button>
						</>
					) : null}
					<button type="button" onClick={onSave} disabled={disabled} style={secondaryButtonStyle}>
						{busyAction === "save" ? "Saving…" : isNew ? "Create draft" : "Save draft"}
					</button>
					{!isNew ? (
						<button
							type="button"
							onClick={onPublish}
							disabled={disabled}
							style={primaryButtonStyle}
						>
							{busyAction === "publish" ? "Publishing…" : "Publish revision"}
						</button>
					) : null}
				</div>
			</header>

			{errors.length > 0 ? (
				<Message tone="error">
					<ul style={{ margin: 0, paddingInlineStart: "1.25rem" }}>
						{errors.map((error) => (
							<li key={error}>{error}</li>
						))}
					</ul>
				</Message>
			) : null}
			{notice ? <Message tone="success">{notice}</Message> : null}

			<div style={formGridStyle}>
				<label style={{ ...fieldStyle, gridColumn: "span 2" }}>
					<span style={labelStyle}>Course</span>
					<select
						value={draft.courseId}
						required
						onChange={(event) => onDraftChange({ ...draft, courseId: event.currentTarget.value })}
						style={inputStyle}
						aria-describedby="course-id-help"
						disabled={coursesLoading}
					>
						<option value="">
							{coursesLoading ? "Loading published courses…" : "Select a published course"}
						</option>
						{selectedCourseIsUnavailable ? (
							<option value={draft.courseId}>{draft.courseId} (currently unavailable)</option>
						) : null}
						{courseOptions.map((course) => (
							<option key={course.id} value={course.id}>
								{course.title} — {course.id}
							</option>
						))}
					</select>
					<small id="course-id-help" style={helpStyle}>
						{coursesError
							? `Published courses could not be loaded: ${coursesError}`
							: selectedCourseIsUnavailable
								? "This saved course is not currently published. Reassign it before publishing the check."
								: "The immutable revision can only be presented inside the selected course."}
					</small>
				</label>
				<label style={{ ...fieldStyle, gridColumn: "span 2" }}>
					<span style={labelStyle}>Title</span>
					<input
						value={draft.title}
						onChange={(event) => onDraftChange({ ...draft, title: event.currentTarget.value })}
						style={inputStyle}
					/>
				</label>
				<label style={fieldStyle}>
					<span style={labelStyle}>Passing score (%)</span>
					<input
						type="number"
						min={0}
						max={100}
						step={1}
						value={draft.passingScore}
						onChange={(event) =>
							onDraftChange({
								...draft,
								passingScore: Number(event.currentTarget.value),
							})
						}
						style={inputStyle}
					/>
				</label>
				<label style={{ ...fieldStyle, gridColumn: "1 / -1" }}>
					<span style={labelStyle}>Description</span>
					<textarea
						value={draft.description ?? ""}
						onChange={(event) =>
							onDraftChange({ ...draft, description: event.currentTarget.value })
						}
						rows={3}
						style={inputStyle}
					/>
				</label>
			</div>

			<div style={sectionHeaderStyle}>
				<h2 style={{ margin: 0, fontSize: "1.2rem" }}>Questions</h2>
				<button
					type="button"
					onClick={() =>
						onDraftChange({
							...draft,
							questions: [...draft.questions, defaultQuestion()],
						})
					}
					style={secondaryButtonStyle}
				>
					Add question
				</button>
			</div>

			<div style={questionsStyle}>
				{draft.questions.map((question, questionIndex) => (
					<article key={question.id} style={questionStyle}>
						<div style={questionHeadingStyle}>
							<strong>Question {questionIndex + 1}</strong>
							<button
								type="button"
								onClick={() =>
									onDraftChange({
										...draft,
										questions: draft.questions.filter(
											(_, currentIndex) => currentIndex !== questionIndex,
										),
									})
								}
								style={textButtonStyle}
							>
								Remove question
							</button>
						</div>

						<div style={questionGridStyle}>
							<label style={{ ...fieldStyle, gridColumn: "1 / -1" }}>
								<span style={labelStyle}>Prompt</span>
								<input
									value={question.prompt}
									onChange={(event) =>
										updateQuestionCommon(questionIndex, {
											prompt: event.currentTarget.value,
										})
									}
									style={inputStyle}
								/>
							</label>
							<label style={fieldStyle}>
								<span style={labelStyle}>Type</span>
								<select
									value={question.type}
									onChange={(event) => {
										const type = event.currentTarget.value;
										if (
											type === "single_choice" ||
											type === "multiple_choice" ||
											type === "true_false" ||
											type === "short_text"
										) {
											changeQuestionType(questionIndex, type);
										}
									}}
									style={inputStyle}
								>
									<option value="single_choice">One answer</option>
									<option value="multiple_choice">Multiple answers</option>
									<option value="true_false">True / false</option>
									<option value="short_text">Short text</option>
								</select>
							</label>
							<label style={fieldStyle}>
								<span style={labelStyle}>Points</span>
								<input
									type="number"
									min={1}
									step={1}
									value={question.points}
									onChange={(event) =>
										updateQuestionCommon(questionIndex, {
											points: Number(event.currentTarget.value),
										})
									}
									style={inputStyle}
								/>
							</label>
						</div>

						{question.type === "single_choice" || question.type === "multiple_choice" ? (
							<div style={answersStyle}>
								<span style={labelStyle}>Answers</span>
								{question.options.map((option, optionIndex) => (
									<div key={option.id} style={answerRowStyle}>
										<input
											type={question.type === "multiple_choice" ? "checkbox" : "radio"}
											name={`correct-${question.id}`}
											checked={
												question.type === "single_choice"
													? question.correctOptionId === option.id
													: question.correctOptionIds.includes(option.id)
											}
											onChange={(event) =>
												markChoice(questionIndex, option.id, event.currentTarget.checked)
											}
											aria-label={`Mark answer ${optionIndex + 1} correct`}
										/>
										<input
											value={option.text}
											onChange={(event) =>
												updateChoice(questionIndex, optionIndex, event.currentTarget.value)
											}
											style={inputStyle}
											aria-label={`Answer ${optionIndex + 1}`}
										/>
										{question.options.length > 2 ? (
											<button
												type="button"
												onClick={() => removeChoice(questionIndex, optionIndex)}
												style={textButtonStyle}
											>
												Remove
											</button>
										) : null}
									</div>
								))}
								<button
									type="button"
									onClick={() => addChoice(questionIndex)}
									style={textButtonStyle}
								>
									Add answer
								</button>
							</div>
						) : null}

						{question.type === "true_false" ? (
							<fieldset style={answersFieldsetStyle}>
								<legend style={labelStyle}>Correct answer</legend>
								<label style={inlineChoiceStyle}>
									<input
										type="radio"
										name={`true-false-${question.id}`}
										checked={question.correctAnswer}
										onChange={() =>
											replaceQuestion(questionIndex, {
												...question,
												correctAnswer: true,
											})
										}
									/>
									True
								</label>
								<label style={inlineChoiceStyle}>
									<input
										type="radio"
										name={`true-false-${question.id}`}
										checked={!question.correctAnswer}
										onChange={() =>
											replaceQuestion(questionIndex, {
												...question,
												correctAnswer: false,
											})
										}
									/>
									False
								</label>
							</fieldset>
						) : null}

						{question.type === "short_text" ? (
							<div style={answersStyle}>
								<span style={labelStyle}>Accepted answers</span>
								{question.acceptedAnswers.map((answer, answerIndex) => (
									// oxlint-disable-next-line react/no-array-index-key -- canonical accepted answers are scalar strings without ids
									<div key={`${question.id}-${answerIndex}`} style={answerRowStyle}>
										<span aria-hidden="true">✓</span>
										<input
											value={answer}
											onChange={(event) =>
												updateAcceptedAnswer(questionIndex, answerIndex, event.currentTarget.value)
											}
											style={inputStyle}
											aria-label={`Accepted answer ${answerIndex + 1}`}
										/>
										{question.acceptedAnswers.length > 1 ? (
											<button
												type="button"
												onClick={() => removeAcceptedAnswer(questionIndex, answerIndex)}
												style={textButtonStyle}
											>
												Remove
											</button>
										) : null}
									</div>
								))}
								<button
									type="button"
									onClick={() =>
										replaceQuestion(questionIndex, {
											...question,
											acceptedAnswers: [...question.acceptedAnswers, ""],
										})
									}
									style={textButtonStyle}
								>
									Add accepted answer
								</button>
							</div>
						) : null}

						<label style={fieldStyle}>
							<span style={labelStyle}>Explanation shown after grading (optional)</span>
							<textarea
								value={question.explanation ?? ""}
								onChange={(event) =>
									updateQuestionCommon(questionIndex, {
										explanation: event.currentTarget.value,
									})
								}
								rows={2}
								style={inputStyle}
							/>
						</label>
					</article>
				))}
			</div>
		</section>
	);
}

function Message({
	children,
	tone = "neutral",
}: {
	children: ReactNode;
	tone?: "neutral" | "error" | "success";
}): ReactElement {
	const colors = {
		neutral: { background: "#f8fafc", border: "#cbd5e1", color: "#475569" },
		error: { background: "#fef2f2", border: "#fecaca", color: "#991b1b" },
		success: { background: "#f0fdf4", border: "#bbf7d0", color: "#166534" },
	}[tone];
	return <div style={{ ...messageStyle, ...colors }}>{children}</div>;
}

const pageStyle: CSSProperties = {
	maxWidth: "72rem",
	marginInline: "auto",
	padding: "2rem",
	color: "#0f172a",
};
const headerRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "flex-start",
	justifyContent: "space-between",
	gap: "1rem",
	marginBlockEnd: "1.5rem",
	flexWrap: "wrap",
};
const titleStyle: CSSProperties = { margin: 0, fontSize: "1.75rem" };
const subtitleStyle: CSSProperties = {
	marginBlock: "0.4rem 0",
	color: "#64748b",
	lineHeight: 1.5,
};
const primaryLinkStyle: CSSProperties = {
	display: "inline-block",
	padding: "0.65rem 0.9rem",
	borderRadius: "0.45rem",
	background: "#4338ca",
	color: "#fff",
	fontWeight: 650,
	textDecoration: "none",
	whiteSpace: "nowrap",
};
const listStyle: CSSProperties = { display: "grid", gap: "0.65rem" };
const listItemStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "1rem",
	padding: "1rem 1.1rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.65rem",
	color: "#0f172a",
	textDecoration: "none",
};
const itemMetaStyle: CSSProperties = {
	display: "block",
	marginBlockStart: "0.25rem",
	color: "#64748b",
	fontSize: "0.8rem",
};
const draftBadgeStyle: CSSProperties = {
	padding: "0.2rem 0.5rem",
	borderRadius: "999px",
	background: "#f1f5f9",
	color: "#475569",
	fontSize: "0.72rem",
	fontWeight: 700,
	textTransform: "uppercase",
};
const emptyStyle: CSSProperties = {
	padding: "2rem",
	border: "1px dashed #cbd5e1",
	borderRadius: "0.75rem",
	textAlign: "center",
	color: "#475569",
};
const messageStyle: CSSProperties = {
	marginBlock: "1rem",
	padding: "0.85rem 1rem",
	border: "1px solid",
	borderRadius: "0.55rem",
	lineHeight: 1.5,
};
const messageParagraphStyle: CSSProperties = { marginBlock: "0 0.5rem" };
const backLinkStyle: CSSProperties = {
	display: "inline-block",
	marginBlockEnd: "1rem",
	color: "#4338ca",
	textDecoration: "none",
};
const actionsStyle: CSSProperties = {
	display: "flex",
	gap: "0.5rem",
	flexWrap: "wrap",
	justifyContent: "flex-end",
};
const primaryButtonStyle: CSSProperties = {
	padding: "0.6rem 0.85rem",
	border: 0,
	borderRadius: "0.45rem",
	background: "#4338ca",
	color: "#fff",
	fontWeight: 650,
	cursor: "pointer",
};
const secondaryButtonStyle: CSSProperties = {
	padding: "0.55rem 0.8rem",
	border: "1px solid #cbd5e1",
	borderRadius: "0.45rem",
	background: "#fff",
	color: "#334155",
	cursor: "pointer",
};
const dangerButtonStyle: CSSProperties = {
	...secondaryButtonStyle,
	borderColor: "#fecaca",
	color: "#b91c1c",
};
const textButtonStyle: CSSProperties = {
	padding: 0,
	border: 0,
	background: "transparent",
	color: "#4338ca",
	cursor: "pointer",
};
const formGridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
	gap: "1rem",
	padding: "1.25rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.7rem",
};
const fieldStyle: CSSProperties = { display: "grid", gap: "0.35rem" };
const labelStyle: CSSProperties = {
	color: "#475569",
	fontSize: "0.78rem",
	fontWeight: 700,
};
const helpStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.78rem",
	lineHeight: 1.4,
};
const inputStyle: CSSProperties = {
	width: "100%",
	boxSizing: "border-box",
	padding: "0.55rem 0.65rem",
	border: "1px solid #cbd5e1",
	borderRadius: "0.4rem",
	background: "#fff",
	color: "#0f172a",
	font: "inherit",
};
const sectionHeaderStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "1rem",
	marginBlock: "1.5rem 0.75rem",
};
const questionsStyle: CSSProperties = { display: "grid", gap: "1rem" };
const questionStyle: CSSProperties = {
	padding: "1.25rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.7rem",
	background: "#fff",
};
const questionHeadingStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "1rem",
	marginBlockEnd: "0.85rem",
};
const questionGridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "2fr 1fr",
	gap: "0.75rem",
};
const answersStyle: CSSProperties = {
	display: "grid",
	gap: "0.5rem",
	marginBlock: "1rem",
};
const answersFieldsetStyle: CSSProperties = {
	display: "flex",
	gap: "1rem",
	marginBlock: "1rem",
	padding: "0.75rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.45rem",
};
const inlineChoiceStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: "0.4rem",
};
const answerRowStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "auto minmax(0, 1fr) auto",
	alignItems: "center",
	gap: "0.6rem",
};

export default KnowledgeChecksPage;
