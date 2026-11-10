// Substitution des lokalen Codes, Readiness und Konsolen-Gate fuer den Browser auf dem Host.
import { readFile } from "node:fs/promises";
import { moduleAlias, resolveLocalBuild, scriptKind, servesBuild } from "./local-build.mjs";
// substitution/collect
var isActive = (entry) => entry.active;
var collectActiveRedirects = (config) => config.projects.filter(isActive).flatMap((project) => [
  ...project.redirects.filter(isActive).map((entry) => ({ kind: "redirect", entry })),
  ...project.constants.filter(isActive).map((entry) => ({ kind: "constant", entry })),
  ...project.statics.filter(isActive).map((entry) => ({ kind: "static", entry })),
  ...(project.builds ?? []).filter(isActive).map((entry) => ({ kind: "build", entry }))
]);

// substitution/types
var ERROR_CODES = [
  /** `redirect.target` is not a key of `bootstrap.packages`. */
  "package-missing",
  /** `packages[target].files` is missing, or is not an array of indices. */
  "package-files-invalid",
  /** A `files` index has no `loadOrder` entry. */
  "package-file-unresolved",
  /** The bootstrap shape is unusable for this redirect. */
  "malformed-bootstrap"
];

// watch/preflight
var APP_SOURCE = /^app\//;
var APP_TARGET = "app";
var WHOLE_BOOTSTRAP = "*";
var NO_APP_SOURCES = "no-app-sources";
var PREFLIGHT_REASONS = [...ERROR_CODES, NO_APP_SOURCES];
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var collectBootstrapRequirements = (entries) => entries.filter((entry) => entry.kind === "redirect").map(
  (entry) => entry.entry.app ? { kind: "app" } : { kind: "package", target: entry.entry.target ?? "" }
);
var usableLoadOrder = (bootstrap) => {
  if (!isRecord(bootstrap)) return null;
  const { loadOrder } = bootstrap;
  const usable = Array.isArray(loadOrder) && loadOrder.every((entry) => isRecord(entry) && typeof entry.path === "string");
  return usable ? loadOrder : null;
};
var usablePackages = (bootstrap) => {
  const { packages } = bootstrap;
  return isRecord(packages) ? packages : {};
};
var hasAppSource = (loadOrder) => loadOrder.some(
  (entry) => isRecord(entry) && typeof entry.path === "string" && APP_SOURCE.test(entry.path)
);
var resolvesInLoadOrder = (index, loadOrder) => typeof index === "number" && Number.isInteger(index) && index >= 0 && index < loadOrder.length && loadOrder[index] !== null && loadOrder[index] !== void 0;
var packageProblem = (target, packages, loadOrder) => {
  if (!Object.hasOwn(packages, target)) return "package-missing";
  const entry = packages[target];
  const files = isRecord(entry) ? entry.files : void 0;
  if (!Array.isArray(files)) return "package-files-invalid";
  if (files.some((index) => !resolvesInLoadOrder(index, loadOrder))) {
    return "package-file-unresolved";
  }
  return null;
};
var checkBootstrap = (bootstrap, requirements) => {
  const loadOrder = usableLoadOrder(bootstrap);
  if (loadOrder === null) {
    return {
      ok: false,
      problems: [{ reason: "malformed-bootstrap", target: WHOLE_BOOTSTRAP }]
    };
  }
  const packages = usablePackages(bootstrap);
  const problems = requirements.flatMap((requirement) => {
    if (requirement.kind === "app") {
      return hasAppSource(loadOrder) ? [] : [{ reason: NO_APP_SOURCES, target: APP_TARGET }];
    }
    const reason = packageProblem(requirement.target, packages, loadOrder);
    return reason === null ? [] : [{ reason, target: requirement.target }];
  });
  return { ok: problems.length === 0, problems };
};
var preflight = (entries, bootstrap) => checkBootstrap(bootstrap, collectBootstrapRequirements(entries));

// host/console-gate
var ABORT_CODE = "net::ERR_ABORTED";
var isHardFailure = (obs, opts = {}) => {
  const strict = opts.strict ?? false;
  if (obs.text.includes(ABORT_CODE) && !strict) return false;
  if (obs.type === "pageerror" || obs.type === "requestfailed") return true;
  if (obs.type === "console") return obs.level === "error";
  return false;
};
var createConsoleGate = (opts = {}) => {
  const failures = [];
  return {
    observe(obs) {
      if (isHardFailure(obs, opts)) failures.push({ type: obs.type, text: obs.text });
    },
    drain() {
      return failures.splice(0, failures.length);
    }
  };
};

