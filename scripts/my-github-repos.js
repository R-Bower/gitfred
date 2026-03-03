#!/usr/bin/env osascript -l JavaScript
ObjC.import("stdlib");
ObjC.import("Foundation");
const app = Application.currentApplication();
app.includeStandardAdditions = true;

// Cache directory for API responses
const CACHE_DIR = "/tmp/alfred-gitfred-cache";
const CACHE_TTL_SECONDS = 60; // 1 minute cache

/**
 * Get cached response if still valid
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

		if (ageSeconds > CACHE_TTL_SECONDS) {
			console.log(`Cache expired for ${cacheKey} (${Math.round(ageSeconds)}s old)`);
			return null;
		}

		console.log(`Cache hit for ${cacheKey} (${Math.round(ageSeconds)}s old)`);
		return app.doShellScript(`cat "${cachePath}"`);
	} catch (_e) {
		return null;
	}
}

/**
 * Store response in cache
 * @param {string} cacheKey
 * @param {string} data
 */
function setCache(cacheKey, data) {
	try {
		app.doShellScript(`mkdir -p "${CACHE_DIR}"`);
		const cachePath = `${CACHE_DIR}/${cacheKey}.json`;
		const nsData = $.NSString.alloc.initWithUTF8String(data);
		nsData.writeToFileAtomicallyEncodingError(cachePath, true, $.NSUTF8StringEncoding, null);
	} catch (_e) {
		console.log(`Failed to write cache for ${cacheKey}`);
	}
}

/**
 * Generate a cache key from URL (sanitized for filesystem)
 * @param {string} url
 * @returns {string}
 */
function cacheKeyFromUrl(url) {
	return url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 200);
}

//──────────────────────────────────────────────────────────────────────────────

/** @param {string} str */
function alfredMatcher(str) {
	const clean = str.replace(/[-_.]/g, " ");
	const camelCaseSeparated = str.replace(/([A-Z])/g, " $1");
	return [clean, camelCaseSeparated, str].join(" ") + " ";
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

	// Check cache first for each request
	const results = requests.map((req) => {
		const cacheKey = cacheKeyFromUrl(req.url);
		const cached = getCache(cacheKey);
		return { name: req.name, response: cached, url: req.url, headers: req.headers, fromCache: !!cached };
	});

	// Find requests that need fetching
	const toFetch = results.filter((r) => !r.fromCache);

	if (toFetch.length === 0) {
		console.log("All responses from cache");
		return results.map((r) => ({ name: r.name, response: r.response || "" }));
	}

	// Fetch missing requests
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

	// Read fetched results and update cache
	for (let i = 0; i < toFetch.length; i++) {
		try {
			const response = app.doShellScript(`cat "${tempFiles[i]}" 2>/dev/null && rm -f "${tempFiles[i]}"`);
			toFetch[i].response = response;

			// Cache successful responses (non-empty, valid JSON)
			if (response) {
				try {
					const parsed = JSON.parse(response);
					if (!parsed.message) {
						setCache(cacheKeyFromUrl(toFetch[i].url), response);
					}
				} catch (_e) {
					// Don't cache invalid JSON
				}
			}
		} catch (_e) {
			console.log(`Failed to read response for ${toFetch[i].name}`);
			toFetch[i].response = "";
		}
	}

	// Merge cached and fetched results in original order
	return results.map((r) => {
		if (r.fromCache) return { name: r.name, response: r.response || "" };
		const fetched = toFetch.find((f) => f.url === r.url);
		return { name: r.name, response: fetched?.response || "" };
	});
}

