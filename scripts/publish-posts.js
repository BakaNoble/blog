import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const inboxDir = path.join(rootDir, "publish-inbox");
const postsDir = path.join(rootDir, "src", "content", "posts");
const archiveDir = path.join(inboxDir, "_published");
const configPath = path.join(rootDir, "publish.config.json");
const dryRun = process.argv.includes("--dry-run");

function fail(message) {
	console.error(`\nError: ${message}`);
	process.exit(1);
}

function run(command, args, options = {}) {
	console.log(`\n> ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: rootDir,
		encoding: "utf8",
		stdio: "inherit",
		...options,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`Command failed with exit code ${result.status}.`);
	}
}

function capture(command, args) {
	const result = spawnSync(command, args, {
		cwd: rootDir,
		encoding: "utf8",
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			result.stderr?.trim() || result.error?.message || `Failed: ${command}`,
		);
	}
	return result.stdout.trim();
}

function getDate() {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function getTimestamp() {
	const now = new Date();
	const date = getDate().replaceAll("-", "");
	const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
		.map((value) => String(value).padStart(2, "0"))
		.join("");
	return `${date}-${time}`;
}

function normalizeSlug(name) {
	return name
		.normalize("NFKC")
		.replace(/\.md$/i, "")
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, "-")
		.replace(/[^\p{Letter}\p{Number}-]+/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function stripMarkdown(value) {
	return value
		.replace(/```[\s\S]*?```/g, "")
		.replace(/!\[[^\]]*]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
		.replace(/[*_`>#-]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function deriveTitle(body, fallback) {
	const heading = body.match(/^#\s+(.+)$/m);
	return heading ? stripMarkdown(heading[1]) : fallback;
}

function deriveDescription(body) {
	const paragraphs = body
		.replace(/^---[\s\S]*?---\s*/m, "")
		.replace(/^#.+$/gm, "")
		.split(/\r?\n\s*\r?\n/)
		.map(stripMarkdown)
		.filter((value) => value && !value.startsWith("http"));
	return (paragraphs[0] || "").slice(0, 160);
}

function yamlString(value) {
	return JSON.stringify(value);
}

function hasFrontmatterField(frontmatter, key) {
	return new RegExp(`^${key}\\s*:`, "m").test(frontmatter);
}

function getFrontmatterValue(frontmatter, key) {
	const match = frontmatter.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, "m"));
	return match?.[1]?.trim() || "";
}

function fieldNeedsValue(frontmatter, key) {
	if (!hasFrontmatterField(frontmatter, key)) {
		return true;
	}
	const value = getFrontmatterValue(frontmatter, key);
	return value === "" || value === '""' || value === "''" || value === "[]";
}

function loadPublishConfig() {
	if (!existsSync(configPath)) {
		throw new Error(
			"publish.config.json is required when AI metadata generation is needed. Copy publish.config.example.json and add your Anthropic API key.",
		);
	}

	let config;
	try {
		config = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(
			`Cannot parse publish.config.json: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const anthropic = config.anthropic;
	if (!anthropic?.apiKey || !anthropic?.model) {
		throw new Error(
			"publish.config.json must contain anthropic.apiKey and anthropic.model.",
		);
	}
	return {
		apiKey: anthropic.apiKey,
		model: anthropic.model,
		baseUrl: (anthropic.baseUrl || "https://api.anthropic.com").replace(
			/\/+$/,
			"",
		),
		maxTokens: anthropic.maxTokens || 1024,
		timeoutMs: anthropic.timeoutMs || 60000,
	};
}

function validateAiMetadata(value) {
	if (!value || typeof value !== "object") {
		throw new Error("Anthropic returned invalid metadata.");
	}
	if (typeof value.title !== "string" || !value.title.trim()) {
		throw new Error("Anthropic did not return a valid title.");
	}
	if (typeof value.description !== "string" || !value.description.trim()) {
		throw new Error("Anthropic did not return a valid description.");
	}
	if (
		!Array.isArray(value.tags) ||
		value.tags.length === 0 ||
		value.tags.some((tag) => typeof tag !== "string" || !tag.trim())
	) {
		throw new Error("Anthropic did not return valid tags.");
	}
	if (typeof value.category !== "string" || !value.category.trim()) {
		throw new Error("Anthropic did not return a valid category.");
	}
	return {
		title: value.title.trim(),
		description: value.description.trim().slice(0, 200),
		tags: [
			...new Set(value.tags.map((tag) => tag.trim()).filter(Boolean)),
		].slice(0, 8),
		category: value.category.trim(),
	};
}

async function requestAiMetadata(body, fallbackTitle) {
	const config = loadPublishConfig();
	const response = await fetch(`${config.baseUrl}/v1/messages`, {
		method: "POST",
		signal: AbortSignal.timeout(config.timeoutMs),
		headers: {
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
			"x-api-key": config.apiKey,
		},
		body: JSON.stringify({
			model: config.model,
			max_tokens: config.maxTokens,
			temperature: 0,
			tools: [
				{
					name: "generate_blog_metadata",
					description:
						"Generate concise frontmatter metadata for a Chinese personal technology blog post.",
					strict: true,
					input_schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							title: {
								type: "string",
								description: "Natural Chinese article title without Markdown.",
							},
							description: {
								type: "string",
								description:
									"One concise Chinese summary, ideally 50-120 Chinese characters.",
							},
							tags: {
								type: "array",
								minItems: 2,
								maxItems: 8,
								items: { type: "string" },
								description: "Specific technology or topic tags.",
							},
							category: {
								type: "string",
								description:
									"One broad Chinese category such as 项目、建站、运维、网络、AI or 随笔.",
							},
						},
						required: ["title", "description", "tags", "category"],
					},
				},
			],
			tool_choice: {
				type: "tool",
				name: "generate_blog_metadata",
			},
			messages: [
				{
					role: "user",
					content: `Analyze this Markdown article and generate frontmatter metadata. Preserve the article's actual topic and terminology. Do not invent facts.

Fallback filename title: ${fallbackTitle}

Article:
${body.slice(0, 50000)}`,
				},
			],
		}),
	});

	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		const message =
			payload?.error?.message || `${response.status} ${response.statusText}`;
		throw new Error(`Anthropic API request failed: ${message}`);
	}

	const toolUse = payload?.content?.find(
		(item) =>
			item.type === "tool_use" && item.name === "generate_blog_metadata",
	);
	if (!toolUse) {
		throw new Error("Anthropic response did not contain generated metadata.");
	}
	return validateAiMetadata(toolUse.input);
}

async function prepareMarkdown(filePath, fallbackTitle) {
	const original = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
	const frontmatterMatch = original.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	let frontmatter = frontmatterMatch?.[1] || "";
	let body = frontmatterMatch
		? original.slice(frontmatterMatch[0].length)
		: original;
	const aiFields = ["title", "description", "tags", "category"];
	const needsAi = aiFields.some((key) => fieldNeedsValue(frontmatter, key));
	let aiMetadata;
	if (needsAi) {
		console.log(`\nRequesting Anthropic metadata for ${fallbackTitle}...`);
		aiMetadata = await requestAiMetadata(body, fallbackTitle);
	}

	const title = fieldNeedsValue(frontmatter, "title")
		? aiMetadata?.title || deriveTitle(body, fallbackTitle)
		: getFrontmatterValue(frontmatter, "title").replace(/^["']|["']$/g, "");

	const fields = [
		["title", yamlString(title)],
		["published", getDate()],
		[
			"description",
			yamlString(aiMetadata?.description || deriveDescription(body)),
		],
		["tags", yamlString(aiMetadata?.tags || [])],
		["category", yamlString(aiMetadata?.category || "")],
		["draft", "false"],
	];

	for (const [key, value] of fields) {
		if (fieldNeedsValue(frontmatter, key)) {
			const fieldPattern = new RegExp(`^${key}\\s*:.*$`, "m");
			if (fieldPattern.test(frontmatter)) {
				frontmatter = frontmatter.replace(fieldPattern, `${key}: ${value}`);
				continue;
			}
			frontmatter += `${frontmatter ? "\n" : ""}${key}: ${value}`;
		}
	}

	const firstHeading = body.match(/^#\s+(.+)\r?\n+/);
	if (firstHeading && stripMarkdown(firstHeading[1]) === title) {
		body = body.slice(firstHeading[0].length);
	}

	writeFileSync(
		filePath,
		`---\n${frontmatter.trim()}\n---\n\n${body.trim()}\n`,
		"utf8",
	);
	return title;
}

function findInboxEntries() {
	if (!existsSync(inboxDir)) {
		mkdirSync(inboxDir, { recursive: true });
	}

	return readdirSync(inboxDir, { withFileTypes: true }).filter((entry) => {
		if (entry.name.startsWith(".") || entry.name.startsWith("_")) {
			return false;
		}
		if (entry.isDirectory()) {
			return existsSync(path.join(inboxDir, entry.name, "index.md"));
		}
		return entry.isFile() && /\.md$/i.test(entry.name);
	});
}

function ensureCleanWorktree() {
	const status = capture("git", ["status", "--porcelain"]);
	if (status) {
		fail(
			"Git worktree is not clean. Commit or stash existing changes before publishing.",
		);
	}
}

async function importEntries(entries, imported) {
	mkdirSync(postsDir, { recursive: true });

	for (const entry of entries) {
		const sourcePath = path.join(inboxDir, entry.name);
		const slug = normalizeSlug(entry.name);
		if (!slug) {
			throw new Error(`Cannot derive a valid slug from "${entry.name}".`);
		}

		if (entry.isDirectory()) {
			const targetPath = path.join(postsDir, slug);
			if (existsSync(targetPath)) {
				throw new Error(
					`Post target already exists: ${path.relative(rootDir, targetPath)}`,
				);
			}
			cpSync(sourcePath, targetPath, { recursive: true });
			imported.push({ sourcePath, targetPath });
			const markdownPath = path.join(targetPath, "index.md");
			const title = await prepareMarkdown(markdownPath, entry.name);
			Object.assign(imported.at(-1), { markdownPath, title });
			continue;
		}

		const extension = path.extname(entry.name).toLowerCase();
		const targetPath = path.join(postsDir, `${slug}${extension}`);
		if (existsSync(targetPath)) {
			throw new Error(
				`Post target already exists: ${path.relative(rootDir, targetPath)}`,
			);
		}
		cpSync(sourcePath, targetPath);
		imported.push({ sourcePath, targetPath });
		const title = await prepareMarkdown(
			targetPath,
			path.basename(entry.name, extension),
		);
		Object.assign(imported.at(-1), {
			markdownPath: targetPath,
			title,
		});
	}

	return imported;
}

function rollback(imported) {
	for (const item of imported) {
		if (existsSync(item.targetPath)) {
			rmSync(item.targetPath, { recursive: true, force: true });
		}
	}
}

function archiveSources(imported) {
	const destination = path.join(archiveDir, getTimestamp());
	mkdirSync(destination, { recursive: true });
	for (const item of imported) {
		renameSync(
			item.sourcePath,
			path.join(destination, path.basename(item.sourcePath)),
		);
	}
	console.log(
		`\nOriginal files archived to ${path.relative(rootDir, destination)}`,
	);
}

async function main() {
	const imported = [];
	let committed = false;
	let relativeTargets = [];
	try {
		if (!dryRun) {
			ensureCleanWorktree();
		}
		const entries = findInboxEntries();
		if (entries.length === 0) {
			throw new Error(
				"publish-inbox contains no .md files or post folders with index.md.",
			);
		}

		await importEntries(entries, imported);
		const biomeCli = path.join(
			rootDir,
			"node_modules",
			"@biomejs",
			"biome",
			"bin",
			"biome",
		);
		const astroCli = path.join(rootDir, "node_modules", "astro", "astro.js");

		run(process.execPath, [biomeCli, "check", "./src"]);
		run(process.execPath, [astroCli, "check"]);
		run(process.execPath, [astroCli, "build"]);

		if (dryRun) {
			rollback(imported);
			console.log(
				`\nDry run passed for ${imported.length} post(s). Nothing was committed or pushed.`,
			);
			return;
		}

		relativeTargets = imported.map((item) =>
			path.relative(rootDir, item.targetPath),
		);
		const branch = capture("git", ["branch", "--show-current"]);
		if (!branch) {
			throw new Error("Cannot publish from a detached Git HEAD.");
		}

		run("git", ["add", "--", ...relativeTargets]);

		const commitTitle =
			imported.length === 1
				? `Publish post: ${imported[0].title}`
				: `Publish ${imported.length} posts`;
		run("git", ["commit", "-m", commitTitle]);
		committed = true;

		run("git", ["push", "origin", branch]);
		archiveSources(imported);
		console.log(`\nPublished ${imported.length} post(s) successfully.`);
	} catch (error) {
		if (!committed) {
			if (relativeTargets.length > 0) {
				spawnSync("git", ["reset", "--", ...relativeTargets], {
					cwd: rootDir,
					stdio: "ignore",
				});
			}
			rollback(imported);
		}
		fail(error instanceof Error ? error.message : String(error));
	}
}

await main();