// host/identity
import { resolve } from "node:path";
var WINDOWS_DRIVE = /^([A-Za-z]):/;
var ABSOLUTE = /^([A-Za-z]:|\\\\|\/)/;
var normalizePath = (input) => {
  const absolute = ABSOLUTE.test(input) ? input : resolve(input);
  const slashed = absolute.replace(/\\/g, "/");
  const lowerDrive = slashed.replace(WINDOWS_DRIVE, (_, letter) => `${letter.toLowerCase()}:`);
  const withoutTrailing = lowerDrive.replace(/\/+$/, "");
  return withoutTrailing.length > 0 ? withoutTrailing : "/";
};
var computeIdentity = (parts) => ({
  profileDir: normalizePath(parts.profileDir),
  configPath: normalizePath(parts.configPath),
  portalUuid: parts.portalUuid
});

// substitution/derive
// Welche Requests Code der Anwendung laden, sagt die Config (`assetUrlPattern`): ein regulaerer Ausdruck, dessen erste Gruppe den
// Namen der Datei liefert, unter dem `redirects` und `statics` sie fuehren. Ohne Muster wird nichts ersetzt.
var SEPARATOR_RUN = /\/{2,}/g;
var LEADING_SEPARATOR = /^\//;
var compiledPatterns = /* @__PURE__ */ new Map();
var assetPattern = (pattern) => {
  if (typeof pattern !== "string" || pattern === "") return null;
  if (!compiledPatterns.has(pattern)) compiledPatterns.set(pattern, new RegExp(pattern));
  return compiledPatterns.get(pattern);
};
var deriveRepoPath = (url, pattern) => {
  const compiled = assetPattern(pattern);
  if (compiled === null) return null;
  const match = compiled.exec(url);
  if (match === null) return null;
  const path = (match[1] ?? "").replace(SEPARATOR_RUN, "/").replace(LEADING_SEPARATOR, "");
  return path === "" ? null : path;
};

// substitution/plan
var APP_PREFIX = "app/";
var isRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var unsatisfiable = (code, detail) => Object.assign(new Error(`${code} [${detail}]`), { code });
var usableLoadOrder2 = (bootstrap) => {
  if (!isRecord2(bootstrap)) throw unsatisfiable("malformed-bootstrap", "bootstrap");
  const { loadOrder } = bootstrap;
  const usable = Array.isArray(loadOrder) && loadOrder.every((entry) => isRecord2(entry) && typeof entry.path === "string");
  if (!usable) throw unsatisfiable("malformed-bootstrap", "loadOrder");
  return loadOrder;
};
var usableFiles = (bootstrap, target) => {
  const { packages } = bootstrap;
  if (!isRecord2(packages)) throw unsatisfiable("malformed-bootstrap", "packages");
  if (target === null || target === "" || !Object.hasOwn(packages, target)) {
    throw unsatisfiable("package-missing", target ?? "target");
  }
  const entry = packages[target];
  const files = isRecord2(entry) ? entry.files : void 0;
  const usable = Array.isArray(files) && files.every((index) => typeof index === "number");
  if (!usable) throw unsatisfiable("package-files-invalid", target);
  return files;
};
var planSources = (entry, bootstrap) => {
  if (entry.kind === "constant") return [{ from: "watch", path: entry.entry.watchPath }];
  if (entry.kind === "static") return [{ from: "fs", path: entry.entry.localPath }];
  const loadOrder = usableLoadOrder2(bootstrap);
  const redirect = entry.entry;
  if (redirect.app) {
    return loadOrder.filter((element) => element.path.startsWith(APP_PREFIX)).map((element) => ({ from: "watch", path: element.path }));
  }
  return usableFiles(bootstrap, redirect.target).map((index) => {
    const element = loadOrder[index];
    if (element === void 0) throw unsatisfiable("package-file-unresolved", String(index));
    return { from: "watch", path: element.path };
  });
};

// substitution/resolve
var resolveRedirect = (repoPath, entries) => entries.find((collected) => collected.kind !== "build" && collected.entry.name === repoPath) ?? null;
/**
 * Welcher lokale Code einen Request beantwortet: erst die genannten Eintraege (`statics`, `redirects`, `constants`) nach
 * `assetUrlPattern`, dann die Build-Ordner, exakt oder gleicher Name bis auf den Hash (local-build.mjs). Ein Build-Ordner leitet den
 * Namen aus seinem eigenen Muster ab (der Pfad unterhalb der Umgebung), sonst aus `assetUrlPattern`. Einzige Stelle dafuer: Routing,
 * Quellkarten und weitere Apps fragen alle hier.
 * @param resourceType wie Playwright ihn meldet; ohne (Quellkarten fuer den Host) zaehlt nur der Name
 * @returns { kind, entry, repoPath, file?, contentType?, alias? } oder null
 */
