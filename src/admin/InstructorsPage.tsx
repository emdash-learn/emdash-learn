/**
 * Instructor assignments page (T23 / §16.9) — mounts at
 * `/_emdash/admin/plugins/lms-core/instructors`.
 *
 * Renders every `course_instructors` row hydrated with user + course metadata
 * via `instructor:list`, grouped by user. Each user row expands to show their
 * per-course roles with an inline Remove button (`instructor:unset`). An
 * "Assign instructor" modal calls `instructor:set` with
 * `{ courseId, userId, role }`.
 *
 * Per §12 Q19, plain HTML + inline styles like T19/T22/T25 — Kumo + Lingui
 * adoption is the batch refactor that lands after T19–T25 together.
 *
 * No user-directory or course-picker surface exists in the plugin API today
 * (no `users:list` / admin `courses:list` route), so the Assign modal takes
 * raw `userId` + `courseId` inputs. Admins copy these from the dashboard /
 * course detail pages. An autocomplete upgrade tracks with a future wave
 * once a user-search route is wired.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type CSSProperties,
	type FormEvent,
	type ReactElement,
} from "react";

import { LmsApiError, createApiClient, type InstructorListItem } from "./api-client.js";
import type { InstructorRole } from "../types/storage.js";

type Api = ReturnType<typeof createApiClient>;

type LoadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; items: InstructorListItem[] };

interface InstructorGroup {
	userId: string;
	label: string;
	email?: string;
	assignments: InstructorListItem[];
}

function formatError(err: unknown): string {
	if (err instanceof LmsApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

/** Human label for a role: drives both the table cell and the dropdown. */
const ROLE_LABELS: Record<InstructorRole, string> = {
	lead: "Lead",
	co: "Co",
	ta: "TA",
};

export function formatRole(role: InstructorRole): string {
	return ROLE_LABELS[role];
}

/** Best-effort user label: name → email → userId. */
export function userLabel(item: InstructorListItem): string {
	if (item.userName && item.userName.length > 0) return item.userName;
	if (item.userEmail && item.userEmail.length > 0) return item.userEmail;
	return item.userId;
}

/** Best-effort course label: title → courseId. */
export function courseLabel(item: InstructorListItem): string {
	if (item.courseTitle && item.courseTitle.length > 0) return item.courseTitle;
	return item.courseId;
}

/**
 * Render one assignment as "React Fundamentals (lead)". Wireframe-driven
 * — the lowercase role reads as prose next to the title.
 */
export function formatAssignment(item: InstructorListItem): string {
	return `${courseLabel(item)} (${item.role})`;
}

/** Summary for the collapsed user row: "Course A (lead), Course B (co)". */
export function formatCoursesSummary(items: InstructorListItem[]): string {
	if (items.length === 0) return "—";
	return items.map(formatAssignment).join(", ");
}

/**
 * Group a flat assignment list by `userId` — the list route returns rows in
 * no guaranteed order, so the page sorts users by their display label and
 * sorts each user's assignments by course label. Deterministic ordering is
 * why this is a pure helper separate from the component.
 */
export function groupByUser(items: InstructorListItem[]): InstructorGroup[] {
	const byUser = new Map<string, InstructorGroup>();
	for (const item of items) {
		const existing = byUser.get(item.userId);
		if (existing) {
			existing.assignments.push(item);
			continue;
		}
		const group: InstructorGroup = {
			userId: item.userId,
			label: userLabel(item),
			assignments: [item],
		};
		if (item.userEmail) group.email = item.userEmail;
		byUser.set(item.userId, group);
	}
	const groups = Array.from(byUser.values());
	for (const g of groups) {
		g.assignments.sort((a, b) => courseLabel(a).localeCompare(courseLabel(b), "en"));
	}
	groups.sort((a, b) => a.label.localeCompare(b.label, "en"));
	return groups;
}

