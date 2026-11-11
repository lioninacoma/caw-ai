// Browser auf dem Host: Start mit Anmeldung, Readiness und Konsolen-Gate. Den lokalen Code spielt das Overlay ein (overlay.mjs).
// host/console-gate
const ABORT_CODE = "net::ERR_ABORTED";
const isHardFailure = (obs, opts = {}) => {
  const strict = opts.strict ?? false;
  if (obs.text.includes(ABORT_CODE) && !strict) return false;
  if (obs.type === "pageerror" || obs.type === "requestfailed") return true;
  if (obs.type === "console") return obs.level === "error";
  return false;
};
const createConsoleGate = (opts = {}) => {
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
const WINDOWS_DRIVE = /^([A-Za-z]):/;
const ABSOLUTE = /^([A-Za-z]:|\\\\|\/)/;
const normalizePath = (input) => {
  const absolute = ABSOLUTE.test(input) ? input : resolve(input);
  const slashed = absolute.replace(/\\/g, "/");
  const lowerDrive = slashed.replace(WINDOWS_DRIVE, (_, letter) => `${letter.toLowerCase()}:`);
  const withoutTrailing = lowerDrive.replace(/\/+$/, "");
  return withoutTrailing.length > 0 ? withoutTrailing : "/";
};
const computeIdentity = (parts) => ({
  profileDir: normalizePath(parts.profileDir),
  configPath: normalizePath(parts.configPath),
  portalUuid: parts.portalUuid
});

// host/readiness
const READINESS_DEFAULTS = {
  timeout: 15e3,
  quietMs: 250,
  pollMs: 100,
  store: null,
  minCount: null
};
const resolveReadinessOptions = (opts = {}) => ({
  timeout: opts.timeout ?? READINESS_DEFAULTS.timeout,
  quietMs: opts.quietMs ?? READINESS_DEFAULTS.quietMs,
  pollMs: opts.pollMs ?? READINESS_DEFAULTS.pollMs,
  store: opts.store ?? READINESS_DEFAULTS.store,
  minCount: opts.minCount ?? READINESS_DEFAULTS.minCount
});
const isQuiet = (sample, minCount) => {
  if (sample.pendingAjax !== 0 || sample.loadingStores !== 0) return false;
  if (minCount === null) return true;
  return sample.counts !== null && sample.counts >= minCount;
};
const buildProbeExpression = (store = null) => {
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
const waitForQuiet = async (deps, opts = {}) => {
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
const AUTH_POLL_ATTEMPTS = 20;
const AUTH_POLL_INTERVAL_MS = 500;
// Auch in offenen Shadow Roots, wie die Anmeldung (Playwright) und der Seitenzustand (webPageState) das Merkmal suchen.
const buildAuthMarkerExpression = (marker) => `(() => {
  const marker = ${JSON.stringify(marker)};
  const deep = (root) => root.querySelector(marker) !== null || [...root.querySelectorAll("*")].some((host) => host.shadowRoot && deep(host.shadowRoot));
  return deep(document);
})()`;
const createDevlinkHost = (config, deps, options) => {
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
      const launched = await deps.launcher.launch({
        profileDir: options.profileDir,
        ...options.channel === void 0 ? {} : { channel: options.channel },
        ...options.executablePath === void 0 ? {} : { executablePath: options.executablePath }
      });
      const activePage = launched.page();
      await activePage.goto(activePortalUrl);
      if (authMarker !== "") await pollAuthMarker(activePage);
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
const wrapPage = (page) => ({
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
const wrapContext = (context) => ({
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
const createPlaywrightLauncher = (launchPersistentContext = (userDataDir, options) => chromium.launchPersistentContext(userDataDir, options)) => ({
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

// config/parse
const ROOT_FIELDS = ["activePortal", "assetUrlPattern", "authMarker", "chromeProfileDir", "portals", "projects"];
const PORTAL_FIELDS = ["uuid", "name", "url"];
const PROJECT_FIELDS = ["uuid", "name", "active", "startUrl"];
const report = (into, path, code, severity, detail) => {
  into.issues.push(
    detail === void 0 ? { path, code, severity } : { path, code, severity, detail }
  );
};
const error = (into, path, code, detail) => report(into, path, code, "error", detail);
const warn = (into, path, code, detail) => report(into, path, code, "warning", detail);
const isRecord4 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isArray = (value) => Array.isArray(value);
const reportUnknownFields = (into, node, path, known) => {
  for (const key of Object.keys(node)) {
    if (!known.includes(key)) warn(into, [...path, key], "unknown-field", key);
  }
};
const requiredString = (into, node, path, key) => {
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
const optionalString = (into, node, path, key) => {
  const value = node[key];
  if (value === void 0) return void 0;
  if (typeof value !== "string") {
    error(into, [...path, key], "wrong-type", "string");
    return void 0;
  }
  return value;
};
const requiredNullableString = (into, node, path, key) => {
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
const requiredBoolean = (into, node, path, key) => {
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
const requiredArray = (into, node, path, key) => {
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
const readUuid =(into, node, path) => {
  const uuid = requiredString(into, node, path, "uuid");
  if (uuid === void 0) return void 0;
  if (into.uuids.has(uuid)) warn(into, [...path, "uuid"], "duplicate-uuid", uuid);
  else into.uuids.add(uuid);
  return uuid;
};
const readName = (into, node, path) => {
  const name = requiredString(into, node, path, "name");
  if (name === void 0) return void 0;
  if (name.trim().length === 0) {
    error(into, [...path, "name"], "empty-name");
    return void 0;
  }
  return name;
};
const reportDuplicateName = (into, seen, name, path, code) => {
  if (seen.has(name)) error(into, [...path, "name"], code, name);
  else seen.add(name);
};
const ORIGIN_FORM = /^[a-z][a-z0-9+.-]*:\/\/[^/\\?#\s]+$/i;
const parsePortal = (into, raw, path, seenNames) => {
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
const parseProject = (into, raw, path, seenNames) => {
  if (!isRecord4(raw)) {
    error(into, path, "not-an-object");
    return void 0;
  }
  reportUnknownFields(into, raw, path, PROJECT_FIELDS);
  const uuid = readUuid(into, raw, path);
  const name = readName(into, raw, path);
  const active = requiredBoolean(into, raw, path, "active");
  const startUrl = optionalString(into, raw, path, "startUrl");
  if (name !== void 0) {
    reportDuplicateName(into, seenNames, name, path, "duplicate-project-name");
  }
  const parsed = {
    uuid: uuid ?? "",
    name: name ?? "",
    active: active ?? false
  };
  if (uuid === void 0 || name === void 0 || active === void 0) return void 0;
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
  createDevlinkHost,
  createPlaywrightLauncher,
  isHardFailure,
  parseConfig
};
