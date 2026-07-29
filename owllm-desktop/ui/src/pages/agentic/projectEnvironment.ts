// Project environments turn the onboarding "kind" into an actual workspace
// recipe: useful surfaces, an optional browser layout, and the web services the
// user chose.  The recipe contains labels + URLs only. Browser cookies,
// passwords and tokens remain in the device-local browser profile/vault.

export type EnvironmentSurface = {
  id: string;
  icon: string;
  label: string;
  detail: string;
};

export type EnvironmentService = {
  id: string;
  icon: string;
  label: string;
  url: string;
  category: "email" | "messages" | "calendar" | "documents" | "social" | "custom";
};

export type ProjectEnvironment = {
  version: 1;
  presetId: string;
  title: string;
  description: string;
  surfaces: EnvironmentSurface[];
  browser: {
    openOnCreate: boolean;
    layout: "right-half" | "device" | "none";
    device: "desktop" | "iphone" | "android" | "tablet";
    tabs: EnvironmentService[];
  };
};

export const ASSISTANT_SERVICES: EnvironmentService[] = [
  { id: "gmail", icon: "✉️", label: "Gmail", url: "https://mail.google.com/", category: "email" },
  { id: "outlook-mail", icon: "📨", label: "Outlook Mail", url: "https://outlook.office.com/mail/", category: "email" },
  { id: "whatsapp", icon: "💬", label: "WhatsApp", url: "https://web.whatsapp.com/", category: "messages" },
  { id: "telegram", icon: "✈️", label: "Telegram", url: "https://web.telegram.org/", category: "messages" },
  { id: "slack", icon: "💠", label: "Slack", url: "https://app.slack.com/", category: "messages" },
  { id: "teams", icon: "🟣", label: "Microsoft Teams", url: "https://teams.microsoft.com/", category: "messages" },
  { id: "google-calendar", icon: "📅", label: "Google Calendar", url: "https://calendar.google.com/", category: "calendar" },
  { id: "outlook-calendar", icon: "🗓️", label: "Outlook Calendar", url: "https://outlook.office.com/calendar/", category: "calendar" },
  { id: "notion", icon: "📓", label: "Notion", url: "https://www.notion.so/", category: "documents" },
  { id: "google-drive", icon: "📁", label: "Google Drive", url: "https://drive.google.com/", category: "documents" },
];

const S = (id: string, icon: string, label: string, detail: string): EnvironmentSurface => ({ id, icon, label, detail });
const browserTab = (id: string, icon: string, label: string, url: string): EnvironmentService => ({
  id, icon, label, url, category: "custom",
});

type EnvironmentDefinition = Omit<ProjectEnvironment, "version" | "browser"> & {
  browser?: Partial<ProjectEnvironment["browser"]> & { tabs?: EnvironmentService[] };
};

