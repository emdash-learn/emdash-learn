/**
 * Site-side Astro rendering entry. Native plugins export `blockComponents` to
 * tell emdash how to render custom Portable Text block types on the public
 * site.
 *
 * Wave 0 (T00) ships no block types — the quiz block lands in T16.
 */
export const blockComponents: Record<string, unknown> = {};
