/**
 * QuizBlock — admin-side inline preview for the `lmsQuiz` Portable Text block.
 *
 * Ships alongside T16 (see prd-plugin.md §21 Phase 3). T16's core deliverable
 * is the slash-command registration (via `admin.portableTextBlocks` in
 * `sandbox-entry.ts`) plus the site-side Astro renderer. This file is a
 * minimal placeholder so T21's authoring UI has a landing spot — emdash
 * does not currently wire React components in the editor for plugin-provided
 * PT block types (see `PluginAdminExports` in emdash's types), so the
 * component is exported but not yet registered anywhere.
 */

import type { ReactElement } from "react";

interface QuizBlockProps {
	node: { _type: "lmsQuiz"; _key?: string; quizId: string };
}

export function QuizBlock({ node }: QuizBlockProps): ReactElement {
	return (
		<div className="lms-quiz-block-preview" data-quiz-id={node.quizId}>
			<strong>Quiz:</strong> {node.quizId || "(unset)"}
		</div>
	);
}

export default QuizBlock;