const DEFINITIONS: Record<string, EnvironmentDefinition> = {
  product: {
    presetId: "product-studio",
    title: "Product studio",
    description: "Discovery, product brief, visual research and an implementation workspace.",
    surfaces: [
      S("brief", "🧭", "Product brief", "Users, scope, acceptance and non-goals"),
      S("research", "🌐", "Market browser", "Competitors, references and evidence"),
      S("design", "🎨", "Design handoff", "Flows, states and implementation contract"),
      S("build", "🛠️", "Build workspace", "Code, terminal, tests and release"),
    ],
    browser: { openOnCreate: true, layout: "right-half", tabs: [browserTab("research", "🔎", "Market research", "https://www.google.com/")] },
  },
  web: {
    presetId: "web-live",
    title: "Live web studio",
    description: "Code and terminal on one side; the running site and responsive preview on the other.",
    surfaces: [
      S("code", "⚛️", "React / web code", "Frontend workspace and component tree"),
      S("terminal", "⌨️", "Dev server", "Run, build, lint and test without blocking the UI"),
      S("preview", "🌐", "Live preview", "Localhost opens beside OwLLM"),
      S("devices", "📱", "Device checks", "Desktop, phone and tablet viewports"),
    ],
    browser: {
      openOnCreate: true,
      layout: "right-half",
      tabs: [browserTab("local-preview", "🌐", "Local preview", "http://localhost:5173/")],
    },
  },
  mobile: {
    presetId: "responsive-mobile",
    title: "Responsive app lab",
    description: "A touch-first web/PWA workspace with a real mobile browser viewport.",
    surfaces: [
      S("code", "⚛️", "App code", "Components, routes and offline behavior"),
      S("terminal", "⌨️", "Dev server", "Run, build, lint and test"),
      S("preview", "📱", "Phone preview", "Real mobile viewport and user-agent"),
      S("a11y", "👆", "Touch & access", "Targets, keyboard, contrast and responsive states"),
    ],
    browser: {
      openOnCreate: true,
      layout: "device",
      device: "iphone",
      tabs: [browserTab("local-preview", "📱", "Phone preview", "http://localhost:5173/")],
    },
  },
  software: {
    presetId: "software-workbench",
    title: "Software workbench",
    description: "A focused implementation environment for CLIs, libraries, backends and desktop tools.",
    surfaces: [
      S("code", "🧩", "Source", "Implementation and architecture"),
      S("terminal", "⌨️", "Terminal", "Run commands without taking the GUI hostage"),
      S("tests", "🧪", "Test loop", "Focused tests, full suite and regressions"),
      S("docs", "📚", "Contracts", "README, API and release notes"),
    ],
  },
  bugfix: {
    presetId: "debug-lab",
    title: "Debug lab",
    description: "Reproduction, evidence, root cause, patch and regression proof.",
    surfaces: [
      S("repro", "🎯", "Reproduction", "Smallest reliable failing case"),
      S("logs", "🧾", "Logs & traces", "Errors, stack traces and runtime evidence"),
      S("terminal", "⌨️", "Debug terminal", "Run probes and focused tests"),
      S("regression", "🧪", "Regression gate", "A test that fails before and passes after"),
    ],
  },
  review: {
    presetId: "review-desk",
    title: "Code review desk",
    description: "Diff-first inspection with security, performance and verification evidence.",
    surfaces: [
      S("diff", "🔀", "Changes", "Commit and working-tree diff"),
      S("security", "🛡️", "Security", "Trust boundaries, secrets and unsafe behavior"),
      S("quality", "🔎", "Correctness", "Bugs, edge cases and maintainability"),
      S("verify", "🧪", "Verification", "Tests and build evidence"),
    ],
  },
  assistant: {
    presetId: "personal-operations",
    title: "Personal operations desk",
    description: "The exact mail, messaging, calendar and document sites you choose, kept signed in locally.",
    surfaces: [
      S("inbox", "📥", "Inbox triage", "Read, classify, draft and follow up"),
      S("messages", "💬", "Messages", "Read and reply through authenticated web apps"),
      S("calendar", "📅", "Calendar", "Review commitments and prepare changes"),
      S("approvals", "✅", "Approval queue", "User-facing confirmation before consequential actions"),
    ],
    browser: { openOnCreate: true, layout: "right-half" },
  },
  research: {
    presetId: "research-desk",
    title: "Research desk",
    description: "A browser-led evidence workflow with notes, source tracking and citation checks.",
    surfaces: [
      S("question", "❓", "Research question", "Scope, claims and deliverable"),
      S("browser", "🌐", "Source browser", "Primary sources and live pages"),
      S("notes", "📝", "Evidence notes", "Claim-to-source capture"),
      S("citations", "🔗", "Citation audit", "Links, dates and contradiction checks"),
    ],
    browser: { openOnCreate: true, layout: "right-half", tabs: [browserTab("research", "🔎", "Research", "https://www.google.com/")] },
  },
  writing: {
    presetId: "writing-room",
    title: "Writing room",
    description: "Audience, outline, draft, edit and reference checking without a software-team workflow.",
    surfaces: [
      S("brief", "🎯", "Audience & voice", "Purpose, reader and tone"),
      S("outline", "🗂️", "Outline", "Structure before prose"),
      S("draft", "✍️", "Draft", "Focused writing workspace"),
      S("edit", "🪶", "Editorial pass", "Clarity, accuracy and consistency"),
    ],
  },
  data: {
    presetId: "data-lab",
    title: "Data lab",
    description: "Dataset inspection, reproducible analysis, charts and a decision-ready report.",
    surfaces: [
      S("data", "🗃️", "Datasets", "Schema, quality and provenance"),
      S("notebook", "📒", "Analysis", "Queries and reproducible calculations"),
      S("charts", "📊", "Visuals", "Charts that answer the question"),
      S("report", "🧾", "Findings", "Assumptions, limits and decisions"),
    ],
  },
  social: {
    presetId: "campaign-desk",
    title: "Campaign desk",
    description: "Research, channel-native drafts, visual briefs, approvals and scheduling.",
    surfaces: [
      S("signals", "📡", "Signals", "Audience and current conversations"),
      S("drafts", "✍️", "Drafts", "Channel-specific copy variants"),
      S("visuals", "🖼️", "Creative brief", "Assets, crops and alt text"),
      S("approval", "✅", "Approval", "Nothing publishes without an explicit decision"),
    ],
  },
  custom: {
    presetId: "custom-workspace",
    title: "Custom workspace",
    description: "A neutral folder, terminal and team that you configure yourself.",
    surfaces: [
      S("files", "📁", "Project files", "The selected local workspace"),
      S("terminal", "⌨️", "Terminal", "Commands run in the project folder"),
      S("team", "👥", "Chosen team", "Your selected roster and permissions"),
    ],
  },
};

