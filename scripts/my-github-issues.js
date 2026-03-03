#!/usr/bin/env osascript -l JavaScript
ObjC.import("stdlib");
ObjC.import("Foundation");
const app = Application.currentApplication();
app.includeStandardAdditions = true;

// Cache directory for API responses
const CACHE_DIR = "/tmp/alfred-gitfred-cache";
const CACHE_TTL_SECONDS = 60; // 1 minute cache

/**
 * @param {string} cacheKey
 * @returns {string|null}
 */
function getCache(cacheKey) {
	const cachePath = `${CACHE_DIR}/${cacheKey}.json`;
	try {
		const fm = $.NSFileManager.defaultManager;
		if (!fm.fileExistsAtPath(cachePath)) return null;
		const attrs = fm.attributesOfItemAtPathError(cachePath, null);
		const modDate = attrs.objectForKey("NSFileModificationDate");
		const ageSeconds = -modDate.timeIntervalSinceNow;
		if (ageSeconds > CACHE_TTL_SECONDS) return null;
		console.log(`Cache hit for ${cacheKey} (${Math.round(ageSeconds)}s old)`);
		return app.doShellScript(`cat "${cachePath}"`);
	} catch (_e) {
		return null;
	}
}

/**
 * @param {string} cacheKey
 * @param {string} data
 */
function setCache(cacheKey, data) {
	try {
		app.doShellScript(`mkdir -p "${CACHE_DIR}"`);
		const cachePath = `${CACHE_DIR}/${cacheKey}.json`;
		const nsData = $.NSString.alloc.initWithUTF8String(data);
		nsData.writeToFileAtomicallyEncodingError(cachePath, true, $.NSUTF8StringEncoding, null);
	} catch (_e) {}
}

/** @param {string} url */
function cacheKeyFromUrl(url) {
	return url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 200);
}

//──────────────────────────────────────────────────────────────────────────────

