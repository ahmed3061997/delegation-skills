/**
 * delegate · registry.mjs
 *
 * The canonical table of delegable agent CLIs: identity, how to discover them,
 * how to list their models, and how they express reasoning effort.
 *
 * Fourteen entries are listed. All fourteen are *discoverable*: the skill will
 * find them on PATH, report version and authentication state, and list models
 * where a credential-free listing exists. Only entries whose dispatch adapter
 * has been exercised against a locally installed CLI are *dispatchable*; the
 * rest carry `dispatch: null` plus the reason, and dispatch.mjs refuses them
 * rather than guessing flags. Adding one is a small, bounded change — see
 * references/adr-0001-architecture.md § "Adding an agent".
 *
 * Probe safety rule: a probe must be unambiguously a query. Several of these
 * CLIs treat a bare positional word as a prompt, which would bill the user and
 * start work nobody asked for — `codex models` and `pi models` are exactly that
 * mistake, so those entries use a cache file and a flag respectively.
 *
 * Credential rule: probes extract only the fields recorded below. `claude auth
 * status` also returns the account email and organization ids; only its boolean
 * `loggedIn` is read, and nothing else from that payload reaches the catalog.
 *
 * Node built-ins only. No network, no telemetry.
 */

/**
 * @typedef {"live"|"cached-catalog"|"aliases"|"unsupported"} ModelSource
 * @typedef {"flag"|"codex-config"|"variant"|"model-parameter"|"unverified"} EffortMechanism
 */

/** Effort levels `claude --help` documents for `--effort`. */
export const CLAUDE_EFFORT = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/**
 * Examples `opencode run --help` gives for `--variant`. The set is
 * provider-specific and open-ended, which is why a manual value is accepted.
 */
export const OPENCODE_VARIANT = Object.freeze(["minimal", "high", "max"]);

/**
 * Cursor expresses effort as a bracket parameter on the model id, the form
 * documented in `cursor-agent --help`:
 *   'claude-opus-4-8[context=1m,effort=high,fast=false]'
 * Only parameterized models accept it; the rest encode effort in the id itself
 * (…-low, …-high, …-xhigh), which selection.mjs detects and reports as fixed.
 */
export const CURSOR_EFFORT = Object.freeze(["low", "high", "xhigh"]);

/** Model ids that reach a Windows shell must stay shell-safe. */
export const MODEL_TOKEN = Object.freeze({
  /** Claude accepts alias or full name, including bracketed provider forms. */
  claude: /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/,
  /** Cursor's bracket parameter form needs comma and equals as well. */
  cursor: /^[A-Za-z0-9][A-Za-z0-9._:@/[\],=-]*$/,
  /** codex / opencode: plain slugs and provider/model pairs. */
  shellSafe: /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
});

/** Effort values are bare tokens in every mechanism we support. */
export const EFFORT_TOKEN = /^[A-Za-z][A-Za-z0-9-]*$/;

/** Session ids reach a Windows shell; keep them to a conservative shape. */
export const SESSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * @type {readonly {
 *   key: string,
 *   label: string,
 *   binary: string,
 *   versionArgs: string[],
 *   versionFallbackArgs?: string[],
 *   versionFormat?: "colon-prefix",
 *   winShell: boolean,
 *   authProbe: null | {
 *     args: string[],
 *     jsonField?: string,
 *     successPattern?: RegExp,
 *     failPattern?: RegExp,
 *     missMeansFalse?: boolean,
 *     description: string,
 *   },
 *   modelProbe: null
 *     | { kind: "aliases", values: readonly string[] }
 *     | { kind: "command", args: string[], format: "lines"|"cursor"|"grok"|"table" }
 *     | { kind: "cache-file", envDir: string, homeSubdir: string, file: string, format: "codex-cache" },
 *   models: { allowsManualId: boolean, cliDefault: boolean, cliDefaultNote: string|null },
 *   effort: {
 *     mechanism: EffortMechanism,
 *     source: "cli-help"|"model-catalog"|"unknown",
 *     values: readonly string[],
 *     perModel: boolean,
 *     note: string|null,
 *   },
 *   dispatch: null | { verification: "live", adapter: string },
 *   dispatchNote: string|null,
 * }[]}
 */