function safeService(service: EnvironmentService): EnvironmentService | null {
  const label = service.label?.trim();
  const rawUrl = service.url?.trim();
  if (!label || !rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return {
      id: service.id?.trim() || `custom-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      icon: service.icon || "🌐",
      label,
      url: parsed.toString(),
      category: service.category || "custom",
    };
  } catch {
    return null;
  }
}

export function createProjectEnvironment(
  kind: string,
  selectedServices: EnvironmentService[] = [],
): ProjectEnvironment {
  const definition = DEFINITIONS[kind] ?? DEFINITIONS.custom;
  const configuredServices = selectedServices.map(safeService).filter((s): s is EnvironmentService => !!s);
  const tabs = kind === "assistant"
    ? configuredServices
    : (definition.browser?.tabs ?? []).map(s => ({ ...s }));
  return {
    version: 1,
    presetId: definition.presetId,
    title: definition.title,
    description: definition.description,
    surfaces: definition.surfaces.map(surface => ({ ...surface })),
    browser: {
      openOnCreate: definition.browser?.openOnCreate ?? false,
      layout: definition.browser?.layout ?? "none",
      device: definition.browser?.device ?? "desktop",
      tabs,
    },
  };
}

export function parseProjectEnvironment(graphJson: string | null | undefined): ProjectEnvironment | null {
  if (!graphJson?.trim()) return null;
  try {
    const value = JSON.parse(graphJson)?.environment;
    if (!value || value.version !== 1 || typeof value.presetId !== "string") return null;
    const surfaces = Array.isArray(value.surfaces)
      ? value.surfaces.filter((surface: any) =>
          surface && typeof surface.id === "string" && typeof surface.label === "string")
      : [];
    const tabs = Array.isArray(value.browser?.tabs)
      ? value.browser.tabs.map(safeService).filter((s: EnvironmentService | null): s is EnvironmentService => !!s)
      : [];
    return {
      version: 1,
      presetId: value.presetId,
      title: typeof value.title === "string" ? value.title : value.presetId,
      description: typeof value.description === "string" ? value.description : "",
      surfaces,
      browser: {
        openOnCreate: value.browser?.openOnCreate === true,
        layout: value.browser?.layout === "right-half" || value.browser?.layout === "device" ? value.browser.layout : "none",
        device: ["desktop", "iphone", "android", "tablet"].includes(value.browser?.device) ? value.browser.device : "desktop",
        tabs,
      },
    };
  } catch {
    return null;
  }
}

export function environmentPromptBlock(environment: ProjectEnvironment | null | undefined): string {
  if (!environment) return "";
  const services = environment.browser.tabs.length
    ? `\nAuthenticated browser services configured by the user: ${environment.browser.tabs.map(tab => `${tab.label} (${tab.url})`).join(", ")}. Reuse the OwLLM browser session; never request or store their passwords in project files.`
    : "";
  return [
    "--- PROJECT ENVIRONMENT ---",
    `${environment.title}: ${environment.description}`,
    `Available working surfaces: ${environment.surfaces.map(surface => surface.label).join(", ")}.${services}`,
    "Use this environment when it fits the task. Browser actions are real user-account actions: read-only work is safe to perform, but ask before sending messages, changing calendar events, publishing, purchasing, deleting, or other consequential actions.",
    "--- END PROJECT ENVIRONMENT ---",
  ].join("\n");
}

export type ProjectEnvironmentInvoker = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/// The one tab-opening implementation, shared by the first-time recipe launch
/// and by the session restore so the two can never drift apart.
async function openTabSet(
  urls: string[],
  activeIndex: number,
  device: ProjectEnvironment["browser"]["device"],
  layout: ProjectEnvironment["browser"]["layout"],
  invokeCommand: ProjectEnvironmentInvoker,
  focus: boolean,
): Promise<void> {
  await invokeCommand("browser_ensure");
  await invokeCommand("browser_set_device", { device });

  let activeTabId: number | null = null;
  for (const [index, url] of urls.entries()) {
    const raw = await invokeCommand("browser_open_tab", { url, activate: index === activeIndex });
    if (index === activeIndex && typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(parsed?.tab_id)) activeTabId = parsed.tab_id;
      } catch { /* the tab is still open; selection is best-effort */ }
    }
  }
  if (urls.length === 0) {
    await invokeCommand("browser_start");
  }
  if (activeTabId !== null) {
    await invokeCommand("browser_select_tab", { tabId: activeTabId });
  }
  if (layout === "right-half") {
    await invokeCommand("browser_arrange", { layout: "right-half" });
  }
  if (focus) {
    await invokeCommand("browser_focus");
  }
}

export async function launchProjectEnvironment(
  environment: ProjectEnvironment,
  invokeCommand: ProjectEnvironmentInvoker,
): Promise<{ openedTabs: number; message: string }> {
  if (!environment.browser.openOnCreate && environment.browser.tabs.length === 0) {
    return { openedTabs: 0, message: `${environment.title} is ready. This recipe does not need a browser.` };
  }
  await openTabSet(
    environment.browser.tabs.map(tab => tab.url),
    0,
    environment.browser.device,
    environment.browser.layout,
    invokeCommand,
    true,
  );
  return {
    openedTabs: environment.browser.tabs.length,
    message: environment.browser.tabs.length
      ? `${environment.title} opened ${environment.browser.tabs.length} browser tab${environment.browser.tabs.length === 1 ? "" : "s"}.`
      : `${environment.title} browser opened.`,
  };
}

// A project's browser is part of the project. The pages it had open are
// mirrored per project by the Rust side (browser_session_bind), so closing the
// window by accident — or restarting the app — no longer throws them away.
// Cookies already live in the stable browser profile, so a restore lands back
// on live, logged-in sessions rather than a wall of sign-in screens.

export type BrowserSessionState = {
  /// Tab urls in strip order.
  tabs: string[];
  /// Index into `tabs` of the tab that was in front.
  active: number;
  /// False once the browser was deliberately closed.
  open: boolean;
};

export type BrowserSessionBind = {
  /// Another project's tabs are on screen — do not restore over them.
  busy: boolean;
  /// This project's tabs are already open — nothing to restore.
  live: boolean;
  session: BrowserSessionState;
};

export function parseBrowserSessionBind(raw: unknown): BrowserSessionBind {
  let value: any = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { value = null; }
  }
  const session = value?.session;
  const tabs = Array.isArray(session?.tabs)
    ? session.tabs.filter((url: unknown): url is string => typeof url === "string" && !!url.trim())
    : [];
  const active = Number.isInteger(session?.active) && session.active >= 0 && session.active < tabs.length
    ? session.active
    : 0;
  return {
    busy: value?.busy === true,
    live: value?.live === true,
    session: { tabs, active, open: session?.open === true },
  };
}

/// Reopen `projectId`'s browser pages. Falls back to the project's configured
/// environment the first time it is opened, so recipe tabs seed the session
/// rather than cap it.
///
/// `boot` marks the app-startup pass: a browser the user had deliberately
/// closed stays closed then, while explicitly opening the project always
/// restores it (an accidental ✕ is not an instruction to discard the pages).
export async function restoreProjectBrowser(
  projectId: string,
  environment: ProjectEnvironment | null,
  invokeCommand: ProjectEnvironmentInvoker,
  options: { boot: boolean },
): Promise<{ restoredTabs: number; message: string }> {
  if (!projectId.trim()) return { restoredTabs: 0, message: "No project selected." };

  const bind = parseBrowserSessionBind(await invokeCommand("browser_session_bind", { projectId }));
  if (bind.busy) {
    return { restoredTabs: 0, message: "Another project's browser is open — left it as it was." };
  }
  if (bind.live) {
    return { restoredTabs: 0, message: "The browser is already showing this project." };
  }

  if (bind.session.tabs.length === 0) {
    // Never opened before: seed the session from the project's own recipe.
    if (!environment) return { restoredTabs: 0, message: "This project has no saved browser session." };
    const launched = await launchProjectEnvironment(environment, invokeCommand);
    return { restoredTabs: launched.openedTabs, message: launched.message };
  }
  if (options.boot && !bind.session.open) {
    return { restoredTabs: 0, message: "The browser was closed on purpose last time — leaving it closed." };
  }

  // Restoring must never yank focus away from what the user is doing, least of
  // all at startup: the window comes back, it does not jump in front.
  await openTabSet(
    bind.session.tabs,
    bind.session.active,
    environment?.browser.device ?? "desktop",
    environment?.browser.layout ?? "none",
    invokeCommand,
    false,
  );
  return {
    restoredTabs: bind.session.tabs.length,
    message: `Reopened ${bind.session.tabs.length} browser tab${bind.session.tabs.length === 1 ? "" : "s"} for this project.`,
  };
}

/// Reopen the browser pages that belong to no project — the personal agent's
/// desk of logged-in apps. Those never had a project screen to restore them
/// from, so this is their way back after the window was closed.
export async function reopenPersonalBrowserSession(
  invokeCommand: ProjectEnvironmentInvoker,
): Promise<{ restoredTabs: number; message: string }> {
  let parsed: any = await invokeCommand("browser_session_reopen", {});
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  const reopened = Number.isInteger(parsed?.reopened) ? parsed.reopened : 0;
  // A page that will not load must say so rather than be quietly skipped.
  const failed: string[] = Array.isArray(parsed?.failed) ? parsed.failed : [];
  const message = reopened
    ? `Reopened ${reopened} browser tab${reopened === 1 ? "" : "s"}.`
    : "Those browser pages are already open.";
  return {
    restoredTabs: reopened,
    message: failed.length ? `${message} ${failed.length} could not be reopened: ${failed.join("; ")}` : message,
  };
}