/** @param {string} str */
function alfredMatcher(str) {
	const clean = str.replace(/[-()_.:#/\\;,[\]]/g, " ");
	const camelCaseSeparated = str.replace(/([A-Z])/g, " $1");
	return [clean, camelCaseSeparated, str].join(" ");
}

/**
 * @param {string} url
 * @param {string[]} header
 * @return {string} response
 */
function httpRequestWithHeaders(url, header) {
	let allHeaders = "";
	for (const line of header) {
		allHeaders += ` -H "${line}"`;
	}
	const curlRequest = `curl --silent --location --max-time 10 ${allHeaders} "${url}" || true`;
	console.log(curlRequest);
	return app.doShellScript(curlRequest);
}

/**
 * Fetch multiple URLs in parallel using background shell processes, with caching
 * @param {{url: string, headers: string[], name: string}[]} requests
 * @returns {{name: string, response: string}[]}
 */
function fetchParallel(requests) {
	if (requests.length === 0) return [];

	const results = requests.map((req) => {
		const cacheKey = cacheKeyFromUrl(req.url);
		const cached = getCache(cacheKey);
		return { name: req.name, response: cached, url: req.url, headers: req.headers, fromCache: !!cached };
	});

	const toFetch = results.filter((r) => !r.fromCache);
	if (toFetch.length === 0) {
		return results.map((r) => ({ name: r.name, response: r.response || "" }));
	}

	const timestamp = Date.now();
	const tempFiles = toFetch.map((_, i) => `/tmp/alfred_gh_${i}_${timestamp}.json`);

	const curlCommands = toFetch
		.map((req, i) => {
			let headerArgs = "";
			for (const h of req.headers) {
				headerArgs += ` -H "${h}"`;
			}
			return `curl --silent --location --max-time 10 ${headerArgs} "${req.url}" > "${tempFiles[i]}" 2>/dev/null &`;
		})
		.join("\n");

	console.log("Fetching: " + toFetch.map((r) => r.name).join(", "));
	app.doShellScript(`${curlCommands}\nwait`);

	for (let i = 0; i < toFetch.length; i++) {
		try {
			const response = app.doShellScript(`cat "${tempFiles[i]}" 2>/dev/null && rm -f "${tempFiles[i]}"`);
			toFetch[i].response = response;
			if (response) {
				try {
					const parsed = JSON.parse(response);
					if (!parsed.message) setCache(cacheKeyFromUrl(toFetch[i].url), response);
				} catch (_e) {}
			}
		} catch (_e) {
			toFetch[i].response = "";
		}
	}

	return results.map((r) => {
		if (r.fromCache) return { name: r.name, response: r.response || "" };
		const fetched = toFetch.find((f) => f.url === r.url);
		return { name: r.name, response: fetched?.response || "" };
	});
}

function getGithubDotComToken() {
	const tokenShellCmd = $.getenv("github_token_shell_cmd");
	const tokenFromZshenvCmd = "test -e $HOME/.zshenv && source $HOME/.zshenv ; echo $GITHUB_TOKEN";
	let githubToken = $.getenv("github_token_from_alfred_prefs").trim();
	if (!githubToken && tokenShellCmd) {
		githubToken = app.doShellScript(tokenShellCmd + " || true").trim();
		if (!githubToken) console.log("GitHub token shell command failed.");
	}
	if (!githubToken) githubToken = app.doShellScript(tokenFromZshenvCmd);
	return githubToken;
}

function getEnterpriseToken() {
	const tokenShellCmd = $.getenv("enterprise_token_shell_cmd")?.trim();
	let token = $.getenv("enterprise_token")?.trim();
	if (!token && tokenShellCmd) {
		token = app.doShellScript(tokenShellCmd + " || true").trim();
	}
	return token;
}

/** @param {string|undefined} orgFilterStr */
function parseOrgFilter(orgFilterStr) {
	if (!orgFilterStr) return [];
	return orgFilterStr
		.split(",")
		.map((org) => org.trim())
		.filter(Boolean);
}

/**
 * @typedef {Object} GithubConfig
 * @property {string} name
 * @property {string} apiBase
 * @property {string} token
 * @property {string} username
 * @property {string[]} orgFilter
 */

/** @returns {GithubConfig[]} */
function getGithubConfigs() {
	const configs = [];

	// GitHub.com config
	const ghToken = getGithubDotComToken();
	const ghUsername = $.getenv("github_username")?.trim();
	if (ghUsername) {
		configs.push({
			name: "github.com",
			apiBase: "https://api.github.com",
			token: ghToken,
			username: ghUsername,
			orgFilter: parseOrgFilter($.getenv("github_org_filter")),
		});
	}

	// Enterprise config
	const enterpriseUrl = $.getenv("enterprise_url")?.trim();
	const enterpriseToken = getEnterpriseToken();
	const enterpriseUsername = $.getenv("enterprise_username")?.trim();
	if (enterpriseUrl && enterpriseToken && enterpriseUsername) {
		configs.push({
			name: enterpriseUrl,
			apiBase: `https://${enterpriseUrl}/api/v3`,
			token: enterpriseToken,
			username: enterpriseUsername,
			orgFilter: parseOrgFilter($.getenv("enterprise_org_filter")),
		});
	}

	return configs;
}

/**
 * @template T
 * @param {T[]} items
 * @param {string[]} orgFilter
 * @param {(item: T) => string} getOwner
 * @returns {T[]}
 */
function filterByOrg(items, orgFilter, getOwner) {
	if (!orgFilter || orgFilter.length === 0) return items;
	return items.filter((item) => orgFilter.includes(getOwner(item)));
}

//──────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/correctness/noUnusedVariables: alfred_run
function run() {
	const includePrivate = $.getenv("include_private_issues") === "1";
	const configs = getGithubConfigs();

	// GUARD no config
	if (configs.length === 0) {
		return JSON.stringify({
			items: [{ title: "No GitHub username configured.", valid: false }],
		});
	}

	// Collect all configured usernames
	const configuredUsernames = configs.map((c) => c.username);
	const hasMultipleEndpoints = configs.length > 1;

	// DOCS https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28#list-issues-assigned-to-the-authenticated-user--parameters
	const issuesToSearch = 50; // up to 100, for performance set lower

	// Build requests for parallel fetch
	const requests = configs.map((config) => {
		const apiUrl = `${config.apiBase}/search/issues?q=involves:${config.username}&sort=updated&per_page=${issuesToSearch}`;
		const headers = ["Accept: application/vnd.github.json", "X-GitHub-Api-Version: 2022-11-28"];
		if (config.token && (includePrivate || config.name !== "github.com")) {
			headers.push(`Authorization: BEARER ${config.token}`);
		}
		return { url: apiUrl, headers, name: config.name, config };
	});

	// Fetch all endpoints in parallel
	const responses = fetchParallel(requests);

	/** @type {GithubIssue[]} */
	const allIssues = [];

	for (let i = 0; i < responses.length; i++) {
		const { name, response } = responses[i];
		const config = requests[i].config;

		if (!response) {
			console.log(`No response from ${name}`);
			continue;
		}

		let responseObj;
		try {
			responseObj = JSON.parse(response);
		} catch (_e) {
			console.log(`Invalid JSON from ${name}`);
			continue;
		}

		if (responseObj.message) {
			console.log(`Error from ${name}: ${responseObj.message}`);
			continue;
		}

		// Tag issues with their source
		const taggedIssues = responseObj.items.map((/** @type {GithubIssue} */ item) => ({
			...item,
			_source: config.name,
		}));

		// Apply org filter by extracting owner from repository_url
		const filteredIssues = filterByOrg(taggedIssues, config.orgFilter, (item) => {
			const match = item.repository_url.match(/repos\/([^/]+)\//);
			return match ? match[1] : "";
		});

		allIssues.push(...filteredIssues);
	}

	// GUARD no issues
	if (allIssues.length === 0) {
		return JSON.stringify({
			items: [{ title: "No issues found.", valid: false }],
		});
	}

	// Sort by updated_at descending
	allIssues.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

	const issues = allIssues.map((/** @type {GithubIssue} */ item) => {
		const issueAuthor = item.user.login;
		const repo = (item.repository_url.match(/[^/]+$/) || "")[0];
		const comments = item.comments > 0 ? "💬 " + item.comments.toString() : "";
		const labels = item.labels.map((label) => `[${label.name}]`).join(" ");

		const subtitleParts = [`#${item.number}`, repo, comments.toString(), labels];
		// Show source indicator when using multiple endpoints
		if (hasMultipleEndpoints && item._source) {
			const sourceLabel = item._source === "github.com" ? "GH" : "GHE";
			subtitleParts.push(`[${sourceLabel}]`);
		}
		const subtitle = subtitleParts.filter(Boolean).join("   ");

		// ICON
		let icon = configuredUsernames.includes(issueAuthor) ? "✏️ " : "";
		if (item.pull_request) {
			if (item.draft) icon += "⬜ ";
			else if (item.state === "open") icon += "🟩 ";
			else if (item.pull_request.merged_at) icon += "🟪 ";
			else icon += "🟥 ";
		} else {
			if (item.state === "open") icon += "🟢 ";
			else if (item.state_reason === "not_planned") icon += "⚪ ";
			else if (item.state_reason === "completed") icon += "🟣 ";
		}

		let matcher = alfredMatcher(item.title) + " " + alfredMatcher(repo) + " " + item.state;
		if (item.pull_request) matcher += " pr";
		else matcher += " issue";
		if (item.draft) matcher += " draft";
		if (hasMultipleEndpoints && item._source) matcher += " " + item._source;

		return {
			title: icon + item.title,
			subtitle: subtitle,
			match: matcher,
			arg: item.html_url,
			quicklookurl: item.html_url,
		};
	});
	return JSON.stringify({
		items: issues,
		cache: {
			seconds: 150, // fast to pick up recently created issues
			loosereload: true,
		},
	});
}
