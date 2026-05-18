/** @type {import('@lingui/conf').LinguiConfig} */
const config = {
	sourceLocale: "en",
	locales: [
		"en",
		"ar",
		"eu",
		"zh-CN",
		"zh-TW",
		"fr",
		"de",
		"ja",
		"ko",
		"pt-BR",
		"es-419",
		"pseudo",
	],
	pseudoLocale: "pseudo",
	catalogs: [
		{
			path: "<rootDir>/locales/{locale}/messages",
			include: [],
		},
	],
	format: "po",
};

module.exports = config;
