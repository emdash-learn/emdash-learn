import type { ComponentType } from "react";

import KnowledgeChecksPage from "./admin/KnowledgeChecksPage.js";
import OverviewPage from "./admin/OverviewPage.js";
import ReportsPage from "./admin/ReportsPage.js";
import SetupWizardPage from "./admin/SetupWizardPage.js";

export const pages: Record<string, ComponentType> = {
	"/": OverviewPage,
	"/checks": KnowledgeChecksPage,
	"/reports": ReportsPage,
	"/setup": SetupWizardPage,
};

export const widgets: Record<string, ComponentType> = {};
