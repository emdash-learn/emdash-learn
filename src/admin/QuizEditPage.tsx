/**
 * Quiz authoring (T21 / §16.5) — mounts at
 * `/_emdash/admin/plugins/lms-core/quizzes/:quizId`.
 *
 * `:quizId === "new"` renders a blank draft that submits via `quiz:create`;
 * any other value loads the existing quiz and saves via `quiz:update`. A
 * browser `beforeunload` guard stops the user from losing unsaved edits.
 *
 * The wireframe's "Preview" affordance (take the quiz as a student would
 * against a dry-run attempt) is deferred. The student-side UI lives in the
 * QuizBlock frontend (T16) and isn't reachable from the admin shell yet;
 * plumbing a second render target here would duplicate that work. Save +
 * navigate back is enough for v1 authoring.
 *
 * Per §12 Q19, T21 ships plain HTML + inline styles — Kumo + Lingui adoption
 * is the Wave 6 batch refactor that lands after T19–T25 together.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type CSSProperties,
	type ReactElement,
} from "react";

import type { QuizCreateInput, QuizUpdateInput } from "../routes/quizzes.js";
import type { QuestionType, Quiz, QuizTimeLimitPolicy } from "../types/storage.js";
import { LmsApiError, createApiClient } from "./api-client.js";

const PLUGIN_BASE = "/_emdash/admin/plugins/lms-core";
const QUIZZES_PATH_PREFIX = `${PLUGIN_BASE}/quizzes/`;
const QUIZZES_LIST_HREF = `${PLUGIN_BASE}/quizzes`;
const NEW_QUIZ_SENTINEL = "new";
const DEFAULT_PASSING_SCORE = 70;

// ---------------------------------------------------------------------------
// Draft model — intentionally looser than storage.Quiz so users can clear
// fields mid-edit (e.g. remove the description, clear a time limit) without
// fighting validation on every keystroke.
// ---------------------------------------------------------------------------

export interface DraftQuestionOption {
	id: string;
	text: string;
	correct: boolean;
}

export interface DraftQuestion {
	id: string;
	type: QuestionType;
	prompt: string;
	options?: DraftQuestionOption[];
	explanation?: string;
	points: number;
}

export interface DraftQuiz {
	title: string;
	description: string;
	passingScore: number;
	timeLimit?: number;
	timeLimitPolicy: QuizTimeLimitPolicy;
	randomize: boolean;
	questions: DraftQuestion[];
}

export type MakeId = () => string;

function browserMakeId(): string {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/**
 * Extract the `:quizId` segment from `/_emdash/admin/plugins/lms-core/quizzes/:quizId`.
 * Returns `null` if the prefix doesn't match or the segment is missing/invalid.
 * Handles percent-encoded ids so callers can safely `encodeURIComponent` the id.
 */
