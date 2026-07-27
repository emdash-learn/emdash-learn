import type { QueryOptions, StorageCollection, WhereValue } from "emdash";

function comparison(value: unknown, bound: string | number): number | null {
	if (typeof value === "number" && typeof bound === "number") return value - bound;
	if (typeof value === "string" && typeof bound === "string") {
		if (value === bound) return 0;
		return value > bound ? 1 : -1;
	}
	return null;
}

function matches(value: unknown, filter: WhereValue): boolean {
	if (typeof filter !== "object" || filter === null) return value === filter;
	if ("in" in filter) {
		return (typeof value === "string" || typeof value === "number") && filter.in.includes(value);
	}
	if ("startsWith" in filter) {
		return typeof value === "string" && value.startsWith(filter.startsWith);
	}
	const gt = filter.gt === undefined ? null : comparison(value, filter.gt);
	const gte = filter.gte === undefined ? null : comparison(value, filter.gte);
	const lt = filter.lt === undefined ? null : comparison(value, filter.lt);
	const lte = filter.lte === undefined ? null : comparison(value, filter.lte);
	return (
		(filter.gt === undefined || (gt !== null && gt > 0)) &&
		(filter.gte === undefined || (gte !== null && gte >= 0)) &&
		(filter.lt === undefined || (lt !== null && lt < 0)) &&
		(filter.lte === undefined || (lte !== null && lte <= 0))
	);
}

export function createMemoryStorageCollection<T>(): StorageCollection<T> & {
	documents: Map<string, T>;
} {
	const documents = new Map<string, T>();
	return {
		documents,
		async get(id) {
			const value = documents.get(id);
			return value === undefined ? null : structuredClone(value);
		},
		async put(id, data) {
			documents.set(id, structuredClone(data));
		},
		async delete(id) {
			return documents.delete(id);
		},
		async exists(id) {
			return documents.has(id);
		},
		async getMany(ids) {
			return new Map(
				ids.flatMap((id) => {
					const value = documents.get(id);
					return value === undefined ? [] : [[id, structuredClone(value)]];
				}),
			);
		},
		async putMany(items) {
			for (const item of items) documents.set(item.id, structuredClone(item.data));
		},
		async deleteMany(ids) {
			let deleted = 0;
			for (const id of ids) {
				if (documents.delete(id)) deleted += 1;
			}
			return deleted;
		},
		async query(options: QueryOptions = {}) {
			const matchesWhere = [...documents.entries()].filter(([, data]) =>
				Object.entries(options.where ?? {}).every(([field, filter]) =>
					matches(
						typeof data === "object" && data !== null ? Reflect.get(data, field) : undefined,
						filter,
					),
				),
			);
			const offset = Number(options.cursor ?? "0");
			const limit = options.limit ?? 50;
			const items = matchesWhere.slice(offset, offset + limit).map(([id, data]) => ({
				id,
				data: structuredClone(data),
			}));
			const nextOffset = offset + items.length;
			return {
				items,
				hasMore: nextOffset < matchesWhere.length,
				...(nextOffset < matchesWhere.length ? { cursor: String(nextOffset) } : {}),
			};
		},
		async count(where) {
			return (await this.query({ where, limit: 1000 })).items.length;
		},
	};
}
