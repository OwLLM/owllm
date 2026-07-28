import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const useCases = (await import("../src/data/use-cases.json", { with: { type: "json" } })).default;
const pageSource = fs.readFileSync(
  path.join(projectRoot, "src", "pages", "use-cases.astro"),
  "utf8",
);

const REQUIRED_KEYS = [
  "id",
  "title",
  "domain",
  "goal",
  "setup",
  "workflow",
  "autonomy",
  "safeguards",
  "outcomes",
];
const EXPECTED_IDS = [
  "security-defence-analysis",
  "incident-response",
  "management-reporting",
  "marketing-operations",
  "daily-assistance",
  "browser-research",
  "whatsapp-communication",
  "email-triage",
  "crm-maintenance",
  "multi-agent-software-delivery",
];

describe("use-cases data", () => {
  it("exports exactly 10 scenarios", () => {
    assert.strictEqual(useCases.scenarios.length, 10, "Expected exactly 10 scenarios");
  });

  it("contains all required fields for every scenario", () => {
    for (const scenario of useCases.scenarios) {
      for (const key of REQUIRED_KEYS) {
        assert.ok(key in scenario, `Scenario ${scenario.id ?? "<unknown>"} missing field: ${key}`);
      }
    }
  });

  it("has unique, kebab-case ids", () => {
    const ids = useCases.scenarios.map((s) => s.id);
    const uniqueIds = new Set(ids);
    assert.strictEqual(uniqueIds.size, ids.length, "Scenario ids must be unique");
    for (const id of ids) {
      assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `Id ${id} should be kebab-case`);
    }
  });

  it("covers the expected scenario ids", () => {
    const ids = useCases.scenarios.map((s) => s.id).sort();
    assert.deepStrictEqual(ids, [...EXPECTED_IDS].sort());
  });

  it("has non-empty arrays for setup, workflow, safeguards, and outcomes", () => {
    for (const scenario of useCases.scenarios) {
      for (const key of ["setup", "workflow", "safeguards", "outcomes"]) {
        assert.ok(
          Array.isArray(scenario[key]) && scenario[key].length > 0,
          `${scenario.id}.${key} must be non-empty`,
        );
      }
    }
  });

  it("defines both autonomous and human-approved actions", () => {
    for (const scenario of useCases.scenarios) {
      assert.ok(
        Array.isArray(scenario.autonomy.autonomous),
        `${scenario.id} missing autonomous actions`,
      );
      assert.ok(scenario.autonomy.autonomous.length > 0, `${scenario.id} autonomous actions empty`);
      assert.ok(
        Array.isArray(scenario.autonomy.humanApproved),
        `${scenario.id} missing human-approved actions`,
      );
      assert.ok(
        scenario.autonomy.humanApproved.length > 0,
        `${scenario.id} human-approved actions empty`,
      );
    }
  });

  it("renders every scenario id as a page anchor", () => {
    for (const scenario of useCases.scenarios) {
      assert.ok(
        pageSource.includes(`id={scenario.id}`) || pageSource.includes(`id={${scenario.id}}`),
        `Anchor for ${scenario.id} not found in page source`,
      );
    }
  });

  it("links every scenario from the table of contents", () => {
    for (const scenario of useCases.scenarios) {
      assert.ok(
        pageSource.includes(`href={\`#\${scenario.id}\`}`) ||
          pageSource.includes(`href="#${scenario.id}"`),
        `TOC link for ${scenario.id} not found`,
      );
    }
  });
});

describe("use-cases built page", () => {
  const distPath = path.join(projectRoot, "dist", "use-cases", "index.html");
  const distExists = fs.existsSync(distPath);

  it("produces a built use-cases page after npm run build", () => {
    assert.ok(distExists, `Expected ${distPath} to exist. Run npm run build first.`);
  });

  (distExists ? it : it.skip)("renders 10 scenario articles", () => {
    const html = fs.readFileSync(distPath, "utf8");
    const articleMatches = html.match(/<article[^>]*class="[^"]*scenario-card[^"]*"/g) ?? [];
    assert.strictEqual(articleMatches.length, 10, "Expected 10 scenario articles in built HTML");
  });

  (distExists ? it : it.skip)("includes required section headings in every article", () => {
    const html = fs.readFileSync(distPath, "utf8");
    const requiredHeadings = [
      "Setup & access",
      "Workflow",
      "Automation boundary",
      "Safeguards",
      "Measurable outcomes",
    ];
    const articles = html.split('<article class="card scenario-card"');
    assert.strictEqual(articles.length - 1, 10, "Expected 10 articles to split");
    for (let i = 1; i < articles.length; i++) {
      for (const heading of requiredHeadings) {
        assert.ok(articles[i].includes(heading), `Article ${i} missing heading: ${heading}`);
      }
    }
  });

  (distExists ? it : it.skip)("renders scenario id anchors in built HTML", () => {
    const html = fs.readFileSync(distPath, "utf8");
    for (const scenario of useCases.scenarios) {
      assert.ok(
        html.includes(`id="${scenario.id}"`),
        `Built HTML missing anchor id for ${scenario.id}`,
      );
    }
  });

  (distExists ? it : it.skip)("includes autonomy badges in the boundary notice", () => {
    const html = fs.readFileSync(distPath, "utf8");
    assert.ok(html.includes("Autonomous"), "Missing Autonomous badge");
    assert.ok(html.includes("Human-approved"), "Missing Human-approved badge");
  });

  (distExists ? it : it.skip)("includes CollectionPage structured data", () => {
    const html = fs.readFileSync(distPath, "utf8");
    assert.ok(html.includes('"@type":"CollectionPage"'), "Missing CollectionPage structured data");
    assert.ok(html.includes('"@type":"ItemList"'), "Missing ItemList structured data");
  });
});