/** @param {number} starcount */
function shortNumber(starcount) {
	const starStr = starcount.toString();
	if (starcount < 2000) return starStr;
	return starStr.slice(0, -3) + "k";
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

/** @type {AlfredRun} */
// biome-ignore lint/correctness/noUnusedVariables: Alfred run
function run() {
	const includePrivate = $.getenv("include_private_repos") === "1";
	const localRepoFolder = $.getenv("local_repo_folder");
	const cloneDepth = Number.parseInt($.getenv("clone_depth"));
	const useAlfredFrecency = $.getenv("use_alfred_frecency") === "1";
	const only100repos = $.getenv("only_100_recent_repos") === "1";
	const configs = getGithubConfigs();

	// GUARD no config
	if (configs.length === 0) {
		return JSON.stringify({
			items: [{ title: "No GitHub username configured.", valid: false }],
		});
	}

	// determine local repos
	/** @type {Record<string, {path: string; dirty: boolean|undefined}>} */
	const localRepos = {};
	app.doShellScript(`mkdir -p "${localRepoFolder}"`);
	const localRepoPaths = app
		.doShellScript(`find ${localRepoFolder} -type d -maxdepth 2 -name ".git"`)
		.split("\r");

	for (const gitFolderPath of localRepoPaths) {
		/** @type {{path: string; dirty: boolean|undefined}} */
		const repo = {};
		repo.path = gitFolderPath.replace(/\.git\/?$/, "");
		const name = repo.path.replace(/.*\/(.*)\/$/, "$1");
		try {
			repo.dirty = app.doShellScript(`cd "${repo.path}" && git status --porcelain`) !== "";
		} catch (_error) {
			// error can occur with cloud sync issues
			repo.dirty = undefined;
		}
		localRepos[name] = repo;
	}

	//───────────────────────────────────────────────────────────────────────────
	// FETCH REMOTE REPOS FROM ALL CONFIGURED ENDPOINTS (PARALLEL FIRST PAGE)

	/** @type {GithubRepo[]} */
	const allRepos = [];

	// Build requests for parallel fetch (first page of each endpoint)
	const requests = configs.map((config) => {
		const headers = ["Accept: application/vnd.github.json", "X-GitHub-Api-Version: 2022-11-28"];
		// DOCS https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#list-repositories-for-a-user
		let apiUrl = `${config.apiBase}/users/${config.username}/repos?type=all&per_page=100&sort=updated`;

		if (config.token && includePrivate) {
			// DOCS https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#list-repositories-for-the-authenticated-user--parameters
			apiUrl = `${config.apiBase}/user/repos?per_page=100&sort=updated`;
			headers.push(`Authorization: BEARER ${config.token}`);
		} else if (config.token) {
			headers.push(`Authorization: BEARER ${config.token}`);
		}

		return { url: apiUrl + "&page=1", headers, name: config.name, config };
	});

	// Fetch first page from all endpoints in parallel
	const responses = fetchParallel(requests);

	// Process responses and handle pagination if needed
	for (let i = 0; i < responses.length; i++) {
		const { name, response } = responses[i];
		const config = requests[i].config;

		if (!response) {
			console.log(`No response from ${name}`);
			continue;
		}

		let reposOfPage;
		try {
			reposOfPage = JSON.parse(response);
		} catch (_e) {
			console.log(`Invalid JSON from ${name}`);
			continue;
		}

		if (reposOfPage.message) {
			console.log(`Error from ${name}: ${reposOfPage.message}`);
			continue;
		}

		console.log(`${name} repos page #1: ${reposOfPage.length}`);

		// Tag repos with their source and apply org filter
		const taggedRepos = reposOfPage.map((/** @type {GithubRepo} */ repo) => ({
			...repo,
			_source: config.name,
		}));
		const filteredRepos = filterByOrg(taggedRepos, config.orgFilter, (r) => r.owner.login);
		allRepos.push(...filteredRepos);

		// Continue pagination sequentially if needed (and not limited to 100)
		if (!only100repos && reposOfPage.length === 100) {
			const headers = requests[i].headers;
			const baseUrl = requests[i].url.replace(/&page=1$/, "");
			let page = 2;

			while (true) {
				const pageResponse = httpRequestWithHeaders(baseUrl + `&page=${page}`, headers);
				if (!pageResponse) break;

				const moreRepos = JSON.parse(pageResponse);
				if (moreRepos.message || moreRepos.length === 0) break;

				console.log(`${name} repos page #${page}: ${moreRepos.length}`);

				const taggedMore = moreRepos.map((/** @type {GithubRepo} */ repo) => ({
					...repo,
					_source: config.name,
				}));
				const filteredMore = filterByOrg(taggedMore, config.orgFilter, (r) => r.owner.login);
				allRepos.push(...filteredMore);

				page++;
				if (moreRepos.length < 100) break;
			}
		}
	}

	// GUARD no repos found
	if (allRepos.length === 0) {
		return JSON.stringify({
			items: [{ title: "No repositories found.", valid: false }],
		});
	}

	// Collect all configured usernames for member detection
	const configuredUsernames = configs.map((c) => c.username);
	const hasMultipleEndpoints = configs.length > 1;

	// Create items for Alfred
	const repos = allRepos
		.filter((repo) => !repo.archived) // GitHub API doesn't allow filtering
		.sort((a, b) => {
			// sort local repos to the top
			const aIsLocal = Boolean(localRepos[a.name]);
			const bIsLocal = Boolean(localRepos[b.name]);
			if (aIsLocal && !bIsLocal) return -1;
			if (!aIsLocal && bIsLocal) return 1;
			return 0; // otherwise use sorting from GitHub (updated status)
		})
		.map((repo) => {
			let matcher = repo.name;
			let type = "";
			let subtitle = "";
			const localRepo = localRepos[repo.name];
			const memberRepo = !configuredUsernames.includes(repo.owner.login);
			const mainArg = localRepo?.path || repo.html_url;

			// open in terminal when local, clone when not
			let termAct = "Open in Terminal";
			if (!localRepo) termAct = cloneDepth > 0 ? `Shallow Clone (depth ${cloneDepth})` : "Clone";
			const terminalArg = localRepo?.path || repo.html_url;
			if (localRepo) {
				if (localRepos[repo.name]?.dirty) type += "✴️ ";
				type += "📂 ";
				matcher += "local ";
			}

			// extra info
			if (repo.fork) type += "🍴 ";
			if (repo.fork) matcher += "fork ";
			if (repo.is_template) type += "📄 ";
			if (repo.is_template) matcher += "template ";
			if (repo.private) type += "🔒 ";
			if (repo.private) matcher += "private ";
			if (repo.stargazers_count > 0);
			if (repo.open_issues > 0) subtitle += `${repo.open_issues}  `;
			if (repo.forks_count > 0) subtitle += `${repo.forks_count}  `;
			if (memberRepo) subtitle += `👤 ${repo.owner.login}  `;
			if (memberRepo) matcher += "member " + repo.owner.login + " ";
			// Show source indicator when using multiple endpoints
			if (hasMultipleEndpoints && repo._source) {
				const sourceLabel = repo._source === "github.com" ? "GH" : "GHE";
				subtitle += `[${sourceLabel}]  `;
				matcher += repo._source + " ";
			}

			/** @type {AlfredItem} */
			const alfredItem = {
				title: `${type}${repo.name}`,
				subtitle: subtitle,
				match: alfredMatcher(matcher),
				arg: mainArg,
				quicklookurl: repo.private ? undefined : mainArg,
				uid: useAlfredFrecency ? repo.full_name : undefined,
				mods: {
					ctrl: { subtitle: "⌃: " + termAct, arg: terminalArg },
					alt: { subtitle: "⌥: Copy GitHub URL", arg: repo.html_url },
					cmd: { subtitle: "⌘: Open at GitHub", arg: repo.html_url },
				},
			};
			return alfredItem;
		});

	return JSON.stringify({
		items: repos,
		// short, since cloned repos should be available immediately
		cache: { seconds: 15, loosereload: true },
	});
}
