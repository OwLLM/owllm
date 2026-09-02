// OpenCascade tessellation is intentionally isolated from the UI thread. STEP
// and IGES files can take seconds to triangulate, but the rest of OwLLM must
// remain interactive while that work runs.
// @ts-ignore: occt-import-js does not publish TypeScript declarations.
import createOcct from "occt-import-js";
// @ts-ignore: Vite emits the bundled WebAssembly binary and returns its URL.
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

type CadRequest = {
  buffer: ArrayBuffer;
  format: "step" | "iges";
  linearUnit: "millimeter" | "centimeter" | "meter" | "inch" | "foot";
};

type OcctMesh = {
  name?: string;
  color?: number[];
  attributes?: {
    position?: { array?: number[] };
    normal?: { array?: number[] };
  };
  index?: { array?: number[] };
};

const occtPromise = createOcct({
  locateFile: (fileName: string) => fileName.endsWith(".wasm") ? occtWasmUrl : fileName,
});

self.onmessage = async (event: MessageEvent<CadRequest>) => {
  try {
    const { buffer, format, linearUnit } = event.data;
    const occt = await occtPromise;
    const bytes = new Uint8Array(buffer);
    const params = {
      linearUnit,
      linearDeflectionType: "bounding_box_ratio",
      linearDeflection: 0.001,
      angularDeflection: 0.5,
    };
    const result = format === "step"
      ? occt.ReadStepFile(bytes, params)
      : occt.ReadIgesFile(bytes, params);
    if (!result?.success) throw new Error("OpenCascade could not tessellate this CAD file");

    const transfers: ArrayBuffer[] = [];
    const meshes = (result.meshes as OcctMesh[] | undefined ?? []).map((mesh) => {
      const positions = new Float32Array(mesh.attributes?.position?.array ?? []);
      const normals = new Float32Array(mesh.attributes?.normal?.array ?? []);
      const indices = new Uint32Array(mesh.index?.array ?? []);
      transfers.push(positions.buffer, normals.buffer, indices.buffer);
      return { name: mesh.name ?? "CAD body", color: mesh.color ?? null, positions, normals, indices };
    });
    if (!meshes.some((mesh) => mesh.positions.length > 0 && mesh.indices.length > 0)) {
      throw new Error("The CAD file contained no tessellated solids or surfaces");
    }
    const workerScope = self as unknown as { postMessage: (message: unknown, transfer: Transferable[]) => void };
    workerScope.postMessage({ name: result.root?.name ?? "CAD model", meshes }, transfers);
  } catch (reason) {
    self.postMessage({ error: (reason as { message?: string })?.message ?? String(reason) });
  }
};