var localFileFor = (config, url, resourceType) => {
  if (resourceType === "document") return null;
  const entries = collectActiveRedirects(config);
  const repoPath = deriveRepoPath(url, config.assetUrlPattern);
  if (repoPath !== null) {
    const named = resolveRedirect(repoPath, entries);
    if (named !== null) return { ...named, repoPath, ...named.kind === "static" ? { file: named.entry.localPath } : {} };
  }
  for (const collected of entries) {
    if (collected.kind !== "build") continue;
    const names = [...new Set([deriveRepoPath(url, collected.entry.urlPattern), repoPath])].filter((name) => name !== null && name !== void 0);
    for (const name of names) {
      if (!servesBuild(resourceType, name)) continue;
      const found = resolveLocalBuild(collected.entry.localDir, name);
      if (found !== null) return { ...collected, repoPath: name, ...found };
    }
  }
  return null;
};

// substitution/decide
var CONTENT_TYPE = "application/javascript";
var NO_PORTAL = "substitution.no-portal";
var FAILED = "substitution.failed";
var isErrorCode = (value) => typeof value === "string" && ERROR_CODES.includes(value);
var classify = (error2) => {
  const code = error2?.code;
  return isErrorCode(code) ? code : "transport";
};
var emptyPlan = () => {
  const code = "malformed-bootstrap";
  return Object.assign(new Error(`${code} [empty-plan]`), { code });
};
var messageOf = (error2) => error2 instanceof Error && error2.message !== "" ? error2.message : String(error2);
var readAll = async (sources, deps) => {
  const pending = sources.map((source) => {
    const reading = source.from === "watch" ? deps.readWatch(source.path) : deps.readStatic(source.path);
    void reading.catch(() => void 0);
    return reading;
  });
  let body = "";
  for (const reading of pending) body += `${await reading}
`;
  return body;
};
var decideResponse = async (opts, deps) => {
  const { url, portalUrl, config, onFailure = "continue", resourceType } = opts;
  // Seiten (index.html, SPA-Routen) kommen immer vom Server: Er setzt Konfiguration, base href und CSP.
  if (resourceType === "document") return { action: "continue", reason: "document" };
  const matched = localFileFor(config, url, resourceType);
  if (matched === null) return { action: "continue", reason: "no-redirect" };
  const { repoPath } = matched;
  if (portalUrl === "") {
    deps.log("error", NO_PORTAL, { repoPath });
    return { action: "continue", reason: "no-portal" };
  }
  const failed = (error2) => {
    const reason = classify(error2);
    const message = messageOf(error2);
    deps.log("error", FAILED, { repoPath, reason, message });
    return onFailure === "fail" ? { action: "fail", reason, message } : { action: "continue", reason };
  };
  try {
    if (matched.kind === "build") {
      const raw = await (deps.readBinary ?? ((path) => readFile(path)))(matched.file);
      // Unter dem deployten Namen eines ES-Moduls nur ein Verweis auf das lokale (sonst liefe es zweimal); ob es eines ist, sagt die
      // lokale Seite, ohne sie die Syntax.
      const kind = matched.alias === void 0 ? null : scriptKind(matched.entry.localDir, matched.alias);
      const body = matched.alias === void 0 ? raw : moduleAlias(matched.alias, raw.toString("utf8"), kind) ?? raw;
      return {
        action: "fulfill",
        response: { status: 200, contentType: matched.contentType, headers: { "content-type": matched.contentType }, body }
      };
    }
    const bootstrap = matched.kind === "redirect" ? await deps.getBootstrap() : null;
    const sources = planSources(matched, bootstrap);
    if (sources.length === 0) throw emptyPlan();
    const body = await readAll(sources, deps);
    return {
      action: "fulfill",
      response: {
        status: 200,
        contentType: CONTENT_TYPE,
        // Stated in the headers as well, because a host that forwards the record and
        // ignores `contentType` would otherwise serve the bytes as a binary download.
        headers: { "content-type": CONTENT_TYPE },
        body
      }
    };
  } catch (error2) {
    return failed(error2);
  }
};

// substitution/host
var applyDecision = async (route, decision) => {
  switch (decision.action) {
    case "fulfill":
      await route.fulfill(decision.response);
      return;
    case "continue":
      await route.continue();
      return;
    case "fail":
      await route.abort();
      return;
    default: {
      const unhandled = decision;
      throw new Error(`unhandled decision action: ${JSON.stringify(unhandled)}`);
    }
  }
};

// host/interception
var messageOf2 = (error2) => error2 instanceof Error && error2.message !== "" ? error2.message : String(error2);
var onException = (onFailure, error2) => onFailure === "fail" ? { action: "fail", reason: "transport", message: messageOf2(error2) } : { action: "continue", reason: "transport" };
var createInterceptionHandler = (options, deps) => {
  const onFailure = options.onFailure ?? "continue";
  return async (route, url, resourceType) => {
    let decision;
    try {
      decision = await decideResponse({ ...options, url, resourceType }, deps);
    } catch (error2) {
      decision = onException(onFailure, error2);
    }
    await applyDecision(route, decision);
  };
};

