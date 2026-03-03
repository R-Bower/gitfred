#!/usr/bin/env osascript -l JavaScript
ObjC.import("stdlib");
ObjC.import("Foundation");
const app = Application.currentApplication();
app.includeStandardAdditions = true;

// Cache directory for API responses
const CACHE_DIR = "/tmp/alfred-gitfred-cache";
const CACHE_TTL_SECONDS = 120; // 2 minutes for search results

// Persistent storage for recently selected repos
const RECENTS_FILE = `${$.getenv("alfred_workflow_data")}/recent-public-repos.json`;

/** @returns {Array<{full_name: string, name: string, owner: string, html_url: string, stars: number, description: string, homepage: string}>} */
function getRecentRepos() {
	try {
		const fm = $.NSFileManager.defaultManager;
		if (!fm.fileExistsAtPath(RECENTS_FILE)) return [];
		const data = $.NSString.stringWithContentsOfFileEncodingError(RECENTS_FILE, $.NSUTF8StringEncoding, null);
		return JSON.parse(data.js);
	} catch (_e) {
		return [];
	}
}

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
	return [clean, camelCaseSeparated, str].join(" ") + " ";
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

/** @param {string} url */
function httpRequest(url) {
	const queryUrl = $.NSURL.URLWithString(url);
	const requestData = $.NSData.dataWithContentsOfURL(queryUrl);
	return $.NSString.alloc.initWithDataEncoding(requestData, $.NSUTF8StringEncoding).js;
}

/**
 * @param {string} url
 * @param {string[]} headers
 */
