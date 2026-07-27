import type { CSSProperties, ReactElement } from "react";

const links = [
	{
		title: "Courses",
		description: "Create, edit, and publish course records in the EmDash content editor.",
		href: "/_emdash/admin/content/courses",
		action: "Open courses",
	},
	{
		title: "Lessons",
		description: "Author lesson content and connect each lesson to its course.",
		href: "/_emdash/admin/content/lessons",
		action: "Open lessons",
	},
	{
		title: "Knowledge checks",
		description: "Author drafts, publish immutable revisions, and archive public checks.",
		href: "/_emdash/admin/plugins/lms-core/checks",
		action: "Manage checks",
	},
	{
		title: "Reports",
		description: "Review aggregate course engagement, completions, attempts, and score bands.",
		href: "/_emdash/admin/plugins/lms-core/reports",
		action: "View reports",
	},
	{
		title: "Setup",
		description: "Provision or verify the course and lesson collections required by the plugin.",
		href: "/_emdash/admin/plugins/lms-core/setup",
		action: "Review setup",
	},
] as const;

export function OverviewPage(): ReactElement {
	return (
		<section style={pageStyle}>
			<header>
				<p style={eyebrowStyle}>EmDash Learn</p>
				<h1 style={titleStyle}>Publish structured learning content</h1>
				<p style={introStyle}>
					EmDash owns course and lesson content. Learn adds a public course-reading API and
					Knowledge Checks, account-linked progress, private device progress, and aggregate
					engagement reporting.
				</p>
			</header>

			<div style={gridStyle}>
				{links.map((link) => (
					<article key={link.title} style={cardStyle}>
						<h2 style={cardTitleStyle}>{link.title}</h2>
						<p style={cardTextStyle}>{link.description}</p>
						<a href={link.href} style={linkStyle}>
							{link.action} →
						</a>
					</article>
				))}
			</div>

			<aside style={noteStyle}>
				<strong>EmDash owns identity.</strong> Learn uses the verified EmDash session for progress
				and attempts; it never collects passwords, phone numbers, or a separate learner profile.
			</aside>
		</section>
	);
}

const pageStyle: CSSProperties = {
	maxWidth: "72rem",
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
	lineHeight: 1.2,
};

const introStyle: CSSProperties = {
	maxWidth: "48rem",
	marginBlockEnd: "2rem",
	color: "#475569",
	lineHeight: 1.65,
};

const gridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
	gap: "1rem",
};

const cardStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	minHeight: "11rem",
	padding: "1.25rem",
	border: "1px solid #e2e8f0",
	borderRadius: "0.75rem",
	background: "#fff",
};

const cardTitleStyle: CSSProperties = {
	margin: 0,
	fontSize: "1.05rem",
};

const cardTextStyle: CSSProperties = {
	flex: 1,
	color: "#64748b",
	fontSize: "0.9rem",
	lineHeight: 1.55,
};

const linkStyle: CSSProperties = {
	color: "#4338ca",
	fontWeight: 650,
	textDecoration: "none",
};

const noteStyle: CSSProperties = {
	marginBlockStart: "1.5rem",
	padding: "1rem 1.25rem",
	borderRadius: "0.75rem",
	background: "#f8fafc",
	color: "#475569",
	fontSize: "0.9rem",
	lineHeight: 1.5,
};

export default OverviewPage;
