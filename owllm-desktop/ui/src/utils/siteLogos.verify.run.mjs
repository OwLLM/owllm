#!/usr/bin/env node
// Real brand marks, and the two places that must never disagree about them.
//
// Pins what the user actually asked for: OwLLM shows the SOFTWARE'S OWN logo
// wherever it names one, never an invented stand-in. So this harness fails if
//   * a mark is missing, empty or not a real SVG path,
//   * a service tile falls back to an emoji,
//   * the agent browser's chrome bar copy of the marks drifts from the TS one,
//   * the chrome bar and browser.rs disagree about the taller header.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)));
const UI = path.resolve(HERE, "../..");
const APP = path.resolve(UI, "..");
const read = (rel) => fs.readFileSync(path.join(UI, rel), "utf8").replace(/\r\n/g, "\n");
const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error(`FAIL ${name}`);
}

// ---- the module itself, executed (not grepped) ----
const source = read("src/utils/siteLogos.ts");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const temp = path.join(APP, "node_modules", ".owllm-siteLogos.mjs");
fs.writeFileSync(temp, compiled);
const mod = await import(pathToFileURL(temp).href);
fs.rmSync(temp, { force: true });
const { SITE_LOGOS, siteHost, siteLogoForHost, siteLogoForUrl, siteLogoById, siteInitial } = mod;

