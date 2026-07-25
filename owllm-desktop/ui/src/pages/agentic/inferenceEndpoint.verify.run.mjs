import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const source = fs.readFileSync(path.join(HERE, "inferenceEndpoint.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const temp = path.join(
  process.env.TMPDIR || process.env.TEMP || "/tmp",
  `inference-endpoint-${process.pid}-${Date.now()}.mjs`,
);

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
};

try {
  fs.writeFileSync(temp, output);
  const {
    localInferenceFallback,
    resolveInferenceBase,
    setInferenceEndpoint,
    setLocalServerKey,
  } = await import(pathToFileURL(temp).href);

  setLocalServerKey("local-secret");
  setInferenceEndpoint({
    mode: "remote",
    host: "192.0.2.10",
    port: 10504,
    apiKey: "remote-secret",
  });
  const remote = resolveInferenceBase(10500);
  check("configured reachable route remains the primary route",
    remote.remote && remote.baseUrl === "http://192.0.2.10:10504" && remote.apiKey === "remote-secret");

  const recovered = localInferenceFallback(remote, 10500);
  check("failed off-box route recovers to the managed local model",
    !recovered?.remote && recovered?.baseUrl === "http://127.0.0.1:10500");
  check("local recovery uses the local server key, never the remote key",
    recovered?.apiKey === "local-secret");
  const nextCall = resolveInferenceBase(10500);
  check("the failed route is circuit-broken for later agent streams",
    !nextCall.remote && nextCall.baseUrl === "http://127.0.0.1:10500");
  check("an already-local route is never rewritten",
    localInferenceFallback(recovered, 10500) === null);
  check("invalid or missing local ports cannot create a bogus fallback",
    localInferenceFallback(remote, 0) === null &&
    localInferenceFallback(remote, 70000) === null);
  setInferenceEndpoint({
    mode: "remote",
    host: "192.0.2.10",
    port: 10504,
    apiKey: "remote-secret",
  });
  check("an explicit endpoint save clears the circuit breaker",
    resolveInferenceBase(10500).remote);

  const dispatch = fs.readFileSync(path.join(HERE, "dispatch.ts"), "utf8");
  const chat = fs.readFileSync(path.join(HERE, "../finetuning/ChatPage.tsx"), "utf8");
  check("the shared local-model stream validates the configured route",
    dispatch.includes("await ensureInferenceRoute();") &&
    dispatch.includes("if (recoverLocalInference(String(e?.message ?? e)))"));
  check("the legacy multi-column chat uses the same recovery",
    chat.includes("await ensureInferenceRoute();") &&
    chat.includes("localInferenceFallback(inference, activePort)"));
} finally {
  fs.rmSync(temp, { force: true });
}

if (failures) throw new Error(`FAILED: ${failures} inference endpoint check(s).`);
console.log("\nInference endpoint recovery checks passed.");
