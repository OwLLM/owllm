#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const APP = path.resolve(HERE, "../../../..");
const source = fs.readFileSync(path.join(HERE, "projectEnvironment.ts"), "utf8");
const dialog = fs.readFileSync(path.join(HERE, "ProjectSettingsDialog.tsx"), "utf8");
const agents = fs.readFileSync(path.join(HERE, "AgentsPage.tsx"), "utf8");
const projects = fs.readFileSync(path.join(APP, "src-tauri/src/projects.rs"), "utf8");
const browser = fs.readFileSync(path.join(APP, "src-tauri/src/browser.rs"), "utf8");
const lib = fs.readFileSync(path.join(APP, "src-tauri/src/lib.rs"), "utf8");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-project-environment-"));
try {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = path.join(temp, "projectEnvironment.mjs");
  fs.writeFileSync(modulePath, compiled);
  const environment = await import(pathToFileURL(modulePath).href);

  let passed = 0;
  const check = (condition, message) => {
    if (!condition) throw new Error(`FAIL ${message}`);
    passed += 1;
    console.log(`PASS ${message}`);
  };

  const web = environment.createProjectEnvironment("web");
  const software = environment.createProjectEnvironment("software");
  const responsive = environment.createProjectEnvironment("mobile");
  check(web.presetId === "web-live" && web.browser.tabs[0].url === "http://localhost:5173/",
    "web projects get a live localhost preview");
  check(web.browser.layout === "right-half" && web.surfaces.some(surface => surface.id === "terminal"),
    "web projects combine browser and build surfaces");
  check(software.presetId !== web.presetId && software.browser.openOnCreate === false,
    "software projects do not inherit the web environment");
  check(responsive.browser.device === "iphone" && responsive.browser.layout === "device",
    "responsive projects launch a real phone viewport");

  const gmail = environment.ASSISTANT_SERVICES.find(service => service.id === "gmail");
  const whatsapp = environment.ASSISTANT_SERVICES.find(service => service.id === "whatsapp");
  const assistant = environment.createProjectEnvironment("assistant", [gmail, whatsapp]);
  check(assistant.browser.tabs.map(tab => tab.id).join(",") === "gmail,whatsapp",
    "assistant recipe contains only user-selected services");
  check(JSON.stringify(assistant).includes("mail.google.com") && !JSON.stringify(assistant).match(/password|token|cookie/i),
    "assistant project data contains URLs but no credential fields");

  const graph = JSON.stringify({ edges: [], environment: assistant });
  const parsed = environment.parseProjectEnvironment(graph);
  check(parsed?.browser.tabs.length === 2 && parsed.title === assistant.title,
    "environment round-trips through graph_json");
  const malformed = environment.parseProjectEnvironment(JSON.stringify({
    environment: { ...assistant, browser: { ...assistant.browser, tabs: [{ id: "bad", label: "bad", url: "file:///secret" }] } },
  }));
  check(malformed?.browser.tabs.length === 0, "non-http project browser URLs are rejected");
  const prompt = environment.environmentPromptBlock(assistant);
  check(prompt.includes("ask before sending messages") && prompt.includes("never request or store their passwords"),
    "agent prompt carries credential and consequential-action boundaries");

  const calls = [];
  const result = await environment.launchProjectEnvironment(assistant, async (command, args) => {
    calls.push({ command, args });
    if (command === "browser_open_tab") return JSON.stringify({ tab_id: calls.length, active: args.activate });
    return null;
  });
  check(result.openedTabs === 2, "assistant launch reports every selected service");
  check(calls.filter(call => call.command === "browser_open_tab").length === 2,
    "assistant launch opens one tab per selected service");
  check(calls.some(call => call.command === "browser_arrange" && call.args.layout === "right-half"),
    "side-by-side recipes arrange the browser");
  check(calls.at(-1)?.command === "browser_focus", "environment launch ends with a visible browser");

  check(dialog.includes('data-ui="ProjectEnvironmentDesigner"')
      && dialog.includes('data-ui="AssistantServicePicker"')
      && dialog.includes("project_environment: environment"),
    "new-project UI configures and persists the environment");
  check(dialog.includes('agentNames: ["orchestrator", "coder", "critic", "browser"]')
      && dialog.includes("const projectAgents = kindAgents(kind, team)")
      && dialog.includes("focused agents"),
    "web projects create a focused four-agent team instead of the full generic roster");
  check(dialog.includes('kind?.key === "assistant"')
      && dialog.includes('{ name: "browser", base: "browser", icon: "owl:owl_webapp" }')
      && dialog.includes('edge.target === "browser"'),
    "personal assistants include a routed Browser specialist that can operate selected sites");
  check(dialog.includes("The project stores only the site names and URLs")
      && dialog.includes('data-ui="SavedProjectEnvironment"')
      && dialog.includes("Reopen browser")
      && dialog.includes("onReopenBrowser"),
    "the UI explains local credentials and can reopen a saved environment");
  check(agents.includes("previousGraphJson: selectedProject.graph_json")
      && agents.includes("...previous")
      && agents.includes("environmentPromptBlock(projectEnvironment)"),
    "later graph edits preserve the recipe and agent prompts consume it");
  check(projects.includes("project_environment: serde_json::Value")
      && projects.includes('"environment": input.project_environment.clone()'),
    "the portable Project Card carries the non-secret environment recipe");
  check(browser.includes("pub fn browser_arrange")
      && browser.includes("resize only the browser")
      && lib.includes("browser::browser_arrange"),
    "the cross-platform browser layout command is registered without resizing the main GUI");

  console.log(`OK project environments: ${passed}/${passed} checks passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
