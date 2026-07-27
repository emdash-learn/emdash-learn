import type { PluginAdminPage, PluginCapability, PluginStorageConfig } from "emdash";

export const LEARN_CAPABILITIES: PluginCapability[] = ["content:read"];

export const LEARN_ADMIN_PAGES: PluginAdminPage[] = [
	{ path: "/", label: "Learn", icon: "graduation-cap" },
	{ path: "/checks", label: "Knowledge checks", icon: "list-checks" },
	{ path: "/reports", label: "Reports", icon: "chart-bar" },
	{ path: "/setup", label: "Setup", icon: "wand" },
];

export const LEARN_STORAGE: PluginStorageConfig = {
	course_content_index: {
		indexes: [
			"courseId",
			"stepId",
			["courseId", "stepType"],
			["stepType", "stepId"],
			["courseId", "stepType", "order"],
		],
		uniqueIndexes: ["stepId"],
	},
	assessment_drafts: {
		indexes: ["updatedAt"],
	},
	assessment_revisions: {
		indexes: ["checkId", "publishedAt"],
	},
	assessment_heads: {
		indexes: ["revisionId"],
	},
	engagement_observations: {
		indexes: ["day", "observedAt", "courseId", "type", ["day", "courseId"]],
	},
};

export const LEARN_BLOCK = {
	type: "learnKnowledgeCheck",
	label: "Knowledge check",
	icon: "list-checks",
	description: "Insert a published Knowledge Check with browser-local self-check results.",
	courseIdField: "courseId",
	checkIdField: "checkId",
} as const;

export const LEARN_PLUGIN_CONTRACT = {
	capabilities: LEARN_CAPABILITIES,
	adminPages: LEARN_ADMIN_PAGES,
	storage: LEARN_STORAGE,
	block: LEARN_BLOCK,
};