// host/readiness
var READINESS_DEFAULTS = {
  timeout: 15e3,
  quietMs: 250,
  pollMs: 100,
  store: null,
  minCount: null
};
var resolveReadinessOptions = (opts = {}) => ({
  timeout: opts.timeout ?? READINESS_DEFAULTS.timeout,
  quietMs: opts.quietMs ?? READINESS_DEFAULTS.quietMs,
  pollMs: opts.pollMs ?? READINESS_DEFAULTS.pollMs,
  store: opts.store ?? READINESS_DEFAULTS.store,
  minCount: opts.minCount ?? READINESS_DEFAULTS.minCount
});
var isQuiet = (sample, minCount) => {
  if (sample.pendingAjax !== 0 || sample.loadingStores !== 0) return false;
  if (minCount === null) return true;
  return sample.counts !== null && sample.counts >= minCount;
};
var buildProbeExpression = (store = null) => {
  const storeLiteral = JSON.stringify(store ?? null);
  return `(() => {
  const Ext = window.Ext;
  const extReady = !!(Ext && Ext.data && Ext.data.StoreManager);
  if (!extReady) {
    return { pendingAjax: 0, loadingStores: 0, counts: null, extReady: false };
  }
  const pendingAjax = (Ext.Ajax && Ext.Ajax.isLoading && Ext.Ajax.isLoading())
    ? (Ext.Ajax.requests ? Object.keys(Ext.Ajax.requests).length : 1)
    : 0;
  const storeName = ${storeLiteral};
  let stores = [];
  if (storeName !== null) {
    const byId = Ext.data.StoreManager.lookup(storeName);
    if (byId) {
      stores = [byId];
    } else if (Ext.ComponentQuery) {
      stores = Ext.ComponentQuery.query(storeName)
        .map((component) => (component.getStore ? component.getStore() : null))
        .filter((candidate) => !!candidate);
    }
  } else {
    Ext.data.StoreManager.each((candidate) => { stores.push(candidate); });
  }
  const loadingStores = stores.filter((candidate) => candidate.isLoading && candidate.isLoading()).length;
  const counts = storeName === null
    ? null
    : stores.reduce((total, candidate) => total + (candidate.getCount ? candidate.getCount() : 0), 0);
  return { pendingAjax, loadingStores, counts, extReady };
})()`;
};
var waitForQuiet = async (deps, opts = {}) => {
  const { timeout, quietMs, pollMs, minCount } = resolveReadinessOptions(opts);
  const start = deps.now();
  let samples = 0;
  let lastSample = null;
  let quietSince = null;
  for (; ; ) {
    const sample = await deps.probe();
    samples += 1;
    lastSample = sample;
    const at = deps.now();
    if (isQuiet(sample, minCount)) {
      if (quietSince === null) quietSince = at;
      if (at - quietSince >= quietMs) {
        return { settled: true, waitedMs: at - start, samples, reason: "", lastSample };
      }
    } else {
      quietSince = null;
    }
    if (at - start >= timeout) {
      return {
        settled: false,
        waitedMs: at - start,
        samples,
        reason: `did not settle within ${timeout}ms`,
        lastSample
      };
    }
    await deps.sleep(pollMs);
  }
};