export function InstructorsPage(): ReactElement {
	const api = useMemo(() => createApiClient(), []);
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [expanded, setExpanded] = useState<string | null>(null);
	const [showAssign, setShowAssign] = useState(false);

	const load = useCallback(async () => {
		setState({ kind: "loading" });
		try {
			const page = await api.instructors.list();
			setState({ kind: "ready", items: page.items });
		} catch (err) {
			setState({ kind: "error", message: formatError(err) });
		}
	}, [api]);

	useEffect(() => {
		void load();
	}, [load]);

	const onAssigned = useCallback(() => {
		setShowAssign(false);
		void load();
	}, [load]);

	const onRemoved = useCallback(() => {
		void load();
	}, [load]);

	const toggleRow = useCallback((userId: string) => {
		setExpanded((prev) => (prev === userId ? null : userId));
	}, []);

	return (
		<section style={pageStyle}>
			<header style={headerStyle}>
				<div style={headerRowStyle}>
					<h1 style={pageTitleStyle}>Instructors</h1>
					<button type="button" onClick={() => setShowAssign(true)} style={primaryButtonStyle}>
						+ Assign instructor
					</button>
				</div>
				<p style={subtitleStyle}>Manage who teaches each course. Admin-only.</p>
			</header>

			{state.kind === "loading" ? (
				<LoadingBanner />
			) : state.kind === "error" ? (
				<ErrorBanner message={state.message} onRetry={() => void load()} />
			) : state.items.length === 0 ? (
				<EmptyState message="No instructors assigned yet. Use “Assign instructor” to grant someone a role on a course." />
			) : (
				<InstructorsTable
					groups={groupByUser(state.items)}
					expanded={expanded}
					onToggle={toggleRow}
					api={api}
					onRemoved={onRemoved}
				/>
			)}

			{showAssign ? (
				<AssignModal onCancel={() => setShowAssign(false)} onAssigned={onAssigned} api={api} />
			) : null}
		</section>
	);
}

// ── Table + expanded drill-down ──────────────────────────────────────────────

interface InstructorsTableProps {
	groups: InstructorGroup[];
	expanded: string | null;
	onToggle: (userId: string) => void;
	api: Api;
	onRemoved: () => void;
}

