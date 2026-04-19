/**
 * Topic edit page (ADR 0001) — mounts at
 * `/_emdash/admin/plugins/lms-core/courses/:courseId/lessons/:lessonId/topics/:topicId`.
 *
 * Topics have no drip / preview fields, so this editor is intentionally
 * simpler than the lesson editor: title, summary, body (Portable Text
 * placeholder), order, requires_previous, video URL, duration, status.
 *
 * The Portable Text body is stored as a JSON array on the content row. This
 * v1 page renders a JSON textarea — the lesson editor uses the same
 * approach pending Wave 6's editor refactor (§12 Q19), so we match the
 * existing pattern rather than introduce a different embedded editor here.
 *
 * Per §12 Q19, this page ships plain HTML + inline styles like the rest of
 * the admin pages — Kumo + Lingui adoption is the Wave 6 batch refactor.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type CSSProperties,
	type ReactElement,
} from "react";

import { LmsApiError, createApiClient } from "./api-client.js";

const PLUGIN_BASE = "/_emdash/admin/plugins/lms-core";
const PATH_PREFIX = `${PLUGIN_BASE}/courses/`;
const NEW_TOPIC_SENTINEL = "new";

interface ParsedPath {
	courseId: string;
	lessonId: string;
	topicId: string; // "new" sentinel allowed
}

/**
 * Parse the segment shape `/_emdash/admin/plugins/lms-core/courses/:courseId/lessons/:lessonId/topics/:topicId`.
 */
export function parseTopicEditPath(pathname: string): ParsedPath | null {
	if (!pathname.startsWith(PATH_PREFIX)) return null;
	const rest = pathname.slice(PATH_PREFIX.length);
	const parts = rest.split("/");
	if (parts.length < 5) return null;
	const [course, lessonsLit, lesson, topicsLit, topic] = parts;
	if (lessonsLit !== "lessons" || topicsLit !== "topics") return null;
	if (!course || !lesson || !topic) return null;
	try {
		return {
			courseId: decodeURIComponent(course),
			lessonId: decodeURIComponent(lesson),
			topicId: decodeURIComponent(topic),
		};
	} catch {
		return null;
	}
}

interface DraftTopic {
	title: string;
	summary: string;
	bodyJson: string;
	order: number;
	requiresPrevious: boolean;
	videoUrl: string;
	durationSeconds: number;
	status: "draft" | "published";
}

function makeBlankDraft(): DraftTopic {
	return {
		title: "",
		summary: "",
		bodyJson: "[]",
		order: 0,
		requiresPrevious: false,
		videoUrl: "",
		durationSeconds: 0,
		status: "draft",
	};
}

function dataToDraft(item: { data: Record<string, unknown>; status?: string }): DraftTopic {
	const d = item.data;
	const body = d["body"];
	const draft: DraftTopic = {
		title: typeof d["title"] === "string" ? (d["title"] as string) : "",
		summary: typeof d["summary"] === "string" ? (d["summary"] as string) : "",
		bodyJson: Array.isArray(body) ? JSON.stringify(body, null, 2) : "[]",
		order: typeof d["order"] === "number" ? (d["order"] as number) : 0,
		requiresPrevious: d["requires_previous"] === true || d["requires_previous"] === 1,
		videoUrl: typeof d["video_url"] === "string" ? (d["video_url"] as string) : "",
		durationSeconds:
			typeof d["duration_seconds"] === "number" ? (d["duration_seconds"] as number) : 0,
		status: item.status === "published" ? "published" : "draft",
	};
	return draft;
}

function formatError(err: unknown): string {
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

type LoadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; topicId: string | null };