// host/host
var AUTH_POLL_ATTEMPTS = 20;
var AUTH_POLL_INTERVAL_MS = 500;
// Auch in offenen Shadow Roots, wie die Anmeldung (Playwright) und der Seitenzustand (webPageState) das Merkmal suchen.
var buildAuthMarkerExpression = (marker) => `(() => {
  const marker = ${JSON.stringify(marker)};
  const deep = (root) => root.querySelector(marker) !== null || [...root.querySelectorAll("*")].some((host) => host.shadowRoot && deep(host.shadowRoot));
  return deep(document);
})()`;
var createDevlinkHost = (config, deps, options) => {
  const gate = createConsoleGate();
  const activePortal = config.portals.find((portal) => portal.uuid === config.activePortal);
  const activePortalUrl = activePortal?.url ?? "";
  const authMarker = options.authMarker ?? config.authMarker ?? "";
  let context = null;
  let page = null;
  let running = false;
  const requirePage = () => {
    if (page === null) throw new Error("devlink host is not started");
    return page;
  };
  const pollAuthMarker = async (activePage) => {
    const expression = buildAuthMarkerExpression(authMarker);
    for (let attempt = 1; attempt <= AUTH_POLL_ATTEMPTS; attempt += 1) {
      // Leitet die Startseite per Skript weiter (abgelaufene Sitzung zum Anmeldedienst, / auf /app/), geht der Kontext verloren:
      // Das heisst nur "noch nicht da", weiter pruefen.
      const present = await activePage.evaluate(expression).catch(() => false);
      if (present) return;
      if (attempt < AUTH_POLL_ATTEMPTS) await deps.sleep(AUTH_POLL_INTERVAL_MS);
    }
    throw new Error(
      `devlink: the application is not signed in. Log in once inside the dedicated Chrome profile at ${options.profileDir}, then start devlink again.`
    );
  };
  return {
    async start() {
      const active = collectActiveRedirects(config);
      // Nur `redirects` brauchen bootstrap.json (Sencha). `statics` und `constants` lesen ihre Dateien direkt; eine Vite-,
      // Angular- oder webpack-App hat kein bootstrap.json.
      if (active.some((entry) => entry.kind === "redirect")) {
        const bootstrap = await deps.decideDeps.getBootstrap();
        const result = preflight(active, bootstrap);
        if (!result.ok) {
          const reasons = result.problems.map((problem) => `${problem.reason} (${problem.target})`).join(", ");
          throw new Error(
            `devlink: the active configuration is unsatisfiable \u2014 preflight failed: ${reasons}`
          );
        }
      }
      const launched = await deps.launcher.launch({
        profileDir: options.profileDir,
        ...options.channel === void 0 ? {} : { channel: options.channel },
        ...options.executablePath === void 0 ? {} : { executablePath: options.executablePath }
      });
      const activePage = launched.page();
      await activePage.goto(activePortalUrl);
      if (authMarker !== "") await pollAuthMarker(activePage);
      const handler = createInterceptionHandler(
        {
          portalUrl: activePortalUrl,
          config,
          ...options.onFailure === void 0 ? {} : { onFailure: options.onFailure }
        },
        deps.decideDeps
      );
      await launched.route(handler);
      launched.on("console", (obs) => gate.observe(obs));
      launched.on("pageerror", (obs) => gate.observe(obs));
      launched.on("requestfailed", (obs) => gate.observe(obs));
      context = launched;
      page = activePage;
      running = true;
    },
    async reload() {
      await requirePage().reload();
    },
    waitReady(opts) {
      const activePage = requirePage();
      const expression = buildProbeExpression(opts?.store ?? null);
      return waitForQuiet(
        {
          probe: () => activePage.evaluate(expression),
          now: () => deps.now(),
          sleep: (ms) => deps.sleep(ms)
        },
        opts
      );
    },
    drainConsole() {
      return gate.drain();
    },
    eval(expression) {
      return requirePage().evaluate(expression);
    },
    async screenshot(path) {
      await requirePage().screenshot({ path });
    },
    status() {
      return {
        running,
        identity: computeIdentity({
          profileDir: options.profileDir,
          configPath: options.configPath,
          portalUuid: config.activePortal ?? ""
        }),
        activePortalUrl
      };
    },
    async stop() {
      if (context !== null) await context.close();
      context = null;
      page = null;
      running = false;
    }
  };
};

// host/playwright-adapter
import { chromium } from "playwright-core";
var wrapPage = (page) => ({
  goto: async (url) => {
    await page.goto(url);
  },
  reload: async () => {
    await page.reload();
  },
  evaluate: (expression) => page.evaluate(expression),
  screenshot: async (opts) => {
    await page.screenshot({ path: opts.path });
  }
});
var wrapContext = (context) => ({
  route: async (handler) => {
    await context.route("**/*", (route, request) => handler(route, request.url(), request.resourceType()));
  },
  on: (event, listener) => {
    if (event === "console") {
      context.on(
        "console",
        (message) => listener({ type: "console", level: message.type(), text: message.text() })
      );
      return;
    }
    if (event === "pageerror") {
      context.on(
        "weberror",
        (webError) => listener({ type: "pageerror", text: String(webError.error()) })
      );
      return;
    }
    context.on(
      "requestfailed",
      (request) => listener({ type: "requestfailed", text: request.failure()?.errorText ?? "" })
    );
  },
  page: () => {
    const [active] = context.pages();
    if (active === void 0) {
      throw new Error("The persistent context has no page \u2014 a launched Chrome always opens one.");
    }
    return wrapPage(active);
  },
  close: () => context.close()
});
var createPlaywrightLauncher = (launchPersistentContext = (userDataDir, options) => chromium.launchPersistentContext(userDataDir, options)) => ({
  launch: async (opts) => {
    const channel = opts.channel ?? "chrome";
    const options = { channel };
    if (opts.executablePath !== void 0) {
      options.executablePath = opts.executablePath;
    }
    let context;
    try {
      context = await launchPersistentContext(opts.profileDir, options);
    } catch (error2) {
      if (opts.executablePath === void 0) {
        throw new Error(
          `Could not launch the host's Chrome via channel '${channel}'. Install Chrome, or set LaunchOptions.executablePath to a Chrome/Chromium binary as the escape hatch.`,
          { cause: error2 }
        );
      }
      throw error2;
    }
    return wrapContext(context);
  }
});

