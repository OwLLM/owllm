// Pure import-boundary helpers used by DigitalTwinPage and its executable
// regression harness. Three.js loaders are injected so malformed-file behavior
// can be proven without a browser or WebGL context.

export const MAX_TOTAL_IMPORT_BYTES = 250 * 1024 * 1024;
export const BLOCKED_ASSET_URL = "data:application/octet-stream;base64,";

export type ModelUnit = "mm" | "cm" | "m" | "in" | "ft";

const METRES_PER_UNIT: Record<ModelUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

type FileSize = { size: number };
type UnitTransform = {
  scale: { multiplyScalar: (factor: number) => unknown };
  position: { multiplyScalar: (factor: number) => unknown };
};
type GltfResult = { scene?: unknown; scenes?: unknown[] };
type GltfLoaderLike = {
  parse: (
    buffer: ArrayBuffer,
    path: string,
    onLoad: (result: GltfResult) => void,
    onError: (error: unknown) => void,
  ) => void;
};

export function formatImportBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function defaultModelUnit(extension: string): ModelUnit {
  // glTF defines metres as its linear unit. OBJ and STL do not carry unit
  // metadata, so use the conventional mechanical-CAD default and keep the
  // choice visible/correctable in the inspector.
  return extension.toLowerCase() === "glb" || extension.toLowerCase() === "gltf" ? "m" : "mm";
}

export function metresPerModelUnit(unit: ModelUnit): number {
  return METRES_PER_UNIT[unit];
}

export function applySourceUnit(root: UnitTransform, unit: ModelUnit): void {
  const factor = metresPerModelUnit(unit);
  root.scale.multiplyScalar(factor);
  root.position.multiplyScalar(factor);
}

export function formatModelDimensions(dimensionsMetres: readonly number[], unit: ModelUnit): string {
  const factor = metresPerModelUnit(unit);
  const values = dimensionsMetres.map((metres) => {
    const value = metres / factor;
    const digits = Math.abs(value) >= 100 ? 1 : Math.abs(value) >= 10 ? 2 : 3;
    return String(Number(value.toFixed(digits)));
  });
  return `${values.join(" × ")} ${unit}`;
}

export function modelSizeWarning(dimensionsMetres: readonly number[]): string | null {
  const positive = dimensionsMetres.filter((value) => Number.isFinite(value) && value > 0);
  if (!positive.length) return "No measurable geometry was found. Confirm the export contains visible CAD bodies.";
  const largest = Math.max(...positive);
  if (largest > 1000) return "This model is over 1 km across. Confirm that the selected source unit matches the CAD export.";
  if (largest < 0.00001) return "This model is under 0.01 mm across. Confirm that the selected source unit matches the CAD export.";
  return null;
}

export function aggregateImportError(files: FileSize[]): string | null {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return total > MAX_TOTAL_IMPORT_BYTES
    ? `The selected files total ${formatImportBytes(total)}, above the 250 MB aggregate import limit. Choose a smaller set or import the assembly in batches so the UI remains responsive.`
    : null;
}

export function linkedAssetName(url: string): string {
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* Keep the original URL for the diagnostic. */ }
  return decoded.split(/[?#]/, 1)[0].replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? decoded.toLowerCase();
}

export function resolveLinkedAssetUrl(
  url: string,
  localUrls: ReadonlyMap<string, string>,
  missingAssets: Set<string>,
): string {
  if (/^(data|blob):/i.test(url)) return url;
  const assetName = linkedAssetName(url);
  const localUrl = localUrls.get(assetName);
  if (localUrl) return localUrl;
  missingAssets.add(assetName || url);
  return BLOCKED_ASSET_URL;
}

export function yieldToMainThread(
  schedule: (callback: () => void) => unknown = (callback) => globalThis.setTimeout(callback, 0),
): Promise<void> {
  return new Promise((resolve) => { schedule(resolve); });
}

export function actionableImportFailure(fileName: string, reason: unknown): Error {
  const detail = typeof reason === "string"
    ? reason
    : (reason as { message?: string })?.message ?? "the file could not be parsed";
  return new Error(`Could not import ${fileName}: ${detail}. Verify that the file is valid, re-export it as GLB/GLTF, OBJ, or STL if needed, then retry.`);
}

export function parseGltfScene(
  loader: GltfLoaderLike,
  buffer: ArrayBuffer,
  releaseUrls: () => void,
  missingAssetError: () => string | null,
  disposeScene: (scene: unknown) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseUrls();
    };
    const fail = (reason: unknown) => {
      release();
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    try {
      loader.parse(buffer, "", (result) => {
        const scene = result.scene ?? result.scenes?.[0];
        const missing = missingAssetError();
        if (missing) {
          disposeScene(scene);
          fail(missing);
          return;
        }
        release();
        resolve(scene);
      }, (error) => fail(missingAssetError() ?? error));
    } catch (error) {
      // GLTFLoader.parse JSON.parse failures escape synchronously instead of
      // reaching onError. Convert them into the same settled rejection path.
      fail(missingAssetError() ?? error);
    }
  });
}
