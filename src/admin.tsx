import type { ComponentType, ReactElement } from "react";

function SetupWizardStub(): ReactElement {
	return (
		<section style={{ padding: "2rem", maxWidth: "42rem" }}>
			<h1>Emdash Learn — Setup</h1>
			<p>
				The setup wizard is not wired up yet. It will land in task <code>T01</code>
				(see <code>prd-plugin.md</code> §26).
			</p>
			<p>
				If you can see this page, the plugin's descriptor, admin entry, and sidebar
				registration are all working.
			</p>
		</section>
	);
}

export const pages: Record<string, ComponentType> = {
	"/setup": SetupWizardStub,
};

export const widgets: Record<string, ComponentType> = {};