function InstructorsTable({
	groups,
	expanded,
	onToggle,
	api,
	onRemoved,
}: InstructorsTableProps): ReactElement {
	return (
		<div style={tableWrapperStyle}>
			<table style={tableStyle}>
				<thead>
					<tr>
						<th style={thStyle}>User</th>
						<th style={thStyle}>Courses (role)</th>
						<th style={thActionStyle} aria-label="Expand" />
					</tr>
				</thead>
				<tbody>
					{groups.map((g) => (
						<InstructorUserRow
							key={g.userId}
							group={g}
							isExpanded={expanded === g.userId}
							onToggle={() => onToggle(g.userId)}
							api={api}
							onRemoved={onRemoved}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}

interface InstructorUserRowProps {
	group: InstructorGroup;
	isExpanded: boolean;
	onToggle: () => void;
	api: Api;
	onRemoved: () => void;
}

function InstructorUserRow({
	group,
	isExpanded,
	onToggle,
	api,
	onRemoved,
}: InstructorUserRowProps): ReactElement {
	return (
		<>
			<tr>
				<td style={tdStyle}>
					<div style={userCellStyle}>
						<span style={userNameStyle}>{group.label}</span>
						{group.email && group.email !== group.label ? (
							<span style={userEmailStyle}>{group.email}</span>
						) : null}
					</div>
				</td>
				<td style={tdStyle}>{formatCoursesSummary(group.assignments)}</td>
				<td style={tdActionStyle}>
					<button
						type="button"
						onClick={onToggle}
						aria-expanded={isExpanded}
						aria-controls={`instructor-${group.userId}-detail`}
						style={linkButtonStyle}
					>
						{isExpanded ? "Hide" : "Manage"}
					</button>
				</td>
			</tr>
			{isExpanded ? (
				<tr>
					<td colSpan={3} style={expandedCellStyle}>
						<AssignmentsDetail
							id={`instructor-${group.userId}-detail`}
							group={group}
							api={api}
							onRemoved={onRemoved}
						/>
					</td>
				</tr>
			) : null}
		</>
	);
}

interface AssignmentsDetailProps {
	id: string;
	group: InstructorGroup;
	api: Api;
	onRemoved: () => void;
}

function AssignmentsDetail({ id, group, api, onRemoved }: AssignmentsDetailProps): ReactElement {
	return (
		<div id={id} style={detailBoxStyle}>
			<table style={detailTableStyle}>
				<thead>
					<tr>
						<th style={detailThStyle}>Course</th>
						<th style={detailThStyle}>Role</th>
						<th style={detailThActionStyle} aria-label="Actions" />
					</tr>
				</thead>
				<tbody>
					{group.assignments.map((a) => (
						<AssignmentRow
							key={`${a.courseId}-${a.userId}`}
							assignment={a}
							api={api}
							onRemoved={onRemoved}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}

interface AssignmentRowProps {
	assignment: InstructorListItem;
	api: Api;
	onRemoved: () => void;
}

function AssignmentRow({ assignment, api, onRemoved }: AssignmentRowProps): ReactElement {
	const [removing, setRemoving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onRemove = async () => {
		if (removing) return;
		setError(null);
		setRemoving(true);
		try {
			await api.instructors.unset({
				courseId: assignment.courseId,
				userId: assignment.userId,
			});
			onRemoved();
		} catch (err) {
			setError(formatError(err));
			setRemoving(false);
		}
	};

	return (
		<tr>
			<td style={detailTdStyle}>{courseLabel(assignment)}</td>
			<td style={detailTdStyle}>{formatRole(assignment.role)}</td>
			<td style={detailTdActionStyle}>
				{error ? <span style={inlineErrorStyle}>{error}</span> : null}
				<button
					type="button"
					onClick={() => void onRemove()}
					disabled={removing}
					style={dangerButtonStyle}
				>
					{removing ? "Removing…" : "Remove"}
				</button>
			</td>
		</tr>
	);
}

// ── Assign modal ─────────────────────────────────────────────────────────────

interface AssignModalProps {
	onCancel: () => void;
	onAssigned: () => void;
	api: Api;
}

function AssignModal({ onCancel, onAssigned, api }: AssignModalProps): ReactElement {
	const [userId, setUserId] = useState("");
	const [courseId, setCourseId] = useState("");
	const [role, setRole] = useState<InstructorRole>("lead");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		setSubmitting(true);
		try {
			await api.instructors.set({
				userId: userId.trim(),
				courseId: courseId.trim(),
				role,
			});
			onAssigned();
		} catch (err) {
			setError(formatError(err));
			setSubmitting(false);
		}
	};

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="assign-instructor-title"
			style={modalOverlayStyle}
		>
			<form onSubmit={onSubmit} style={modalStyle}>
				<h2 id="assign-instructor-title" style={modalTitleStyle}>
					Assign instructor
				</h2>

				<label style={fieldLabelStyle}>
					User ID
					<input
						type="text"
						value={userId}
						onChange={(e) => setUserId(e.target.value)}
						required
						placeholder="user_…"
						style={inputStyle}
					/>
					<span style={hintStyle}>From the dashboard or student page URL.</span>
				</label>

				<label style={fieldLabelStyle}>
					Course ID
					<input
						type="text"
						value={courseId}
						onChange={(e) => setCourseId(e.target.value)}
						required
						placeholder="course_…"
						style={inputStyle}
					/>
					<span style={hintStyle}>The course detail page shows the ID at the top.</span>
				</label>

				<label style={fieldLabelStyle}>
					Role
					<select
						value={role}
						onChange={(e) => setRole(e.target.value as InstructorRole)}
						style={inputStyle}
					>
						<option value="lead">Lead</option>
						<option value="co">Co-instructor</option>
						<option value="ta">Teaching assistant</option>
					</select>
				</label>

				{error ? <div style={inlineErrorStyle}>{error}</div> : null}

				<div style={modalActionsStyle}>
					<button
						type="button"
						onClick={onCancel}
						disabled={submitting}
						style={secondaryButtonStyle}
					>
						Cancel
					</button>
					<button type="submit" disabled={submitting} style={primaryButtonStyle}>
						{submitting ? "Assigning…" : "Assign"}
					</button>
				</div>
			</form>
		</div>
	);
}

// ── Shared presentational pieces ─────────────────────────────────────────────

function LoadingBanner(): ReactElement {
	return (
		<div style={mutedBannerStyle} role="status" aria-live="polite">
			Loading instructors…
		</div>
	);
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
	return (
		<div role="alert" style={errorBannerStyle}>
			<div style={{ marginBlockEnd: "0.5rem" }}>Couldn't load instructors: {message}</div>
			<button type="button" onClick={onRetry} style={secondaryButtonStyle}>
				Retry
			</button>
		</div>
	);
}

function EmptyState({ message }: { message: string }): ReactElement {
	return <div style={emptyStateStyle}>{message}</div>;
}

// ── styles ───────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
	padding: "2rem",
	maxInlineSize: "64rem",
	marginInline: "auto",
	fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif",
	color: "#0f172a",
};

const headerStyle: CSSProperties = {
	marginBlockEnd: "1.5rem",
};

const headerRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "1rem",
	marginBlockEnd: "0.25rem",
};

const pageTitleStyle: CSSProperties = {
	fontSize: "1.5rem",
	marginBlock: 0,
};

const subtitleStyle: CSSProperties = {
	color: "#475569",
	marginBlockStart: 0,
};

const primaryButtonStyle: CSSProperties = {
	display: "inline-block",
	paddingBlock: "0.5rem",
	paddingInline: "1rem",
	borderRadius: "0.375rem",
	border: "none",
	backgroundColor: "#2563eb",
	color: "white",
	fontWeight: 600,
	cursor: "pointer",
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

const dangerButtonStyle: CSSProperties = {
	paddingBlock: "0.375rem",
	paddingInline: "0.75rem",
	borderRadius: "0.375rem",
	border: "1px solid #fecaca",
	backgroundColor: "white",
	color: "#991b1b",
	cursor: "pointer",
	fontSize: "0.875rem",
};

const linkButtonStyle: CSSProperties = {
	background: "none",
	border: "none",
	color: "#2563eb",
	fontWeight: 500,
	cursor: "pointer",
	padding: 0,
};

const tableWrapperStyle: CSSProperties = {
	border: "1px solid #e2e8f0",
	borderRadius: "0.5rem",
	overflow: "hidden",
	backgroundColor: "white",
};

const tableStyle: CSSProperties = {
	inlineSize: "100%",
	borderCollapse: "collapse",
	fontSize: "0.925rem",
};

const thStyle: CSSProperties = {
	textAlign: "start",
	paddingBlock: "0.625rem",
	paddingInline: "0.875rem",
	backgroundColor: "#f8fafc",
	borderBlockEnd: "1px solid #e2e8f0",
	fontWeight: 600,
	color: "#334155",
};

const thActionStyle: CSSProperties = {
	...thStyle,
	inlineSize: "6rem",
	textAlign: "end",
};

const tdStyle: CSSProperties = {
	paddingBlock: "0.625rem",
	paddingInline: "0.875rem",
	borderBlockStart: "1px solid #f1f5f9",
	verticalAlign: "top",
};

const tdActionStyle: CSSProperties = {
	...tdStyle,
	textAlign: "end",
};

const userCellStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "0.125rem",
};

const userNameStyle: CSSProperties = {
	fontWeight: 500,
};

const userEmailStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.8125rem",
};

const expandedCellStyle: CSSProperties = {
	paddingBlock: "0.5rem",
	paddingInline: "0.875rem",
	borderBlockStart: "1px solid #f1f5f9",
	backgroundColor: "#f8fafc",
};

const detailBoxStyle: CSSProperties = {
	border: "1px solid #e2e8f0",
	borderRadius: "0.375rem",
	backgroundColor: "white",
	overflow: "hidden",
};

const detailTableStyle: CSSProperties = {
	inlineSize: "100%",
	borderCollapse: "collapse",
	fontSize: "0.875rem",
};

const detailThStyle: CSSProperties = {
	textAlign: "start",
	paddingBlock: "0.5rem",
	paddingInline: "0.75rem",
	backgroundColor: "#f1f5f9",
	borderBlockEnd: "1px solid #e2e8f0",
	fontWeight: 600,
	color: "#334155",
};

const detailThActionStyle: CSSProperties = {
	...detailThStyle,
	inlineSize: "10rem",
	textAlign: "end",
};

const detailTdStyle: CSSProperties = {
	paddingBlock: "0.5rem",
	paddingInline: "0.75rem",
	borderBlockStart: "1px solid #f1f5f9",
};

const detailTdActionStyle: CSSProperties = {
	...detailTdStyle,
	textAlign: "end",
	display: "flex",
	justifyContent: "flex-end",
	gap: "0.5rem",
	alignItems: "center",
};

const modalOverlayStyle: CSSProperties = {
	position: "fixed",
	inset: 0,
	backgroundColor: "rgba(15, 23, 42, 0.45)",
	display: "grid",
	placeItems: "center",
	zIndex: 100,
};

const modalStyle: CSSProperties = {
	backgroundColor: "white",
	borderRadius: "0.5rem",
	padding: "1.5rem",
	inlineSize: "min(28rem, 90vw)",
	display: "grid",
	gap: "0.875rem",
	boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
};

const modalTitleStyle: CSSProperties = {
	fontSize: "1.25rem",
	marginBlock: 0,
};

const fieldLabelStyle: CSSProperties = {
	display: "grid",
	gap: "0.25rem",
	fontSize: "0.875rem",
	color: "#334155",
	fontWeight: 500,
};

const inputStyle: CSSProperties = {
	paddingBlock: "0.5rem",
	paddingInline: "0.625rem",
	borderRadius: "0.375rem",
	border: "1px solid #cbd5e1",
	fontSize: "0.925rem",
	backgroundColor: "white",
	color: "#0f172a",
};

const hintStyle: CSSProperties = {
	color: "#64748b",
	fontSize: "0.75rem",
};

const inlineErrorStyle: CSSProperties = {
	color: "#991b1b",
	fontSize: "0.875rem",
};

const modalActionsStyle: CSSProperties = {
	display: "flex",
	justifyContent: "flex-end",
	gap: "0.5rem",
	marginBlockStart: "0.25rem",
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
};

const emptyStateStyle: CSSProperties = {
	paddingBlock: "1rem",
	paddingInline: "1rem",
	border: "1px dashed #cbd5e1",
	borderRadius: "0.5rem",
	color: "#64748b",
	fontSize: "0.925rem",
};

export default InstructorsPage;
