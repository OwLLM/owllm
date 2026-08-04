#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../../");
const browserRs = fs.readFileSync(path.join(root, "src-tauri/src/browser.rs"), "utf8");
const home = fs.readFileSync(path.join(root, "src-tauri/browser-home.html"), "utf8");

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

console.log("Browser home regression checks");
const searchAt = home.indexOf("Search engines");
const socialAt = home.indexOf("Social");
const messengerAt = home.indexOf("Messengers");
const recentAt = home.indexOf("Recently opened");
check("home replaces the black blank page with a local document", browserRs.includes('include_str!("../browser-home.html")'));
check("sections retain the requested order", searchAt >= 0 && searchAt < socialAt && socialAt < messengerAt && messengerAt < recentAt);
check("search engines include Google, DuckDuckGo, Naver, Bing and Brave", ["google.com", "duckduckgo.com", "naver.com", "bing.com", "search.brave.com"].every((site) => home.includes(site)));
check("social row includes LinkedIn, Facebook, Instagram, X and Reddit", ["linkedin.com", "facebook.com", "instagram.com", "x.com", "reddit.com"].every((site) => home.includes(site)));
check("messenger row includes WhatsApp, Kakao, LINE, WeChat and Telegram", ["web.whatsapp.com", "accounts.kakao.com", "line.me", "web.wechat.com", "web.telegram.org"].every((site) => home.includes(site)));
check("shortcut logos are large and use each site's own favicon", home.includes("width: 56px") && (home.match(/favicon/g) || []).length >= 14);
check("the start page includes direct web search", home.includes('action="https://www.google.com/search"') && home.includes('name="q"'));
check("recent pages come from persisted closed and live tab history", /session\.closed\.iter\(\)\.rev\(\)\.chain\(session\.tabs\.iter\(\)\.rev\(\)\)/.test(browserRs));
check("recent URLs are limited and deduplicated", browserRs.includes("seen.insert(safe_url.clone())") && browserRs.includes("recent.len() == 5"));
check("recent shortcuts strip query strings and fragments", browserRs.includes("url.set_query(None)") && browserRs.includes("url.set_fragment(None)"));
check("only http(s) session entries can become recent shortcuts", browserRs.includes('matches!(url.scheme(), "http" | "https")'));
check("fresh browser starts on the home page", /let start_url = browser_home_url\(\)\?;[\s\S]{0,100}build_window/.test(browserRs));
check("plus button opens the home page", /"tabnew"[\s\S]{0,250}browser_home_url\(\)/.test(browserRs));
check("suspended Linux browser resumes on the home page", /browser_is_suspended\(\)[\s\S]{0,120}resume_normal_browser\(app, browser_home_url\(\)\?\)/.test(browserRs));
check("internal data URL is hidden from browser APIs", browserRs.includes("fn public_browser_url") && browserRs.includes('"about:blank".to_string()'));
check("home pages are excluded from persisted sessions", /fn list_tabs[\s\S]{0,1000}public_browser_url/.test(browserRs) && /fn persist_session[\s\S]{0,1400}tab\.url != "about:blank"/.test(browserRs));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