// host/deps
var createDecideDeps = (parts) => ({
  getBootstrap: parts.getBootstrap,
  readWatch: parts.readWatch,
  readStatic: (path) => parts.fileReader.readText(path),
  ...parts.fileReader.readBinary === void 0 ? {} : { readBinary: (path) => parts.fileReader.readBinary(path) },
  log: parts.log
});

// host/transport
var REQUEST_TIMEOUT_MS = 1e4;
var createFetchTransport = (fetchImpl = fetch) => ({
  get: async (url) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return {
      status: response.status,
      text: () => response.text()
    };
  }
});

// watch/base-url
var DEFAULT_WATCH_BASE_URL = "http://127.0.0.1:1841/";
var candidate = (value) => {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
};
var resolveWatchBaseUrl = (option, envValue) => {
  const chosen = candidate(option) ?? candidate(envValue) ?? DEFAULT_WATCH_BASE_URL;
  return `${chosen.replace(/\/+$/, "")}/`;
};

// watch/client
var BOOTSTRAP_FILE = "bootstrap.json";
var watchError = (kind, url, status, cause) => Object.assign(new Error(`watch ${kind}: ${url}`, cause === void 0 ? {} : { cause }), {
  reason: "transport",
  kind,
  url,
  ...status === void 0 ? {} : { status }
});
var isRecord3 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var projectLoadOrder = (value) => {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => ({
    path: isRecord3(entry) ? entry.path : void 0
  }));
};
var projectPackages = (value) => {
  if (!isRecord3(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      name,
      { files: isRecord3(entry) ? entry.files : void 0 }
    ])
  );
};
var projectBootstrap = (value) => {
  const root = isRecord3(value) ? value : {};
  return {
    loadOrder: projectLoadOrder(root.loadOrder),
    packages: projectPackages(root.packages)
  };
};
var isSuccess = (status) => status >= 200 && status < 300;
var getText = async (transport, url) => {
  const response = await transport.get(url).catch((cause) => {
    throw watchError("unreachable", url, void 0, cause);
  });
  if (!isSuccess(response.status)) throw watchError("bad-status", url, response.status);
  return response.text().catch((cause) => {
    throw watchError("unreachable", url, void 0, cause);
  });
};
var decode = (text, url) => {
  try {
    const value = JSON.parse(text);
    return value;
  } catch {
    throw watchError("not-json", url);
  }
};
var getBootstrap = async (transport, baseUrl) => {
  const url = `${baseUrl}${BOOTSTRAP_FILE}`;
  const text = await getText(transport, url);
  return projectBootstrap(decode(text, url));
};
var readWatch = async (transport, baseUrl, path) => {
  if (path === "") throw watchError("unreachable", baseUrl);
  return getText(transport, `${baseUrl}${path}`);
};
var createWatchClient = (transport, options = {}) => {
  const baseUrl = resolveWatchBaseUrl(options.baseUrl, void 0);
  return {
    getBootstrap: () => getBootstrap(transport, baseUrl),
    readWatch: (path) => readWatch(transport, baseUrl, path)
  };
};