function httpRequestWithHeaders(url, headers) {
	let allHeaders = "";
	for (const line of headers) {
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

/** @param {string} isoDateStr */
function humanRelativeDate(isoDateStr) {
	const deltaMins = (Date.now() - new Date(isoDateStr).getTime()) / 1000 / 60;
	/** @type {"year"|"month"|"week"|"day"|"hour"|"minute"} */
	let unit;
	let delta;
	if (deltaMins < 60) {
		unit = "minute";
		delta = Math.floor(deltaMins);
	} else if (deltaMins < 60 * 24) {
		unit = "hour";
		delta = Math.floor(deltaMins / 60);
	} else if (deltaMins < 60 * 24 * 7) {
		unit = "day";
		delta = Math.floor(deltaMins / 60 / 24);
	} else if (deltaMins < 60 * 24 * 7 * 4) {
		unit = "week";
		delta = Math.floor(deltaMins / 60 / 24 / 7);
	} else if (deltaMins < 60 * 24 * 7 * 4 * 12) {
		unit = "month";
		delta = Math.floor(deltaMins / 60 / 24 / 7 / 4);
	} else {
		unit = "year";
		delta = Math.floor(deltaMins / 60 / 24 / 7 / 4 / 12);
	}
	const formatter = new Intl.RelativeTimeFormat("en", { style: "narrow", numeric: "auto" });
	const str = formatter.format(-delta, unit);
	return str.replace(/m(?= ago$)/, "min"); // "m" -> "min" (more distinguishable from "month")
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
 * @property {string[]} orgFilter
 */

/** @returns {GithubConfig[]} */
function getGithubConfigs() {
	const configs = [];

	// GitHub.com config (public search works without token)
	const ghToken = getGithubDotComToken();
	configs.push({
		name: "github.com",
		apiBase: "https://api.github.com",
		token: ghToken,
		orgFilter: parseOrgFilter($.getenv("github_org_filter")),
	});

	// Enterprise config (requires token)
	const enterpriseUrl = $.getenv("enterprise_url")?.trim();
	const enterpriseToken = getEnterpriseToken();
	if (enterpriseUrl && enterpriseToken) {
		configs.push({
			name: enterpriseUrl,
			apiBase: `https://${enterpriseUrl}/api/v3`,
			token: enterpriseToken,
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

/**
 * Fuzzy match: checks if all characters of query appear in order in target.
 * @param {string} query
 * @param {string} target
 * @returns {boolean}
 */
function fuzzyMatch(query, target) {
	let qi = 0;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) qi++;
	}
	return qi === query.length;
}

/** @type {AlfredRun} */
// biome-ignore lint/correctness/noUnusedVariables: Alfred run
function run(argv) {
	const query = argv[0];

	// GUARD empty query: show recents or placeholder
	if (!query) {
		const recents = getRecentRepos();
		if (recents.length === 0) {
			return JSON.stringify({ items: [{ title: "Waiting for query…", valid: false }] });
		}
		const forkOnClone = $.getenv("fork_on_clone") === "1";
		const cloneDepth = Number.parseInt($.getenv("clone_depth"));
		let cloneSubtitle = cloneDepth > 0 ? `⌃: Shallow Clone (depth ${cloneDepth})` : "⌃: Clone";
		if (forkOnClone) cloneSubtitle += " & Fork";
		const recentItems = recents.map((r) => {
			const secondUrl = r.homepage || r.html_url + "/releases";
			return {
				title: r.name,
				subtitle: `Recent  ·  ${r.owner}${r.description ? `  ·  ${r.description}` : ""}`,
				arg: r.html_url,
				quicklookurl: r.html_url,
				match: alfredMatcher(r.name) + alfredMatcher(r.owner) + alfredMatcher(r.full_name),
				variables: {
					recent_repo_full_name: r.full_name,
					recent_repo_name: r.name,
					recent_repo_owner: r.owner,
					recent_repo_html_url: r.html_url,
					recent_repo_description: r.description || "",
					recent_repo_homepage: r.homepage || "",
				},
				mods: {
					cmd: {
						arg: secondUrl,
						subtitle: `⌘: Open  "${secondUrl}"`,
					},
					ctrl: {
						subtitle: cloneSubtitle,
					},
				},
			};
		});
		return JSON.stringify({ items: recentItems, cache: { seconds: 5, loosereload: true } });
	}

	const configs = getGithubConfigs();
	const hasMultipleEndpoints = configs.length > 1;

	// Build requests for parallel fetch
	// DOCS https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#search-repositories
	const requests = [];
	for (const config of configs) {
		const headers = [
			"Accept: application/vnd.github.json",
			"X-GitHub-Api-Version: 2022-11-28",
		];
		if (config.token) {
			headers.push(`Authorization: BEARER ${config.token}`);
		}
		if (config.orgFilter.length > 0) {
			// Include org qualifier in query so the API returns results from the right org
			for (const org of config.orgFilter) {
				const orgQuery = query + ` org:${org}`;
				const apiUrl = config.apiBase + "/search/repositories?per_page=6&q=" + encodeURIComponent(orgQuery);
				requests.push({ url: apiUrl, headers, name: config.name, config });
			}
		} else {
			const apiUrl = config.apiBase + "/search/repositories?per_page=6&q=" + encodeURIComponent(query);
			requests.push({ url: apiUrl, headers, name: config.name, config });
		}
	}

	// Fetch all endpoints in parallel
	const responses = fetchParallel(requests);

	/** @type {GithubRepo[]} */
	const allRepos = [];

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

		// Tag repos with their source
		const taggedRepos = responseObj.items.map((/** @type {GithubRepo} */ repo) => ({
			...repo,
			_source: config.name,
		}));

		allRepos.push(...taggedRepos);
	}

	// GUARD no results (check recents too before giving up)
	if (allRepos.length === 0) {
		const recentsForEmpty = getRecentRepos();
		const qLower = query.toLowerCase();
		const matchedRecents = recentsForEmpty.filter(
			(r) => fuzzyMatch(qLower, r.full_name.toLowerCase()) || fuzzyMatch(qLower, (r.description || "").toLowerCase()),
		);
		if (matchedRecents.length === 0) {
			return JSON.stringify({
				items: [
					{
						title: "🚫 No results",
						subtitle: `No results found for '${query}'`,
						valid: false,
						mods: {
							shift: { valid: false },
							cmd: { valid: false },
							alt: { valid: false },
							ctrl: { valid: false },
						},
					},
				],
			});
		}
	}

	//───────────────────────────────────────────────────────────────────────────

	const forkOnClone = $.getenv("fork_on_clone") === "1";
	const cloneDepth = Number.parseInt($.getenv("clone_depth"));

	// Filter recents matching the query and prepend them (deduplicated)
	const recents = getRecentRepos();
	const queryLower = query.toLowerCase();
	const matchingRecents = recents.filter(
		(r) => fuzzyMatch(queryLower, r.full_name.toLowerCase()) || fuzzyMatch(queryLower, (r.description || "").toLowerCase()),
	);

	const apiFullNames = new Set(allRepos.map((r) => r.full_name));
	const recentItems = matchingRecents
		.filter((r) => !apiFullNames.has(r.full_name))
		.map((r) => {
			let cloneSub = cloneDepth > 0 ? `⌃: Shallow Clone (depth ${cloneDepth})` : "⌃: Clone";
			if (forkOnClone) cloneSub += " & Fork";
			const secondUrl = r.homepage || r.html_url + "/releases";
			return {
				title: r.name,
				subtitle: `Recent  ·  ${r.owner}${r.description ? `  ·  ${r.description}` : ""}`,
				arg: r.html_url,
				quicklookurl: r.html_url,
				match: alfredMatcher(r.name) + alfredMatcher(r.owner) + alfredMatcher(r.full_name),
				variables: {
					recent_repo_full_name: r.full_name,
					recent_repo_name: r.name,
					recent_repo_owner: r.owner,
					recent_repo_html_url: r.html_url,
					recent_repo_description: r.description || "",
					recent_repo_homepage: r.homepage || "",
				},
				mods: {
					cmd: { arg: secondUrl, subtitle: `⌘: Open  "${secondUrl}"` },
					ctrl: { subtitle: cloneSub },
				},
			};
		})
		.slice(0, 5);

	/** @type {AlfredItem[]} */
	const repos = allRepos.map((/** @type {GithubRepo} */ repo) => {
		// INFO `pushed_at` refers to commits only https://github.com/orgs/community/discussions/24442
		// CAVEAT `pushed_at` apparently also includes pushes via PR :(
		const lastUpdated = repo.pushed_at ? humanRelativeDate(repo.pushed_at) : "";

		let type = "";
		if (repo.fork) type += "🍴 ";
		if (repo.archived) type += "🗄️ ";

		const subtitleParts = [
			repo.owner.login,
			lastUpdated,
			repo.description,
		];
		// Show source indicator when using multiple endpoints
		if (hasMultipleEndpoints && repo._source) {
			const sourceLabel = repo._source === "github.com" ? "GH" : "GHE";
			subtitleParts.push(`[${sourceLabel}]`);
		}
		const subtitle = subtitleParts.filter(Boolean).join("  ·  ");

		let cloneSubtitle = cloneDepth > 0 ? `⌃: Shallow Clone (depth ${cloneDepth})` : "⌃: Clone";
		if (forkOnClone) cloneSubtitle += " & Fork";

		const secondUrl = repo.homepage || repo.html_url + "/releases";

		return {
			title: type + repo.name,
			subtitle: subtitle,
			arg: repo.html_url,
			match: alfredMatcher(repo.name) + alfredMatcher(repo.owner.login) + alfredMatcher(repo.full_name),
			quicklookurl: repo.html_url,
			variables: {
				recent_repo_full_name: repo.full_name,
				recent_repo_name: repo.name,
				recent_repo_owner: repo.owner.login,
				recent_repo_html_url: repo.html_url,
				recent_repo_description: repo.description || "",
				recent_repo_homepage: repo.homepage || "",
			},
			mods: {
				cmd: {
					arg: secondUrl,
					subtitle: `⌘: Open  "${secondUrl}"`,
				},
				ctrl: {
					subtitle: cloneSubtitle,
				},
			},
		};
	});

	return JSON.stringify({ items: [...recentItems, ...repos], cache: { seconds: 5, loosereload: true } });
}
