/**
 * Site-side Astro rendering entry. Native plugins export `blockComponents` to
 * tell emdash how to render custom Portable Text block types on the public
 * site.
 *
 * T16 ships the `lmsQuiz` block renderer (see `./QuizBlock.astro`). Future
 * block types register here.
 */
import QuizBlock from "./QuizBlock.astro";

export const blockComponents: Record<string, unknown> = {
	lmsQuiz: QuizBlock,
};