export const AGENTS = Object.freeze([
  {
    key: "claude",
    label: "Claude Code",
    binary: "claude",
    versionArgs: ["--version"],
    winShell: true,
    authProbe: {
      args: ["auth", "status"],
      jsonField: "loggedIn",
      description: "claude auth status (only the loggedIn boolean is read)",
    },
    // Claude publishes no listing command; `--model` takes one of these aliases
    // or a full model name, so the catalog offers aliases plus manual entry.
    modelProbe: { kind: "aliases", values: ["fable", "opus", "sonnet", "haiku"] },
    models: {
      allowsManualId: true,
      cliDefault: true,
      cliDefaultNote: "omit --model to use the model configured in Claude Code",
    },
    effort: {
      mechanism: "flag",
      source: "cli-help",
      values: CLAUDE_EFFORT,
      perModel: false,
      note: "passed as --effort <level>",
    },
    dispatch: { verification: "live", adapter: "claude" },
    dispatchNote: null,
  },
  {
    key: "cline",
    label: "Cline",
    binary: "cline",
    versionArgs: ["--version"],
    winShell: true,
    // No documented command reports login state, so authentication stays
    // unknown rather than being guessed from an unrelated exit code.
    authProbe: null,
    modelProbe: null,
    models: { allowsManualId: false, cliDefault: false, cliDefaultNote: null },
    effort: { mechanism: "unverified", source: "unknown", values: [], perModel: false, note: null },
    dispatch: null,
    dispatchNote: "no locally installed cline to verify against; discovery only",
  },
  {
    key: "codex",
    label: "OpenAI Codex",
    binary: "codex",
    versionArgs: ["--version"],
    winShell: true,
    authProbe: {
      // codex writes login state to stderr, so the probe reads both streams.
      args: ["login", "status"],
      successPattern: /logged in/i,
      failPattern: /not logged in/i,
      description: "codex login status",
    },
    // Never `codex models`: the positional word is read as a prompt and hits
    // the API. The locally cached catalog is the only credential-free listing,
    // and it carries per-model reasoning levels, which no listing command does.
    modelProbe: {
      kind: "cache-file",
      envDir: "CODEX_HOME",
      homeSubdir: ".codex",
      file: "models_cache.json",
      format: "codex-cache",
    },
    models: {
      allowsManualId: true,
      cliDefault: true,
      cliDefaultNote: "omit -m to use the model in ~/.codex/config.toml",
    },
    effort: {
      mechanism: "codex-config",
      source: "model-catalog",
      values: [],
      perModel: true,
      note: "passed as -c model_reasoning_effort=<level>; levels come from the selected model",
    },
    dispatch: { verification: "live", adapter: "codex" },
    dispatchNote: null,
  },
  {
    key: "opencode",
    label: "OpenCode",
    binary: "opencode",
    versionArgs: ["--version"],
    winShell: true,
    authProbe: {
      // `providers` (alias `auth`) exits 0 with an empty list too, so a clean
      // run with no "●" row is the logged-out state, not an ambiguous miss.
      args: ["auth", "list"],
      successPattern: /^●\s/m,
      missMeansFalse: true,
      description: "opencode auth list",
    },
    modelProbe: { kind: "command", args: ["models"], format: "lines" },
    models: {
      allowsManualId: true,
      // OpenCode has no safe implicit default for a fresh headless run.
      cliDefault: false,
      cliDefaultNote: null,
    },
    effort: {
      mechanism: "variant",
      source: "cli-help",
      values: OPENCODE_VARIANT,
      perModel: false,
      note: "passed as --variant <name>; the set is provider-specific, so a manual value is allowed",
    },
    dispatch: { verification: "live", adapter: "opencode" },
    dispatchNote: null,
  },
  {
    key: "antigravity",
    label: "Antigravity",
    binary: "agy",
    versionArgs: ["changelog"],
    versionFormat: "colon-prefix",
    winShell: false,
    authProbe: null,
    modelProbe: { kind: "command", args: ["models"], format: "lines" },
    models: { allowsManualId: false, cliDefault: false, cliDefaultNote: null },
    effort: { mechanism: "unverified", source: "unknown", values: [], perModel: false, note: null },
    dispatch: null,
    dispatchNote: "no locally installed agy to verify against; discovery only",
  },
  {
    key: "grok",
    label: "Grok CLI",
    binary: "grok",
    versionArgs: ["version"],
    versionFallbackArgs: ["--version"],
    winShell: true,
    authProbe: {
      args: ["models"],
      failPattern: /not authenticated/i,
      description: "grok models (listing doubles as the auth signal)",
    },
    modelProbe: { kind: "command", args: ["models"], format: "grok" },
    models: { allowsManualId: false, cliDefault: false, cliDefaultNote: null },
    effort: { mechanism: "unverified", source: "unknown", values: [], perModel: false, note: null },
    dispatch: null,
    dispatchNote: "no locally installed grok to verify against; discovery only",
  },
  {
    key: "kimi",
    label: "Kimi Code",
    binary: "kimi",
    versionArgs: ["--version"],
    winShell: false,
    authProbe: {
      args: ["provider", "list"],
      successPattern: /source=(oauth|api)/,
      description: "kimi provider list",
    },
    // No credential-free listing exists: the provider JSON and the config file
    // behind it both inline provider API keys, and this skill must not buffer
    // credentials.
    modelProbe: null,
    models: { allowsManualId: false, cliDefault: false, cliDefaultNote: null },
    effort: { mechanism: "unverified", source: "unknown", values: [], perModel: false, note: null },
    dispatch: null,
    dispatchNote: "no locally installed kimi to verify against; discovery only",
  },
  {
    key: "qoder",
    label: "Qoder",
    binary: "qodercli",
    versionArgs: ["--version"],
    winShell: false,
    authProbe: null,
    modelProbe: null,
    models: { allowsManualId: false, cliDefault: false, cliDefaultNote: null },
    effort: { mechanism: "unverified", source: "unknown", values: [], perModel: false, note: null },
    dispatch: null,
    dispatchNote: "no locally installed qodercli to verify against; discovery only",
  },
  {
    key: "vibe",
    label: "Vibe",
    binary: "vibe",
    versionArgs: ["--version"],
    winShell: false,
    authProbe: null,
    modelProbe: null,
    models: { allowsManualId: false, cliDefault: false, cliDefaultNote: null },
    effort: { mechanism: "unverified", source: "unknown", values: [], perModel: false, note: null },
    dispatch: null,
    dispatchNote: "no locally installed vibe to verify against; discovery only",
  },
  {
    key: "cursor",
    label: "Cursor Agent",
    binary: "cursor-agent",
    versionArgs: ["--version"],
    winShell: true,
    authProbe: {
      args: ["status"],
      successPattern: /logged in as/i,
      failPattern: /not logged in/i,
      description: "cursor-agent status",
    },
    // A flag, not a subcommand: `--list-models` cannot be read as a prompt.
    modelProbe: { kind: "command", args: ["--list-models"], format: "cursor" },
    models: {
      allowsManualId: true,
      cliDefault: true,
      cliDefaultNote: "omit --model to use your Cursor default (usually auto)",
    },
    effort: {
      mechanism: "model-parameter",
      source: "cli-help",
      values: CURSOR_EFFORT,
      perModel: false,
      note: "appended to the model id as model[effort=<level>]; only parameterized models accept it",
    },
    dispatch: { verification: "live", adapter: "cursor" },
    dispatchNote: null,
  },
  {
    key: "pi",
    label: "Pi",
    binary: "pi",
    versionArgs: ["--version"],
    winShell: true,
    authProbe: null,
    // Must stay a flag: `pi models` is read as a prompt and hits the API.
    modelProbe: { kind: "command", args: ["--list-models"], format: "table" },
    models: { allowsManualId: false, cliDefault: false, cliDefaultNote: null },
    effort: { mechanism: "unverified", source: "unknown", values: [], perModel: false, note: null },
    dispatch: null,
    dispatchNote: "no locally installed pi to verify against; discovery only",
  },
  {
    key: "aider",
    label: "Aider",
    binary: "aider",
    versionArgs: ["--version"],
    winShell: false,
    // Aider reads provider keys from the environment and its own config and
    // reports failure only once a run reaches the model, so there is nothing to
    // probe ahead of time.
    authProbe: null,
    // `aider --list-models` requires a partial-name argument, so no listing
    // covers the catalog; a guessed query would be worse than no listing.
    modelProbe: null,
    models: { allowsManualId: false, cliDefault: false, cliDefaultNote: null },
    effort: { mechanism: "unverified", source: "unknown", values: [], perModel: false, note: null },
    dispatch: null,
    dispatchNote: "no locally installed aider to verify against; discovery only",
  },
  {
    key: "copilot",
    label: "GitHub Copilot CLI",
    binary: "copilot",
    versionArgs: ["version"],
    winShell: true,
    // `copilot login` is interactive only; there is no status equivalent.
    authProbe: null,
    modelProbe: null,
    models: { allowsManualId: false, cliDefault: false, cliDefaultNote: null },
    effort: { mechanism: "unverified", source: "unknown", values: [], perModel: false, note: null },
    dispatch: null,
    dispatchNote: "no locally installed copilot to verify against; discovery only",
  },
  {
    key: "warp",
    label: "Warp (oz)",
    binary: "oz",
    versionArgs: ["--version"],
    winShell: false,
    authProbe: {
      // `--output-format text` prints one `type:id` line. A headless host
      // authenticated by API key is a service account, not a user, so the
      // pattern accepts both or CI reads as logged out.
      args: ["whoami", "--output-format", "text"],
      successPattern: /^(?:user|service_account):\S/m,
      description: "oz whoami --output-format text",
    },
    // `oz model list` emits a JSON array of {id} objects, which none of the
    // shared list formats parse.
    modelProbe: null,
    models: { allowsManualId: false, cliDefault: false, cliDefaultNote: null },
    effort: { mechanism: "unverified", source: "unknown", values: [], perModel: false, note: null },
    dispatch: null,
    dispatchNote: "no locally installed oz to verify against; discovery only",
  },
]);

/** Prototype-free lookup so names like "toString" cannot pass as agent keys. */
export const AGENT_BY_KEY = Object.freeze(
  AGENTS.reduce((map, agent) => {
    map[agent.key] = agent;
    return map;
  }, Object.create(null)),
);

/** @returns {(typeof AGENTS)[number] | null} */
export function findAgent(key) {
  if (typeof key !== "string" || !key) return null;
  return AGENT_BY_KEY[key] ?? null;
}

/** The model token pattern for an agent key, defaulting to the strictest one. */
export function modelPattern(key) {
  if (key === "claude") return MODEL_TOKEN.claude;
  if (key === "cursor") return MODEL_TOKEN.cursor;
  return MODEL_TOKEN.shellSafe;
}
