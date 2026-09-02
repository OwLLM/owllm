// @ts-ignore: Three.js is bundled without the optional local declaration package.
import * as THREE from "three";
import type { ModelUnit } from "./digitalTwinImport";

type CadMesh = {
  name: string;
  color: number[] | null;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

type CadResponse = {
  name?: string;
  meshes?: CadMesh[];
  error?: string;
};

const LINEAR_UNITS: Record<ModelUnit, "millimeter" | "centimeter" | "meter" | "inch" | "foot"> = {
  mm: "millimeter",
  cm: "centimeter",
  m: "meter",
  in: "inch",
  ft: "foot",
};

export function cadResponseToObject(response: CadResponse): any {
  if (response.error) throw new Error(response.error);
  const group = new THREE.Group();
  group.name = response.name || "CAD model";
  for (const mesh of response.meshes ?? []) {
    if (!mesh.positions.length || !mesh.indices.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    if (mesh.normals.length === mesh.positions.length) {
      geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    } else {
      geometry.computeVertexNormals();
    }
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const [r = 0.58, g = 0.64, b = 0.72] = mesh.color ?? [];
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(r, g, b),
      roughness: 0.55,
      metalness: 0.16,
      side: THREE.DoubleSide,
    });
    const object = new THREE.Mesh(geometry, material);
    object.name = mesh.name;
    group.add(object);
  }
  if (!group.children.length) throw new Error("The CAD file contained no renderable geometry");
  return group;
}

export async function loadCadModel(
  file: File,
  extension: string,
  unit: ModelUnit,
  signal?: AbortSignal,
): Promise<any> {
  const buffer = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException("The CAD import was cancelled", "AbortError");

  return await new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./digitalTwinCad.worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
      callback();
    };
    const cancel = () => finish(() => reject(new DOMException("The CAD import was cancelled", "AbortError")));
    signal?.addEventListener("abort", cancel, { once: true });
    worker.onerror = (event) => finish(() => reject(new Error(event.message || "The CAD tessellation worker stopped unexpectedly")));
    worker.onmessage = (event: MessageEvent<CadResponse>) => finish(() => {
      try { resolve(cadResponseToObject(event.data)); } catch (error) { reject(error); }
    });
    worker.postMessage({
      buffer,
      format: extension === "igs" || extension === "iges" ? "iges" : "step",
      linearUnit: LINEAR_UNITS[unit],
    }, [buffer]);
  });
}
