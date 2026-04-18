/**
 * Admin entry — emdash imports `pages` and `widgets` from this module and
 * mounts each component at `/_emdash/admin/plugins/lms-core/<path>`.
 *
 * T01 only ships the Setup wizard. Subsequent tasks (T19–T25) register their
 * own React pages and wire them through `src/admin/*.tsx`.
 */

import type { ComponentType } from "react";

import CoursePage from "./admin/CoursePage.js";
import SetupWizardPage from "./admin/SetupWizardPage.js";

export const pages: Record<string, ComponentType> = {
	"/courses/:courseId": CoursePage,
	"/setup": SetupWizardPage,
};

export const widgets: Record<string, ComponentType> = {};