// config/parse
var ROOT_FIELDS = ["activePortal", "assetUrlPattern", "authMarker", "chromeProfileDir", "portals", "projects"];
var PORTAL_FIELDS = ["uuid", "name", "url"];
var PROJECT_FIELDS = [
  "uuid",
  "name",
  "active",
  "startUrl",
  "redirects",
  "constants",
  "statics",
  "builds"
];
var REDIRECT_FIELDS = ["uuid", "name", "app", "target", "active"];
var CONSTANT_FIELDS = ["uuid", "name", "watchPath", "active"];
var STATIC_FIELDS = ["uuid", "name", "localPath", "active"];
var BUILD_FIELDS = ["uuid", "localDir", "urlPattern", "active"];
var report = (into, path, code, severity, detail) => {
  into.issues.push(
    detail === void 0 ? { path, code, severity } : { path, code, severity, detail }
  );
};
var error = (into, path, code, detail) => report(into, path, code, "error", detail);
var warn = (into, path, code, detail) => report(into, path, code, "warning", detail);
var isRecord4 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isArray = (value) => Array.isArray(value);
var reportUnknownFields = (into, node, path, known) => {
  for (const key of Object.keys(node)) {
    if (!known.includes(key)) warn(into, [...path, key], "unknown-field", key);
  }
};
var requiredString = (into, node, path, key) => {
  const value = node[key];
  if (value === void 0) {
    error(into, [...path, key], "missing-field", key);
    return void 0;
  }
  if (typeof value !== "string") {
    error(into, [...path, key], "wrong-type", "string");
    return void 0;
  }
  return value;
};
var optionalString = (into, node, path, key) => {
  const value = node[key];
  if (value === void 0) return void 0;
  if (typeof value !== "string") {
    error(into, [...path, key], "wrong-type", "string");
    return void 0;
  }
  return value;
};
var requiredNullableString = (into, node, path, key) => {
  const value = node[key];
  if (value === void 0) {
    error(into, [...path, key], "missing-field", key);
    return void 0;
  }
  if (value !== null && typeof value !== "string") {
    error(into, [...path, key], "wrong-type", "string|null");
    return void 0;
  }
  return value;
};
var requiredBoolean = (into, node, path, key) => {
  const value = node[key];
  if (value === void 0) {
    error(into, [...path, key], "missing-field", key);
    return void 0;
  }
  if (typeof value !== "boolean") {
    error(into, [...path, key], "wrong-type", "boolean");
    return void 0;
  }
  return value;
};
var requiredArray = (into, node, path, key) => {
  const value = node[key];
  if (value === void 0) {
    error(into, [...path, key], "missing-field", key);
    return void 0;
  }
  if (!isArray(value)) {
    error(into, [...path, key], "wrong-type", "array");
    return void 0;
  }
  return value;
};
var defaultedArray = (into, node, path, key) => node[key] === void 0 ? [] : requiredArray(into, node, path, key);
var readUuid = (into, node, path) => {
  const uuid = requiredString(into, node, path, "uuid");
  if (uuid === void 0) return void 0;
  if (into.uuids.has(uuid)) warn(into, [...path, "uuid"], "duplicate-uuid", uuid);
  else into.uuids.add(uuid);
  return uuid;
};
var readName = (into, node, path) => {
  const name = requiredString(into, node, path, "name");
  if (name === void 0) return void 0;
  if (name.trim().length === 0) {
    error(into, [...path, "name"], "empty-name");
    return void 0;
  }
  return name;
};
var reportDuplicateName = (into, seen, name, path, code) => {
  if (seen.has(name)) error(into, [...path, "name"], code, name);
  else seen.add(name);
};
var isAbsolutePath = (value) => /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]/.test(value);
var ORIGIN_FORM = /^[a-z][a-z0-9+.-]*:\/\/[^/\\?#\s]+$/i;
var parseRedirect = (into, raw, path) => {
  if (!isRecord4(raw)) {
    error(into, path, "not-an-object");
    return void 0;
  }
  reportUnknownFields(into, raw, path, REDIRECT_FIELDS);
  const uuid = readUuid(into, raw, path);
  const name = readName(into, raw, path);
  const app = requiredBoolean(into, raw, path, "app");
  const target = requiredNullableString(into, raw, path, "target");
  const active = requiredBoolean(into, raw, path, "active");
  if (app === true && typeof target === "string") {
    error(into, [...path, "target"], "app-redirect-has-target");
  }
  if (app === false && (target === null || typeof target === "string" && target.trim() === "")) {
    error(into, [...path, "target"], "package-redirect-no-target");
  }
  if (uuid === void 0 || name === void 0) return void 0;
  if (app === void 0 || target === void 0 || active === void 0) return void 0;
  return { uuid, name, app, target, active };
};
var parseConstant = (into, raw, path) => {
  if (!isRecord4(raw)) {
    error(into, path, "not-an-object");
    return void 0;
  }
  reportUnknownFields(into, raw, path, CONSTANT_FIELDS);
  const uuid = readUuid(into, raw, path);
  const name = readName(into, raw, path);
  const watchPath = requiredString(into, raw, path, "watchPath");
  const active = requiredBoolean(into, raw, path, "active");
  if (watchPath !== void 0 && isAbsolutePath(watchPath)) {
    error(into, [...path, "watchPath"], "constant-path-not-relative");
  }
  if (uuid === void 0 || name === void 0) return void 0;
  if (watchPath === void 0 || active === void 0) return void 0;
  return { uuid, name, watchPath, active };
};
var parseStatic = (into, raw, path) => {
  if (!isRecord4(raw)) {
    error(into, path, "not-an-object");
    return void 0;
  }
  reportUnknownFields(into, raw, path, STATIC_FIELDS);
  const uuid = readUuid(into, raw, path);
  const name = readName(into, raw, path);
  const localPath = requiredString(into, raw, path, "localPath");
  const active = requiredBoolean(into, raw, path, "active");
  if (localPath !== void 0 && !isAbsolutePath(localPath)) {
    error(into, [...path, "localPath"], "static-path-not-absolute");
  }
  if (uuid === void 0 || name === void 0) return void 0;
  if (localPath === void 0 || active === void 0) return void 0;
  return { uuid, name, localPath, active };
};
var parseBuild = (into, raw, path) => {
  if (!isRecord4(raw)) {
    error(into, path, "not-an-object");
    return void 0;
  }
  reportUnknownFields(into, raw, path, BUILD_FIELDS);
  const uuid = readUuid(into, raw, path);
  const localDir = requiredString(into, raw, path, "localDir");
  const urlPattern = optionalString(into, raw, path, "urlPattern");
  const active = requiredBoolean(into, raw, path, "active");
  if (localDir !== void 0 && !isAbsolutePath(localDir)) {
    error(into, [...path, "localDir"], "static-path-not-absolute");
  }
  if (uuid === void 0 || localDir === void 0 || active === void 0) return void 0;
  return { uuid, localDir, active, ...urlPattern === void 0 ? {} : { urlPattern } };
};
var parseEach = (into, list, path, parseOne) => list.map((raw, index) => parseOne(into, raw, [...path, index])).filter((entry) => entry !== void 0);
var parsePortal = (into, raw, path, seenNames) => {
  if (!isRecord4(raw)) {
    error(into, path, "not-an-object");
    return void 0;
  }
  reportUnknownFields(into, raw, path, PORTAL_FIELDS);
  const uuid = readUuid(into, raw, path);
  const name = readName(into, raw, path);
  const url = requiredString(into, raw, path, "url");
  if (name !== void 0) reportDuplicateName(into, seenNames, name, path, "duplicate-portal-name");
  if (url !== void 0 && !ORIGIN_FORM.test(url)) {
    error(into, [...path, "url"], "portal-url-not-origin");
  }
  if (uuid === void 0 || name === void 0 || url === void 0) return void 0;
  return { uuid, name, url };
};
var parseProject = (into, raw, path, seenNames) => {
  if (!isRecord4(raw)) {
    error(into, path, "not-an-object");
    return void 0;
  }
  reportUnknownFields(into, raw, path, PROJECT_FIELDS);
  const uuid = readUuid(into, raw, path);
  const name = readName(into, raw, path);
  const active = requiredBoolean(into, raw, path, "active");
  const startUrl = optionalString(into, raw, path, "startUrl");
  const redirects = requiredArray(into, raw, path, "redirects");
  const constants = requiredArray(into, raw, path, "constants");
  const statics = defaultedArray(into, raw, path, "statics");
  const builds = defaultedArray(into, raw, path, "builds");
  if (name !== void 0) {
    reportDuplicateName(into, seenNames, name, path, "duplicate-project-name");
  }
  const parsed = {
    uuid: uuid ?? "",
    name: name ?? "",
    active: active ?? false,
    redirects: parseEach(into, redirects ?? [], [...path, "redirects"], parseRedirect),
    constants: parseEach(into, constants ?? [], [...path, "constants"], parseConstant),
    statics: parseEach(into, statics ?? [], [...path, "statics"], parseStatic),
    builds: parseEach(into, builds ?? [], [...path, "builds"], parseBuild)
  };
  if (uuid === void 0 || name === void 0 || active === void 0) return void 0;
  if (redirects === void 0 || constants === void 0 || statics === void 0) return void 0;
  if (startUrl !== void 0) parsed.startUrl = startUrl;
  return parsed;
};
function parseConfig(raw) {
  const into = { issues: [], uuids: /* @__PURE__ */ new Set() };
  if (!isRecord4(raw)) {
    error(into, [], "not-an-object");
    return { ok: false, issues: into.issues };
  }
  reportUnknownFields(into, raw, [], ROOT_FIELDS);
  const activePortal = requiredNullableString(into, raw, [], "activePortal");
  const authMarker = requiredNullableString(into, raw, [], "authMarker");
  const chromeProfileDir = optionalString(into, raw, [], "chromeProfileDir");
  const portalList = requiredArray(into, raw, [], "portals");
  const projectList = requiredArray(into, raw, [], "projects");
  const portalNames = /* @__PURE__ */ new Set();
  const portals = (portalList ?? []).map(
    (entry, index) => parsePortal(into, entry, ["portals", index], portalNames)
  );
  const projectNames = /* @__PURE__ */ new Set();
  const projects = (projectList ?? []).map(
    (entry, index) => parseProject(into, entry, ["projects", index], projectNames)
  );
  const known = portals.filter((portal) => portal !== void 0);
  if (typeof activePortal === "string" && !known.some((portal) => portal.uuid === activePortal)) {
    error(into, ["activePortal"], "unknown-active-portal");
  }
  if (into.issues.some((issue) => issue.severity === "error")) {
    return { ok: false, issues: into.issues };
  }
  const config = {
    activePortal: activePortal ?? null,
    authMarker: authMarker ?? null,
    portals: known,
    projects: projects.filter((project) => project !== void 0)
  };
  if (chromeProfileDir !== void 0) config.chromeProfileDir = chromeProfileDir;
  return { ok: true, config, issues: into.issues };
}
export {
  createDecideDeps,
  createDevlinkHost,
  createFetchTransport,
  createInterceptionHandler,
  createPlaywrightLauncher,
  createWatchClient,
  deriveRepoPath,
  isHardFailure,
  localFileFor,
  parseConfig
};