export function TopicEditPage(): ReactElement {
	const parsed = useMemo(() => {
		if (typeof window === "undefined") return null;
		return parseTopicEditPath(window.location.pathname);
	}, []);

	const api = useMemo(() => createApiClient(), []);
	const [draft, setDraft] = useState<DraftTopic>(() => makeBlankDraft());
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [bodyError, setBodyError] = useState<string | null>(null);

	const isCreating = parsed != null && parsed.topicId === NEW_TOPIC_SENTINEL;

	const load = useCallback(async () => {
		if (!parsed) {
			setState({
				kind: "error",
				message:
					"Missing course / lesson / topic id in URL — expected /_emdash/admin/plugins/lms-core/courses/:c/lessons/:l/topics/:t.",
			});
			return;
		}
		if (parsed.topicId === NEW_TOPIC_SENTINEL) {
			setDraft(makeBlankDraft());
			setDirty(false);
			setState({ kind: "ready", topicId: null });
			return;
		}
		setState({ kind: "loading" });
		try {
			const res = await api.topics.get({ topicId: parsed.topicId });
			setDraft(dataToDraft(res.topic));
			setDirty(false);
			setState({ kind: "ready", topicId: parsed.topicId });
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api, parsed]);

	useEffect(() => {
		void load();
	}, [load]);

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

	const update = useCallback(<K extends keyof DraftTopic>(key: K, value: DraftTopic[K]) => {
		setDraft((prev) => ({ ...prev, [key]: value }));
		setDirty(true);
	}, []);

	const onSave = useCallback(async () => {
		if (!parsed) return;
		setBodyError(null);
		let bodyArray: unknown[];
		try {
			const parsedJson = JSON.parse(draft.bodyJson);
			if (!Array.isArray(parsedJson)) throw new Error("body must be a JSON array");
			bodyArray = parsedJson;
		} catch (err) {
			setBodyError(`Body JSON is invalid: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		setSaving(true);
		setSaveError(null);
		try {
			if (state.kind === "ready" && state.topicId) {
				await api.topics.update({
					topicId: state.topicId,
					title: draft.title.trim(),
					summary: draft.summary.trim() || undefined,
					body: bodyArray as never,
					order: draft.order,
					requiresPrevious: draft.requiresPrevious,
					videoUrl: draft.videoUrl.trim() || undefined,
					durationSeconds: draft.durationSeconds,
					status: draft.status,
				});
				setDirty(false);
			} else {
				const created = await api.topics.create({
					courseId: parsed.courseId,
					lessonId: parsed.lessonId,
					title: draft.title.trim(),
					summary: draft.summary.trim() || undefined,
					body: bodyArray as never,
					order: draft.order,
					requiresPrevious: draft.requiresPrevious,
					videoUrl: draft.videoUrl.trim() || undefined,
					durationSeconds: draft.durationSeconds,
					status: draft.status,
				});
				setDirty(false);
				if (typeof window !== "undefined") {
					window.location.href = `${PATH_PREFIX}${encodeURIComponent(parsed.courseId)}/lessons/${encodeURIComponent(parsed.lessonId)}/topics/${encodeURIComponent(created.topic.id)}`;
				}
			}
		} catch (err) {
			setSaveError(formatError(err));
		} finally {
			setSaving(false);
		}
	}, [api, draft, parsed, state]);

	if (state.kind === "loading") {
		return (
			<section style={pageStyle}>
				<div style={mutedBannerStyle} role="status" aria-live="polite">
					Loading topic…
				</div>
			</section>
		);
	}
	if (state.kind === "error") {
		return (
			<section style={pageStyle}>
				<BackLink courseId={parsed?.courseId} />
				<div role="alert" style={errorBannerStyle}>
					{state.message}
				</div>
			</section>
		);
	}

	return (
		<section style={pageStyle}>
			<BackLink courseId={parsed?.courseId} />
			<header style={headerRowStyle}>
				<h1 style={pageTitleStyle}>{isCreating ? "New topic" : draft.title || "Untitled topic"}</h1>
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

			<section aria-label="Topic basics" style={cardStyle}>
				<div style={fieldStyle}>
					<label style={labelStyle} htmlFor="topic-title">
						Title
					</label>
					<input
						id="topic-title"
						type="text"
						value={draft.title}
						onChange={(e) => update("title", e.target.value)}
						style={inputStyle}
						maxLength={200}
					/>
				</div>

				<div style={fieldStyle}>
					<label style={labelStyle} htmlFor="topic-summary">
						Summary
					</label>
					<textarea
						id="topic-summary"
						value={draft.summary}
						onChange={(e) => update("summary", e.target.value)}
						style={textareaStyle}
						rows={2}
						maxLength={500}
					/>
				</div>

				<div style={inlineFieldsStyle}>
					<div style={fieldStyle}>
						<label style={labelStyle} htmlFor="topic-order">
							Order
						</label>
						<input
							id="topic-order"
							type="number"
							min={0}
							value={draft.order}
							onChange={(e) => update("order", Number(e.target.value))}
							style={numberInputStyle}
						/>
					</div>

					<div style={fieldStyle}>
						<label style={labelStyle} htmlFor="topic-duration">
							Duration (seconds)
						</label>
						<input
							id="topic-duration"
							type="number"
							min={0}
							value={draft.durationSeconds}
							onChange={(e) => update("durationSeconds", Number(e.target.value))}
							style={numberInputStyle}
						/>
					</div>

					<div style={fieldStyle}>
						<label style={labelStyle} htmlFor="topic-status">
							Status
						</label>
						<select
							id="topic-status"
							value={draft.status}
							onChange={(e) =>
								update("status", e.target.value === "published" ? "published" : "draft")
							}
							style={selectStyle}
						>
							<option value="draft">Draft</option>
							<option value="published">Published</option>
						</select>
					</div>
				</div>

				<div style={fieldStyle}>
					<label style={labelStyle} htmlFor="topic-video">
						Video URL
					</label>
					<input
						id="topic-video"
						type="text"
						value={draft.videoUrl}
						onChange={(e) => update("videoUrl", e.target.value)}
						style={inputStyle}
						maxLength={500}
					/>
				</div>

				<div style={checkboxRowStyle}>
					<input
						id="topic-requires-previous"
						type="checkbox"
						checked={draft.requiresPrevious}
						onChange={(e) => update("requiresPrevious", e.target.checked)}
					/>
					<label htmlFor="topic-requires-previous">
						Lock this topic until the previous topic in the lesson is complete
					</label>
				</div>
			</section>

			<section aria-label="Topic body" style={cardStyle}>
				<div style={sectionTitleRowStyle}>
					<h2 style={sectionTitleStyle}>Body (Portable Text JSON)</h2>
				</div>
				<p style={mutedTextStyle}>
					Edit the topic body as a Portable Text JSON array. Wave 6 replaces this with the embedded
					Portable Text editor used elsewhere in the admin shell.
				</p>
				{bodyError ? (
					<div role="alert" style={errorBannerStyle}>
						{bodyError}
					</div>
				) : null}
				<textarea
					value={draft.bodyJson}
					onChange={(e) => update("bodyJson", e.target.value)}
					style={{ ...textareaStyle, minBlockSize: "16rem", fontFamily: "ui-monospace, monospace" }}
					rows={16}
				/>
			</section>
		</section>
	);
}

function BackLink({ courseId }: { courseId: string | undefined }): ReactElement {
	const href = courseId ? `${PATH_PREFIX}${encodeURIComponent(courseId)}` : `${PLUGIN_BASE}/`;
	return (
		<a href={href} style={backLinkStyle}>
			← Back to course
		</a>
	);
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

const mutedTextStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.875rem",
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

export default TopicEditPage;
