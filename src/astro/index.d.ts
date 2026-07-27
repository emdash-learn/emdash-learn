import type { AstroComponentFactory } from "astro/runtime/server/index.js";

export interface KnowledgeCheckNode {
	_type: "learnKnowledgeCheck";
	_key?: string;
	courseId: string;
	checkId: string;
}

export interface KnowledgeCheckBlockProps {
	node: KnowledgeCheckNode;
}

export declare const KnowledgeCheckBlock: AstroComponentFactory;
export declare const blockComponents: Record<string, AstroComponentFactory>;
