/**
 * Ambient declaration for `.astro` component imports.
 *
 * Consuming Astro sites resolve these at build time via the Astro Vite
 * plugin. We only need the shape here so `tsc --noEmit` accepts
 * `src/astro/index.ts`'s import of `./QuizBlock.astro`.
 */
declare module "*.astro" {
	type Props = Record<string, unknown>;
	const Component: (props: Props) => unknown;
	export default Component;
	export type { Props };
}