export function parseQuizIdFromPath(pathname: string): string | null {
	if (!pathname.startsWith(QUIZZES_PATH_PREFIX)) return null;
	const rest = pathname.slice(QUIZZES_PATH_PREFIX.length);
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

export function isNewQuizId(quizId: string): boolean {
	return quizId === NEW_QUIZ_SENTINEL;
}

function parseTimeLimitPolicy(value: string): QuizTimeLimitPolicy | null {
	return value === "hard" || value === "soft" ? value : null;
}

// ---------------------------------------------------------------------------
// Draft factories + mutators
// ---------------------------------------------------------------------------

export function makeBlankOption(
	correct: boolean,
	makeId: MakeId = browserMakeId,
): DraftQuestionOption {
	return { id: makeId(), text: "", correct };
}

export function makeBlankQuestion(
	type: QuestionType,
	makeId: MakeId = browserMakeId,
): DraftQuestion {
	const base = { id: makeId(), type, prompt: "", points: 1 };
	switch (type) {
		case "mcq":
			return {
				...base,
				options: [makeBlankOption(false, makeId), makeBlankOption(false, makeId)],
			};
		case "multi":
			return {
				...base,
				options: [makeBlankOption(false, makeId), makeBlankOption(false, makeId)],
			};
		case "true_false":
			return {
				...base,
				options: [
					{ id: makeId(), text: "True", correct: false },
					{ id: makeId(), text: "False", correct: false },
				],
			};
		case "short_text":
			return base;
		default: {
			const _exhaustive: never = type;
			return _exhaustive;
		}
	}
}

export function makeBlankQuiz(makeId: MakeId = browserMakeId): DraftQuiz {
	return {
		title: "",
		description: "",
		passingScore: DEFAULT_PASSING_SCORE,
		timeLimitPolicy: "hard",
		randomize: false,
		questions: [makeBlankQuestion("mcq", makeId)],
	};
}

export function quizToDraft(quiz: Quiz): DraftQuiz {
	return {
		title: quiz.title,
		description: quiz.description ?? "",
		passingScore: quiz.passingScore,
		...(quiz.timeLimit !== undefined ? { timeLimit: quiz.timeLimit } : {}),
		timeLimitPolicy: quiz.timeLimitPolicy,
		randomize: quiz.randomize,
		questions: quiz.questions.map((q) => ({
			id: q.id,
			type: q.type,
			prompt: q.prompt,
			...(q.options ? { options: q.options.map((o) => ({ ...o })) } : {}),
			...(q.explanation !== undefined ? { explanation: q.explanation } : {}),
			points: q.points,
		})),
	};
}

export function addQuestion(
	questions: DraftQuestion[],
	type: QuestionType,
	makeId: MakeId = browserMakeId,
): DraftQuestion[] {
	return [...questions, makeBlankQuestion(type, makeId)];
}

export function duplicateQuestion(
	questions: DraftQuestion[],
	index: number,
	makeId: MakeId = browserMakeId,
): DraftQuestion[] {
	if (index < 0 || index >= questions.length) return questions;
	const source = questions[index];
	if (!source) return questions;
	const copy: DraftQuestion = {
		...source,
		id: makeId(),
		...(source.options
			? {
					options: source.options.map((o) => ({ ...o, id: makeId() })),
				}
			: {}),
	};
	const next = questions.slice();
	next.splice(index + 1, 0, copy);
	return next;
}

export function deleteQuestion(questions: DraftQuestion[], index: number): DraftQuestion[] {
	if (index < 0 || index >= questions.length) return questions;
	return questions.filter((_, i) => i !== index);
}

export function moveQuestion(
	questions: DraftQuestion[],
	index: number,
	direction: "up" | "down",
): DraftQuestion[] {
	const target = direction === "up" ? index - 1 : index + 1;
	if (index < 0 || index >= questions.length || target < 0 || target >= questions.length) {
		return questions;
	}
	const next = questions.slice();
	const a = next[index];
	const b = next[target];
	if (!a || !b) return questions;
	next[index] = b;
	next[target] = a;
	return next;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * Client-side preflight — the server's Zod schema is authoritative but these
 * rules catch the obvious mistakes before a round-trip.
 */
export function validateDraft(draft: DraftQuiz): ValidationResult {
	const errors: string[] = [];
	if (draft.title.trim().length === 0) errors.push("Title is required.");
	if (draft.title.length > 200) errors.push("Title must be 200 characters or fewer.");
	if (draft.description.length > 1000) errors.push("Description must be 1000 characters or fewer.");
	if (!Number.isFinite(draft.passingScore) || draft.passingScore < 0 || draft.passingScore > 100) {
		errors.push("Passing score must be between 0 and 100.");
	}
	if (draft.timeLimit !== undefined) {
		if (!Number.isInteger(draft.timeLimit) || draft.timeLimit < 1) {
			errors.push("Time limit must be a positive whole number of minutes.");
		}
	}
	if (draft.questions.length === 0) {
		errors.push("Add at least one question.");
	}
	draft.questions.forEach((q, i) => {
		const label = `Question ${i + 1}`;
		if (q.prompt.trim().length === 0) {
			errors.push(`${label}: prompt is required.`);
		}
		if (!Number.isFinite(q.points) || q.points < 0) {
			errors.push(`${label}: points must be 0 or greater.`);
		}
		if (q.type === "mcq") {
			const opts = q.options ?? [];
			if (opts.length < 2) errors.push(`${label}: add at least 2 options.`);
			const correct = opts.filter((o) => o.correct).length;
			if (correct !== 1) errors.push(`${label}: pick exactly 1 correct option.`);
			if (opts.some((o) => o.text.trim().length === 0))
				errors.push(`${label}: every option needs text.`);
		} else if (q.type === "multi") {
			const opts = q.options ?? [];
			if (opts.length < 2) errors.push(`${label}: add at least 2 options.`);
			const correct = opts.filter((o) => o.correct).length;
			if (correct < 1) errors.push(`${label}: mark at least 1 correct option.`);
			if (opts.some((o) => o.text.trim().length === 0))
				errors.push(`${label}: every option needs text.`);
		} else if (q.type === "true_false") {
			const opts = q.options ?? [];
			const correct = opts.filter((o) => o.correct).length;
			if (correct !== 1) errors.push(`${label}: select True or False as the answer.`);
		}
	});
	return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Draft → route-input shapes
// ---------------------------------------------------------------------------

function draftQuestionToRoute(q: DraftQuestion): DraftQuestion {
	// The engine trusts whatever it received last — trim obvious whitespace.
	return {
		id: q.id,
		type: q.type,
		prompt: q.prompt.trim(),
		...(q.options
			? {
					options: q.options.map((o) => ({
						id: o.id,
						text: o.text.trim(),
						correct: o.correct,
					})),
				}
			: {}),
		...(q.explanation !== undefined && q.explanation.trim().length > 0
			? { explanation: q.explanation.trim() }
			: {}),
		points: q.points,
	};
}

export function draftToCreateInput(draft: DraftQuiz): QuizCreateInput {
	const description = draft.description.trim();
	return {
		title: draft.title.trim(),
		...(description.length > 0 ? { description } : {}),
		passingScore: draft.passingScore,
		...(draft.timeLimit !== undefined ? { timeLimit: draft.timeLimit } : {}),
		timeLimitPolicy: draft.timeLimitPolicy,
		randomize: draft.randomize,
		questions: draft.questions.map(draftQuestionToRoute),
	};
}

export function draftToUpdateInput(draft: DraftQuiz, quizId: string): QuizUpdateInput {
	return { quizId, ...draftToCreateInput(draft) };
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

type LoadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; quizId: string | null }; // `null` while creating

export function QuizEditPage(): ReactElement {
	const quizIdParam = useMemo(() => {
		if (typeof window === "undefined") return null;
		return parseQuizIdFromPath(window.location.pathname);
	}, []);

	const api = useMemo(() => createApiClient(), []);

	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [draft, setDraft] = useState<DraftQuiz>(() => makeBlankQuiz());
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [validationErrors, setValidationErrors] = useState<string[]>([]);

	const isCreating = quizIdParam != null && isNewQuizId(quizIdParam);

	const load = useCallback(async () => {
		if (!quizIdParam) {
			setState({
				kind: "error",
				message:
					"Missing quiz id in URL — expected /_emdash/admin/plugins/lms-core/quizzes/<id> or /quizzes/new.",
			});
			return;
		}
		if (isNewQuizId(quizIdParam)) {
			setDraft(makeBlankQuiz());
			setDirty(false);
			setState({ kind: "ready", quizId: null });
			return;
		}
		setState({ kind: "loading" });
		try {
			// There's no `quiz:get` route in v1; the list route returns full quiz
			// bodies, so we fetch a page and look up by id. For v1 scales (dozens
			// of quizzes per site) this is cheap enough; T21 calls out the need
			// for a dedicated route in the follow-up pass.
			const page = await api.quizzes.list({ limit: 100 });
			const found = page.items.find((q) => q.id === quizIdParam);
			if (!found) {
				setState({
					kind: "error",
					message: `Quiz ${quizIdParam} not found.`,
				});
				return;
			}
			const { id: _ignored, ...rest } = found;
			setDraft(quizToDraft(rest));
			setDirty(false);
			setState({ kind: "ready", quizId: quizIdParam });
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api, quizIdParam]);

	useEffect(() => {
		void load();
	}, [load]);

	// beforeunload guard: only attach while dirty, detach on clean/unmount.
	useEffect(() => {
		if (!dirty || typeof window === "undefined") return undefined;
		const handler = (ev: BeforeUnloadEvent) => {
			ev.preventDefault();
			ev.returnValue = "";
			return "";
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);

	const update = useCallback((fn: (prev: DraftQuiz) => DraftQuiz) => {
		setDraft((prev) => fn(prev));
		setDirty(true);
	}, []);

	const onSave = useCallback(async () => {
		const result = validateDraft(draft);
		if (!result.valid) {
			setValidationErrors(result.errors);
			return;
		}
		setValidationErrors([]);
		setSaving(true);
		setSaveError(null);
		try {
			if (state.kind === "ready" && state.quizId) {
				await api.quizzes.update(draftToUpdateInput(draft, state.quizId));
				setDirty(false);
			} else {
				const created = await api.quizzes.create(draftToCreateInput(draft));
				setDirty(false);
				// Navigate to the canonical edit URL so reloads don't retrigger "new".
				if (typeof window !== "undefined") {
					window.location.href = `${PLUGIN_BASE}/quizzes/${encodeURIComponent(created.id)}`;
				}
			}
		} catch (err) {
			setSaveError(formatError(err));
		} finally {
			setSaving(false);
		}
	}, [api, draft, state]);

	if (state.kind === "loading") {
		return (
			<section style={pageStyle}>
				<LoadingBanner />
			</section>
		);
	}

	if (state.kind === "error") {
		return (
			<section style={pageStyle}>
				<BackLink />
				<ErrorBanner message={state.message} onRetry={() => void load()} />
			</section>
		);
	}

	return (
		<section style={pageStyle}>
			<BackLink />
			<header style={headerRowStyle}>
				<h1 style={pageTitleStyle}>{isCreating ? "New quiz" : draft.title || "Untitled quiz"}</h1>
				<div style={actionRowStyle}>
					{dirty ? <span style={dirtyTagStyle}>Unsaved changes</span> : null}
					<button
						type="button"
						onClick={() => void onSave()}
						disabled={saving}
						style={saving ? primaryButtonDisabledStyle : primaryButtonStyle}
					>
						{saving ? "Saving…" : "Save"}
					</button>
				</div>
			</header>

			{saveError ? (
				<div role="alert" style={errorBannerStyle}>
					Save failed: {saveError}
				</div>
			) : null}

			{validationErrors.length > 0 ? (
				<div role="alert" style={errorBannerStyle}>
					<strong>Fix these before saving:</strong>
					<ul style={errorListStyle}>
						{validationErrors.map((msg) => (
							<li key={msg}>{msg}</li>
						))}
					</ul>
				</div>
			) : null}

			<SettingsCard draft={draft} onChange={update} />
			<QuestionsCard draft={draft} onChange={update} />
		</section>
	);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function BackLink(): ReactElement {
	return (
		<a href={QUIZZES_LIST_HREF} style={backLinkStyle}>
			← Back to quizzes
		</a>
	);
}

function SettingsCard({
	draft,
	onChange,
}: {
	draft: DraftQuiz;
	onChange: (fn: (prev: DraftQuiz) => DraftQuiz) => void;
}): ReactElement {
	return (
		<section aria-label="Quiz settings" style={cardStyle}>
			<div style={fieldStyle}>
				<label style={labelStyle} htmlFor="quiz-title">
					Title
				</label>
				<input
					id="quiz-title"
					type="text"
					value={draft.title}
					onChange={(e) => onChange((prev) => ({ ...prev, title: e.target.value }))}
					style={inputStyle}
					maxLength={200}
				/>
			</div>

			<div style={fieldStyle}>
				<label style={labelStyle} htmlFor="quiz-description">
					Description
				</label>
				<textarea
					id="quiz-description"
					value={draft.description}
					onChange={(e) => onChange((prev) => ({ ...prev, description: e.target.value }))}
					style={textareaStyle}
					rows={3}
					maxLength={1000}
				/>
			</div>

			<div style={inlineFieldsStyle}>
				<div style={fieldStyle}>
					<label style={labelStyle} htmlFor="quiz-passing-score">
						Passing score (%)
					</label>
					<input
						id="quiz-passing-score"
						type="number"
						min={0}
						max={100}
						value={draft.passingScore}
						onChange={(e) =>
							onChange((prev) => ({
								...prev,
								passingScore: Number(e.target.value),
							}))
						}
						style={numberInputStyle}
					/>
				</div>

				<div style={fieldStyle}>
					<label style={labelStyle} htmlFor="quiz-time-limit">
						Time limit (min)
					</label>
					<input
						id="quiz-time-limit"
						type="number"
						min={1}
						value={draft.timeLimit ?? ""}
						onChange={(e) => {
							const raw = e.target.value;
							onChange((prev) => {
								if (raw === "") {
									const { timeLimit: _drop, ...rest } = prev;
									return rest;
								}
								return { ...prev, timeLimit: Number(raw) };
							});
						}}
						placeholder="—"
						style={numberInputStyle}
					/>
				</div>

				<div style={fieldStyle}>
					<label style={labelStyle} htmlFor="quiz-time-policy">
						Policy
					</label>
					<select
						id="quiz-time-policy"
						value={draft.timeLimitPolicy}
						onChange={(e) => {
							const next = parseTimeLimitPolicy(e.target.value);
							if (!next) return;
							onChange((prev) => ({ ...prev, timeLimitPolicy: next }));
						}}
						disabled={draft.timeLimit === undefined}
						style={selectStyle}
					>
						<option value="hard">Hard — reject late submissions</option>
						<option value="soft">Soft — accept, flag as overtime</option>
					</select>
				</div>
			</div>

			<div style={checkboxRowStyle}>
				<input
					id="quiz-randomize"
					type="checkbox"
					checked={draft.randomize}
					onChange={(e) => onChange((prev) => ({ ...prev, randomize: e.target.checked }))}
				/>
				<label htmlFor="quiz-randomize">Randomize question order</label>
			</div>
		</section>
	);
}

function QuestionsCard({
	draft,
	onChange,
}: {
	draft: DraftQuiz;
	onChange: (fn: (prev: DraftQuiz) => DraftQuiz) => void;
}): ReactElement {
	const onAdd = (type: QuestionType) => {
		onChange((prev) => ({ ...prev, questions: addQuestion(prev.questions, type) }));
	};

	return (
		<section aria-label="Questions" style={cardStyle}>
			<div style={sectionTitleRowStyle}>
				<h2 style={sectionTitleStyle}>Questions</h2>
				<AddQuestionMenu onAdd={onAdd} />
			</div>

			{draft.questions.length === 0 ? (
				<div style={emptyStateStyle}>Add a question to get started.</div>
			) : (
				<ol style={questionListStyle}>
					{draft.questions.map((q, index) => (
						<QuestionEditor
							key={q.id}
							question={q}
							index={index}
							total={draft.questions.length}
							onPatch={(patch) =>
								onChange((prev) => ({
									...prev,
									questions: prev.questions.map((orig, i) =>
										i === index ? { ...orig, ...patch } : orig,
									),
								}))
							}
							onMoveUp={() =>
								onChange((prev) => ({
									...prev,
									questions: moveQuestion(prev.questions, index, "up"),
								}))
							}
							onMoveDown={() =>
								onChange((prev) => ({
									...prev,
									questions: moveQuestion(prev.questions, index, "down"),
								}))
							}
							onDuplicate={() =>
								onChange((prev) => ({
									...prev,
									questions: duplicateQuestion(prev.questions, index),
								}))
							}
							onDelete={() =>
								onChange((prev) => ({
									...prev,
									questions: deleteQuestion(prev.questions, index),
								}))
							}
						/>
					))}
				</ol>
			)}
		</section>
	);
}

function AddQuestionMenu({ onAdd }: { onAdd: (type: QuestionType) => void }): ReactElement {
	return (
		<div style={addMenuStyle}>
			<span style={addMenuLabelStyle}>Add:</span>
			<button type="button" onClick={() => onAdd("mcq")} style={chipButtonStyle}>
				Multiple choice
			</button>
			<button type="button" onClick={() => onAdd("multi")} style={chipButtonStyle}>
				Multi-select
			</button>
			<button type="button" onClick={() => onAdd("true_false")} style={chipButtonStyle}>
				True / false
			</button>
			<button type="button" onClick={() => onAdd("short_text")} style={chipButtonStyle}>
				Short text
			</button>
		</div>
	);
}

interface QuestionEditorProps {
	question: DraftQuestion;
	index: number;
	total: number;
	onPatch: (patch: Partial<DraftQuestion>) => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
	onDuplicate: () => void;
	onDelete: () => void;
}

function QuestionEditor(props: QuestionEditorProps): ReactElement {
	const { question, index, total, onPatch, onMoveUp, onMoveDown, onDuplicate, onDelete } = props;
	const promptId = `question-prompt-${question.id}`;
	const explanationId = `question-explanation-${question.id}`;
	const pointsId = `question-points-${question.id}`;

	return (
		<li style={questionCardStyle}>
			<div style={questionHeaderStyle}>
				<div style={questionTitleStyle}>
					Q{index + 1}. {labelForType(question.type)}
				</div>
				<div style={questionActionsStyle}>
					<button
						type="button"
						onClick={onMoveUp}
						disabled={index === 0}
						style={iconButtonStyle}
						aria-label={`Move question ${index + 1} up`}
					>
						↑
					</button>
					<button
						type="button"
						onClick={onMoveDown}
						disabled={index === total - 1}
						style={iconButtonStyle}
						aria-label={`Move question ${index + 1} down`}
					>
						↓
					</button>
					<button
						type="button"
						onClick={onDuplicate}
						style={iconButtonStyle}
						aria-label={`Duplicate question ${index + 1}`}
					>
						Duplicate
					</button>
					<button
						type="button"
						onClick={onDelete}
						style={iconButtonDangerStyle}
						aria-label={`Delete question ${index + 1}`}
					>
						Delete
					</button>
				</div>
			</div>

			<div style={fieldStyle}>
				<label style={labelStyle} htmlFor={promptId}>
					Prompt
				</label>
				<textarea
					id={promptId}
					value={question.prompt}
					onChange={(e) => onPatch({ prompt: e.target.value })}
					style={textareaStyle}
					rows={2}
				/>
			</div>

			{question.type === "mcq" ? (
				<OptionsEditor question={question} mode="single" onPatch={onPatch} />
			) : question.type === "multi" ? (
				<OptionsEditor question={question} mode="multi" onPatch={onPatch} />
			) : question.type === "true_false" ? (
				<TrueFalseEditor question={question} onPatch={onPatch} />
			) : (
				<p style={shortTextHintStyle}>
					Short-text answers are graded exact-match against the correct option text saved on the
					question (set via the route payload; no UI yet).
				</p>
			)}

			<div style={inlineFieldsStyle}>
				<div style={fieldStyle}>
					<label style={labelStyle} htmlFor={pointsId}>
						Points
					</label>
					<input
						id={pointsId}
						type="number"
						min={0}
						value={question.points}
						onChange={(e) => onPatch({ points: Number(e.target.value) })}
						style={numberInputStyle}
					/>
				</div>
			</div>

			<div style={fieldStyle}>
				<label style={labelStyle} htmlFor={explanationId}>
					Explanation (shown after submit)
				</label>
				<textarea
					id={explanationId}
					value={question.explanation ?? ""}
					onChange={(e) =>
						onPatch({
							explanation: e.target.value,
						})
					}
					style={textareaStyle}
					rows={2}
				/>
			</div>
		</li>
	);
}

function labelForType(type: QuestionType): string {
	switch (type) {
		case "mcq":
			return "Multiple choice";
		case "multi":
			return "Multi-select";
		case "true_false":
			return "True / false";
		case "short_text":
			return "Short text";
		default: {
			const _exhaustive: never = type;
			return _exhaustive;
		}
	}
}

function OptionsEditor({
	question,
	mode,
	onPatch,
}: {
	question: DraftQuestion;
	mode: "single" | "multi";
	onPatch: (patch: Partial<DraftQuestion>) => void;
}): ReactElement {
	const options = question.options ?? [];

	function patchOption(index: number, next: Partial<DraftQuestionOption>) {
		const out = options.map((o, i) => (i === index ? { ...o, ...next } : o));
		onPatch({ options: out });
	}

	function toggleCorrect(index: number) {
		if (mode === "single") {
			onPatch({
				options: options.map((o, i) => ({ ...o, correct: i === index })),
			});
		} else {
			patchOption(index, { correct: !options[index]?.correct });
		}
	}

	function addOption() {
		onPatch({
			options: [...options, makeBlankOption(false)],
		});
	}

	function removeOption(index: number) {
		onPatch({ options: options.filter((_, i) => i !== index) });
	}

	return (
		<div>
			<div style={optionsHeaderStyle}>
				Options ({mode === "single" ? "pick one correct" : "mark all correct"})
			</div>
			<ul style={optionsListStyle}>
				{options.map((opt, i) => (
					<li key={opt.id} style={optionRowStyle}>
						<input
							type={mode === "single" ? "radio" : "checkbox"}
							name={`correct-${question.id}`}
							checked={opt.correct}
							onChange={() => toggleCorrect(i)}
							aria-label={`Option ${i + 1} correct`}
						/>
						<input
							type="text"
							value={opt.text}
							onChange={(e) => patchOption(i, { text: e.target.value })}
							style={optionInputStyle}
							placeholder={`Option ${i + 1}`}
						/>
						<button
							type="button"
							onClick={() => removeOption(i)}
							disabled={options.length <= 2}
							style={iconButtonStyle}
							aria-label={`Remove option ${i + 1}`}
						>
							Remove
						</button>
					</li>
				))}
			</ul>
			<button type="button" onClick={addOption} style={chipButtonStyle}>
				+ Add option
			</button>
		</div>
	);
}

function TrueFalseEditor({
	question,
	onPatch,
}: {
	question: DraftQuestion;
	onPatch: (patch: Partial<DraftQuestion>) => void;
}): ReactElement {
	const options = question.options ?? [];
	function pick(index: number) {
		onPatch({
			options: options.map((o, i) => ({ ...o, correct: i === index })),
		});
	}
	return (
		<div>
			<div style={optionsHeaderStyle}>Correct answer</div>
			<div style={trueFalseRowStyle}>
				{options.map((opt, i) => (
					<label key={opt.id} style={trueFalseLabelStyle}>
						<input
							type="radio"
							name={`correct-${question.id}`}
							checked={opt.correct}
							onChange={() => pick(i)}
						/>
						{opt.text}
					</label>
				))}
			</div>
		</div>
	);
}

function LoadingBanner(): ReactElement {
	return (
		<div style={mutedBannerStyle} role="status" aria-live="polite">
			Loading quiz…
		</div>
	);
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
	return (
		<div role="alert" style={errorBannerStyle}>
			<div style={{ marginBlockEnd: "0.5rem" }}>{message}</div>
			<button type="button" onClick={onRetry} style={secondaryButtonStyle}>
				Retry
			</button>
		</div>
	);
}

function formatError(err: unknown): string {
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

// ── styles ───────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
	padding: "2rem",
	maxInlineSize: "64rem",
	marginInline: "auto",
	fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif",
	color: "#0f172a",
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
	marginBlockEnd: "1rem",
};

const pageTitleStyle: CSSProperties = {
	fontSize: "1.5rem",
	marginBlock: 0,
};

const actionRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "0.75rem",
};

const dirtyTagStyle: CSSProperties = {
	color: "#b45309",
	fontSize: "0.8125rem",
	fontWeight: 600,
};

const primaryButtonStyle: CSSProperties = {
	paddingBlock: "0.5rem",
	paddingInline: "1rem",
	borderRadius: "0.375rem",
	backgroundColor: "#2563eb",
	color: "white",
	fontWeight: 600,
	border: "none",
	cursor: "pointer",
};

const primaryButtonDisabledStyle: CSSProperties = {
	...primaryButtonStyle,
	opacity: 0.6,
	cursor: "not-allowed",
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

const cardStyle: CSSProperties = {
	padding: "1rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	backgroundColor: "white",
	marginBlockEnd: "1rem",
	display: "grid",
	gap: "0.75rem",
};

const sectionTitleRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "0.75rem",
	flexWrap: "wrap",
};

const sectionTitleStyle: CSSProperties = {
	fontSize: "1.125rem",
	marginBlock: 0,
};

const fieldStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "0.25rem",
	flex: 1,
	minInlineSize: "10rem",
};

const labelStyle: CSSProperties = {
	color: "#334155",
	fontSize: "0.8125rem",
	fontWeight: 500,
};

const inputStyle: CSSProperties = {
	padding: "0.5rem",
	borderRadius: "0.375rem",
	border: "1px solid #cbd5e1",
	fontSize: "0.925rem",
	fontFamily: "inherit",
};

const textareaStyle: CSSProperties = {
	...inputStyle,
	resize: "vertical",
	minBlockSize: "2.5rem",
};

const numberInputStyle: CSSProperties = {
	...inputStyle,
	inlineSize: "7rem",
	fontVariantNumeric: "tabular-nums",
};

const selectStyle: CSSProperties = {
	...inputStyle,
	backgroundColor: "white",
};

const inlineFieldsStyle: CSSProperties = {
	display: "flex",
	flexWrap: "wrap",
	gap: "0.75rem",
};

const checkboxRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "0.5rem",
};

const addMenuStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	flexWrap: "wrap",
	gap: "0.5rem",
};

const addMenuLabelStyle: CSSProperties = {
	color: "#475569",
	fontSize: "0.8125rem",
};

const chipButtonStyle: CSSProperties = {
	paddingBlock: "0.375rem",
	paddingInline: "0.75rem",
	borderRadius: "9999px",
	border: "1px solid #cbd5e1",
	backgroundColor: "white",
	color: "#0f172a",
	cursor: "pointer",
	fontSize: "0.8125rem",
};

const questionListStyle: CSSProperties = {
	listStyle: "none",
	paddingInlineStart: 0,
	marginBlock: 0,
	display: "grid",
	gap: "0.75rem",
};

const questionCardStyle: CSSProperties = {
	padding: "0.875rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	backgroundColor: "#f8fafc",
	display: "grid",
	gap: "0.5rem",
};

const questionHeaderStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "0.5rem",
	flexWrap: "wrap",
};

const questionTitleStyle: CSSProperties = {
	fontWeight: 600,
	color: "#0f172a",
};

const questionActionsStyle: CSSProperties = {
	display: "flex",
	gap: "0.375rem",
	flexWrap: "wrap",
};

const iconButtonStyle: CSSProperties = {
	paddingBlock: "0.25rem",
	paddingInline: "0.5rem",
	borderRadius: "0.375rem",
	border: "1px solid #cbd5e1",
	backgroundColor: "white",
	cursor: "pointer",
	fontSize: "0.8125rem",
	color: "#0f172a",
};

const iconButtonDangerStyle: CSSProperties = {
	...iconButtonStyle,
	color: "#b91c1c",
	borderColor: "#fecaca",
};

const optionsHeaderStyle: CSSProperties = {
	color: "#475569",
	fontSize: "0.8125rem",
	marginBlockEnd: "0.25rem",
};

const optionsListStyle: CSSProperties = {
	listStyle: "none",
	paddingInlineStart: 0,
	marginBlock: 0,
	display: "grid",
	gap: "0.375rem",
};

const optionRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "0.5rem",
};

const optionInputStyle: CSSProperties = {
	...inputStyle,
	flex: 1,
};

const trueFalseRowStyle: CSSProperties = {
	display: "flex",
	gap: "1rem",
};

const trueFalseLabelStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "0.375rem",
	fontSize: "0.925rem",
};

const shortTextHintStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.8125rem",
	fontStyle: "italic",
	marginBlock: 0,
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
	marginBlockEnd: "1rem",
};

const errorListStyle: CSSProperties = {
	marginBlockStart: "0.25rem",
	marginBlockEnd: 0,
	paddingInlineStart: "1.25rem",
};

const emptyStateStyle: CSSProperties = {
	paddingBlock: "1rem",
	paddingInline: "1rem",
	border: "1px dashed #cbd5e1",
	borderRadius: "0.5rem",
	color: "#64748b",
	fontSize: "0.925rem",
};

export default QuizEditPage;
