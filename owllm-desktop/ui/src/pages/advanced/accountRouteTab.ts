// Which of the Accounts page's two routes — subscription or API key — opens
// first. Every provider is reachable both ways, so the page shows one grid per
// route kind and this decides which grid the user lands on.
//
// WHY it is inferred instead of a fixed default: someone signed in with the
// Claude / Codex / Gemini CLI has no API key and does not want a wall of
// "Set key" rows; someone who pastes keys does not want a wall of CLI logins.
// So the page opens on the route the user has ACTUALLY set up. An explicit tab
// click always outranks the inference and is remembered across launches —
// inference is for people who never expressed a preference.

export type AccountRouteTab = "subscription" | "api";

/// Explicit tab click, persisted in localStorage (survives relaunch).
export const ACCOUNT_ROUTE_TAB_KEY = "owllm:accounts:route-tab";

export type AccountRouteUsage = {
  /// Subscriptions connected right now (CLI login or web portal).
  subscriptions: number;
  /// API keys currently saved in the local secret store.
  apiKeys: number;
};

export function isAccountRouteTab(value: unknown): value is AccountRouteTab {
  return value === "subscription" || value === "api";
}

export function pickAccountRouteTab(input: {
  /// ACCOUNT_ROUTE_TAB_KEY — the user's own last choice, if they made one.
  stored?: string | null;
  /// ACCOUNT_ONBOARDING_KEY — "api", a provider key, or empty.
  onboarding?: string | null;
  usage: AccountRouteUsage;
}): AccountRouteTab {
  // 1. The user's own choice. Never overridden by anything below.
  if (isAccountRouteTab(input.stored)) return input.stored;
  // 2. Onboarding sent them here with a stated intent ("add the API key you
  //    already use" vs "connect <provider>"). That beats connection counts,
  //    because they are here precisely BECAUSE nothing is connected yet.
  if (input.onboarding === "api") return "api";
  if (input.onboarding) return "subscription";
  // 3. What they actually use. A tie — and a machine with nothing connected —
  //    opens Subscription: a CLI login costs nothing, an API key must be
  //    bought first, so it is the route more users can complete.
  return input.usage.apiKeys > input.usage.subscriptions ? "api" : "subscription";
}
