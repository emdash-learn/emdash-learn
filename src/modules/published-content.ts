import { PluginRouteError, type PluginContext } from "emdash";

import { LEARN_ERRORS } from "../constants.js";

export type RuntimeContentItem = NonNullable<
	Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>
>;

export interface PublishedSeo {
	title: string | null;
	description: string | null;
	image: string | null;
	canonical: string | null;
	noIndex: boolean;
}

export function requireContent(ctx: PluginContext): NonNullable<PluginContext["content"]> {
	if (ctx.content) return ctx.content;
	throw new PluginRouteError(
		LEARN_ERRORS.SETUP_INCOMPLETE,
		"Content access is unavailable. Configure the Learn content collections before using its public routes.",
		409,
	);
}

export function optionalPublishedString(
	data: Record<string, unknown>,
	field: string,
): string | undefined {
	const value = data[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalPublishedNumber(
	data: Record<string, unknown>,
	field: string,
): number | undefined {
	const value = data[field];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableStringField(value: unknown, key: string): string | null | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "string" || field === null ? field : undefined;
}

export function publishedSeo(value: unknown): PublishedSeo | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const title = nullableStringField(value, "title");
	const description = nullableStringField(value, "description");
	const image = nullableStringField(value, "image");
	const canonical = nullableStringField(value, "canonical");
	const noIndex = Reflect.get(value, "noIndex");
	if (
		title === undefined ||
		description === undefined ||
		image === undefined ||
		canonical === undefined ||
		typeof noIndex !== "boolean"
	) {
		return undefined;
	}
	return { title, description, image, canonical, noIndex };
}

function hasPublishedBase(item: RuntimeContentItem): boolean {
	return (
		item.status === "published" &&
		typeof item.id === "string" &&
		item.id.length > 0 &&
		(item.slug === null || typeof item.slug === "string") &&
		(item.locale === null || typeof item.locale === "string") &&
		typeof item.data === "object" &&
		item.data !== null &&
		typeof item.updatedAt === "string" &&
		item.updatedAt.length > 0 &&
		typeof item.publishedAt === "string" &&
		item.publishedAt.length > 0
	);
}

export function isPublishedCourseContent(
	item: RuntimeContentItem,
	expectedCourseId?: string,
): boolean {
	if (expectedCourseId !== undefined && item.id !== expectedCourseId) return false;
	if (!hasPublishedBase(item)) return false;
	return optionalPublishedString(item.data, "title") !== undefined;
}
