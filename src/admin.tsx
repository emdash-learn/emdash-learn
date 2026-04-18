/**
 * Admin entry — emdash imports `pages` and `widgets` from this module and
 * mounts each component at `/_emdash/admin/plugins/lms-core/<path>`.
 *
 * T01 only ships the Setup wizard. Subsequent tasks (T19–T25) register their
 * own React pages and wire them through `src/admin/*.tsx`.
 */

import type { ComponentType } from "react";

import CohortDetailPage from "./admin/CohortDetailPage.js";
import CohortsPage from "./admin/CohortsPage.js";
import DashboardPage from "./admin/DashboardPage.js";
import InstructorsPage from "./admin/InstructorsPage.js";
import SettingsPage from "./admin/SettingsPage.js";
import SetupWizardPage from "./admin/SetupWizardPage.js";

export const pages: Record<string, ComponentType> = {
	"/": DashboardPage,
	"/cohorts": CohortsPage,
	"/cohorts/:cohortId": CohortDetailPage,
	"/instructors": InstructorsPage,
	"/settings": SettingsPage,
	"/setup": SetupWizardPage,
};

export const widgets: Record<string, ComponentType> = {};