check("marks are present", SITE_LOGOS.length >= 30);
for (const logo of SITE_LOGOS) {
  check(`${logo.id}: brand colour is a hex`, /^#[0-9A-Fa-f]{6}$/.test(logo.hex));
  check(`${logo.id}: has at least one host`, logo.hosts.length > 0);
  // A path is either absent (lettermark) or real SVG path data — an emoji or a
  // placeholder string would silently render as nothing.
  if (logo.path) check(`${logo.id}: path is SVG data`, /^[Mm][\d.\-\s]/.test(logo.path) && logo.path.length > 40);
}
const ids = SITE_LOGOS.map((l) => l.id);
check("ids are unique", new Set(ids).size === ids.length);

// ---- resolution ----
check("host is normalised", siteHost("https://WWW.WhatsApp.com/path") === "whatsapp.com");
check("about:blank has no host", siteHost("about:blank") === "");
check("bare host resolves", siteHost("web.whatsapp.com") === "web.whatsapp.com");
check("whatsapp web resolves", siteLogoForUrl("https://web.whatsapp.com/")?.id === "whatsapp");
// The regression that makes ordering load-bearing: mail.google.com must NOT be
// swallowed by the generic google.com suffix entry.
check("gmail beats generic google", siteLogoForUrl("https://mail.google.com/")?.id === "gmail");
check("calendar beats generic google", siteLogoForUrl("https://calendar.google.com/")?.id === "google-calendar");
check("drive beats generic google", siteLogoForUrl("https://drive.google.com/")?.id === "google-drive");
check("plain google still resolves", siteLogoForUrl("https://www.google.com/search?q=x")?.id === "google");
check("suffix match works", siteLogoForHost("acme.atlassian.net")?.id === "jira");
check("unknown host has no mark", siteLogoForUrl("https://example.invalid/") === null);
check("garbage url is safe", siteLogoForUrl("not a url") === null);
check("id lookup works", siteLogoById("telegram")?.title === "Telegram");
check("initial falls back", siteInitial("") === "?");
check("initial strips www", siteInitial("www.example.com") === "E");

// Brands with no redistributable mark must still be recognisable: brand colour
// + lettermark, never a hand-drawn imitation.
for (const id of ["slack", "teams", "outlook", "linkedin"]) {
  const logo = siteLogoById(id);
  check(`${id}: known brand`, Boolean(logo));
  check(`${id}: no invented path`, logo.path === "");
  check(`${id}: keeps its brand colour`, /^#[0-9A-Fa-f]{6}$/.test(logo.hex));
}
check("slack host resolves", siteLogoForUrl("https://app.slack.com/client")?.id === "slack");
check("outlook host resolves", siteLogoForUrl("https://outlook.office.com/mail/")?.id === "outlook");
check("teams host resolves", siteLogoForUrl("https://teams.microsoft.com/")?.id === "teams");

// ---- every assistant service the picker offers must resolve to a real mark ----
const env = read("src/pages/agentic/projectEnvironment.ts");
const services = [...env.matchAll(/\{\s*id:\s*"([^"]+)",\s*icon:\s*"[^"]*",\s*label:\s*"[^"]*",\s*url:\s*"([^"]+)"/g)]
  .map(([, id, url]) => ({ id, url }));
check("assistant services found", services.length >= 10);
for (const { id, url } of services) {
  // Same resolution order the SiteLogo component uses: our own id first, then
  // the service URL (so "outlook-mail" still lands on the Outlook brand).
  check(`service "${id}" resolves to a brand`, Boolean(siteLogoById(id) ?? siteLogoForUrl(url)));
}

// ---- the tiles render the mark, not the emoji ----
const dialog = read("src/pages/agentic/ProjectSettingsDialog.tsx");
check("dialog imports SiteLogo", /import\s*\{\s*SiteLogo\s*\}\s*from\s*"\.\.\/\.\.\/components\/SiteLogo"/.test(dialog));
check("service picker uses SiteLogo", /<SiteLogo id=\{service\.id\}/.test(dialog));
check("service picker dropped the emoji span", !/\{service\.icon\}/.test(dialog));
check("saved browser tabs use SiteLogo", /<SiteLogo id=\{tab\.id\}/.test(dialog));
check("saved browser tabs dropped the emoji", !/\{tab\.icon\}/.test(dialog));

// ---- chrome bar: same marks, taller header ----
const chrome = read("public/browser-chrome.html");
const entriesOf = (text) =>
  text.split("/* MARKS:BEGIN */")[1].split("/* MARKS:END */")[0]
    .split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{ id:"));
const tsEntries = entriesOf(source);
const chromeEntries = entriesOf(chrome);
check("chrome bar carries the marks", chromeEntries.length === SITE_LOGOS.length);
check("chrome bar marks have NOT drifted", chromeEntries.join("\n") === tsEntries.join("\n"));
check("chrome bar renders the site mark", /function renderSite\(/.test(chrome) && /id="sitemark"/.test(chrome));
check("chrome bar shows the site name", /id="sitename"/.test(chrome));
check("chrome bar updates on navigation", /renderSite\(i\.url\)/.test(chrome));
// The favicon is the only faithful source for brands that publish no mark.
check("chrome bar falls back to the real favicon", /\/favicon\.ico/.test(chrome));

// ---- one mark size, every page, open or not (user spec 2026-07-29) ----
// The regression this pins: only the ACTIVE page carried a big mark, the strip
// carried none, and the app logo was a 16px afterthought.
check("marks share one size variable", /--mark:\s*\d+px/.test(chrome) && /--glyph:\s*\d+px/.test(chrome));
check("the mark tile is sized from it", /\.mark\s*\{[^}]*width:\s*var\(--mark\)/.test(chrome));
check("the app logo is a mark too", /#logo\s*\{[^}]*width:\s*var\(--mark\)/.test(chrome));
check("no hard-coded mark size survives", !/#sitemark\s*\{/.test(chrome));
// One painter for the identity block AND the strip — a second renderer is how
// the two drifted apart in the first place.
check("one shared mark painter", /function paintMark\(/.test(chrome));
check("the identity block uses it", /paintMark\(\$\("sitemark"\)/.test(chrome));
check("every page in the strip uses it", /paintMark\(mark,\s*t\.url/.test(chrome));

// ---- brands whose standard mark is white-on-colour ----
const solid = SITE_LOGOS.filter((l) => l.solid);
check("solid brands are declared", solid.length >= 1);
for (const logo of solid) {
  check(`${logo.id}: solid brands still ship a real path`, logo.path.length > 40);
}
check("whatsapp is solid", siteLogoById("whatsapp").solid === true);
check("chrome bar paints solid brands on their colour", /logo\.solid/.test(chrome) && /className = "mark solid"/.test(chrome));
check("chrome bar knocks the glyph out in white", /logo\.solid \? "#ffffff"/.test(chrome));
const component = read("src/components/SiteLogo.tsx");
check("the React mark honours solid too", /logo\.solid/.test(component));

const rust = fs.readFileSync(path.join(APP, "src-tauri/src/browser.rs"), "utf8").replace(/\r\n/g, "\n");
const chromeH = Number(rust.match(/const CHROME_H: f64 = ([\d.]+);/)?.[1]);
check("header grew by exactly 30px", chromeH === 96);
check("chrome height is documented as shared", /browser-chrome\.html/.test(rust.split("const CHROME_H")[0].split("\n").slice(-6).join("\n")));

// A page's mark must not depend on being in front, so the strip needs the url
// of EVERY tab — not just the active one the identity block already had.
const pushTabs = rust.split("fn push_tabs")[1].split("\nfn ")[0];
check("rust sends a url per tab", /"url":/.test(pushTabs));

// Restore must land on the page that was in front. The index is counted over
// the tabs that are actually kept; counting it over the unfiltered list shifted
// it per dropped blank tab and then silently fell back to the FIRST page.
const persist = rust.split("fn persist_session")[1].split("\nfn ")[0];
check("session keeps the tabs it indexes", /let kept/.test(persist));
check("active index is counted over the kept tabs", /kept\.iter\(\)\.position\(/.test(persist));
check("no index rescue that lands on the first page", !/\.filter\(\|index\| \*index < tabs\.len\(\)\)/.test(persist));

console.log(`siteLogos: ${checks.length}/${checks.length} checks passed`);
