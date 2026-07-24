import { firefox } from "playwright";

async function run() {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();

  page.on("console", (msg) => console.log(`[${msg.type()}]`, msg.text()));
  page.on("pageerror", (err) => console.error("[pageerror]", err.message));

  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      invoke: async (cmd, args) => {
        if (cmd.startsWith("personal_agent_")) {
          console.log("[mock invoke]", cmd, args);
          if (cmd === "personal_agent_list_profiles") return [];
          if (cmd === "personal_agent_list_rule_cards") return [];
          throw new Error("not mocked: " + cmd);
        }
        throw new Error("unmocked: " + cmd);
      },
    };
  });

  await page.goto("http://localhost:5173/?page=studio", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(5000);

  const tauriCheck = await page.evaluate(() => JSON.stringify({
    hasInternals: !!window.__TAURI_INTERNALS__,
    metadata: window.__TAURI_INTERNALS__?.metadata,
    currentWindow: window.__TAURI_INTERNALS__?.metadata?.currentWindow,
  }));
  console.log("[tauri internals check]", tauriCheck);

  try {
    await page.click("text=Agents");
    console.log("Clicked Agents tab");
  } catch (e) {
    console.log("Could not click Agents tab:", e.message);
  }
  await page.waitForTimeout(1000);

  const body = await page.evaluate(() => document.body.innerText);
  console.log("\n--- BODY TEXT ---\n" + body.slice(0, 3000));

  const html = await page.evaluate(() => document.body.innerHTML);
  console.log("\n--- BODY HTML ---\n" + html.slice(0, 3000));

  await page.screenshot({ path: "/mnt/c/1_Git/LocaLLM/.tmp_wheels/browser-verify/debug-screenshot.png" });
  await browser.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
