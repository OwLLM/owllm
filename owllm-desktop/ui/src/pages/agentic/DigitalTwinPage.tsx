import { useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type DragEvent } from "react";
// Three.js is already bundled by OwLLM. This repository intentionally does
// not carry the optional @types package (the World Map follows the same rule).
// @ts-ignore: bundled dependency has no local declaration package
import * as THREE from "three";
// @ts-ignore: bundled Three.js example module
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
// @ts-ignore: bundled Three.js example module
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
// @ts-ignore: bundled Three.js example module
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
// @ts-ignore: bundled Three.js example module
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { loadCadModel } from "./digitalTwinCad";
import {
  actionableImportFailure,
  applySourceUnit,
  aggregateImportError,
  defaultModelUnit,
  formatImportBytes as formatBytes,
  formatModelDimensions,
  metresPerModelUnit,
  modelSizeWarning,
  parseGltfScene,
  resolveLinkedAssetUrl,
  yieldToMainThread,
  type ModelUnit,
} from "./digitalTwinImport";

const ACCEPTED_EXTENSIONS = new Set(["step", "stp", "iges", "igs", "glb", "gltf", "obj", "stl"]);
const MODEL_ACCEPT = ".step,.stp,.iges,.igs,.glb,.gltf,.obj,.stl";
const GLTF_ASSET_ACCEPT = ".bin,.png,.jpg,.jpeg,.webp";
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

type Vector3Tuple = [number, number, number];
type ProjectionMode = "perspective" | "orthographic";
type ImportUnit = "auto" | ModelUnit;

type ImportedPart = {
  id: string;
  name: string;
  sourceName: string;
  format: string;
  bytes: number;
  object: any;
  basePosition: Vector3Tuple;
  dimensionsMetres: Vector3Tuple;
  unit: ModelUnit;
  sizeWarning: string | null;
  visible: boolean;
};

type ConstraintKind = "mate" | "axis" | "plane" | "offset";

type AssemblyConstraint = {
  id: string;
  kind: ConstraintKind;
  sourceId: string;
  targetId: string;
  offset: number;
};

type ViewerApi = {
  fit: () => void;
  render: () => void;
  setProjection: (projection: ProjectionMode) => void;
  setView: (view: "front" | "top" | "right" | "iso") => void;
};

const UNIT_OPTIONS: { value: ModelUnit; label: string }[] = [
  { value: "mm", label: "Millimetres (mm)" },
  { value: "cm", label: "Centimetres (cm)" },
  { value: "m", label: "Metres (m)" },
  { value: "in", label: "Inches (in)" },
  { value: "ft", label: "Feet (ft)" },
];

function extensionOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? path.toLowerCase();
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function disposeObject(root: any) {
  root?.traverse?.((node: any) => {
    node.geometry?.dispose?.();
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value && typeof value === "object" && "isTexture" in value) (value as any).dispose?.();
      }
      material.dispose?.();
    }
  });
}

function prepareObject(root: any, fallbackName: string) {
  root.name ||= fallbackName;
  root.traverse?.((node: any) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    node.userData.digitalTwinPart = true;
    if (!node.material) {
      node.material = new THREE.MeshStandardMaterial({ color: 0x9da8b8, roughness: 0.62, metalness: 0.12 });
    }
  });
}

function measureObject(root: any): Vector3Tuple {
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  return [size.x, size.y, size.z];
}

function loadModel(file: File, companions: File[], unit: ModelUnit, signal?: AbortSignal): Promise<any> {
  const extension = extensionOf(file.name);
  if (["step", "stp", "iges", "igs"].includes(extension)) {
    return loadCadModel(file, extension, unit, signal).catch((error) => {
      throw actionableImportFailure(file.name, error);
    });
  }
  return new Promise((resolve, reject) => {
    const fail = (reason: unknown) => reject(actionableImportFailure(file.name, reason));

    if (extension === "obj") {
      file.text().then((source) => {
        try { resolve(new OBJLoader().parse(source)); } catch (error) { fail(error); }
      }, fail);
      return;
    }

    if (extension === "stl") {
      file.arrayBuffer().then((buffer) => {
        try {
          const geometry = new STLLoader().parse(buffer);
          geometry.computeVertexNormals();
          resolve(new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({ color: 0x93a4b8, roughness: 0.55, metalness: 0.18 }),
          ));
        } catch (error) { fail(error); }
      }, fail);
      return;
    }

    const urls = new Map<string, string>();
    const related = [file, ...companions.filter((candidate) => candidate !== file)];
    for (const asset of related) urls.set(basename(asset.name), URL.createObjectURL(asset));
    const missingAssets = new Set<string>();
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url: string) => resolveLinkedAssetUrl(url, urls, missingAssets));
    const release = () => urls.forEach((url) => URL.revokeObjectURL(url));
    const missingAssetError = () => missingAssets.size
      ? `Missing linked asset${missingAssets.size === 1 ? "" : "s"}: ${Array.from(missingAssets).join(", ")}. Select the GLTF, its .bin file, and all referenced textures together, then retry.`
      : null;
    const loader = new GLTFLoader(manager);
    file.arrayBuffer().then((buffer) => {
      parseGltfScene(loader, buffer, release, missingAssetError, disposeObject).then(resolve, fail);
    }, (error) => {
      release();
      fail(error);
    });
  });
}

function DigitalTwinViewer({
  parts,
  selectedId,
  constraints,
  explode,
  onSelect,
  onReady,
  onError,
}: {
  parts: ImportedPart[];
  selectedId: string | null;
  constraints: AssemblyConstraint[];
  explode: number;
  onSelect: (id: string | null) => void;
  onReady: (api: ViewerApi | null) => void;
  onError: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const assemblyRef = useRef<any>(null);
  const constraintLayerRef = useRef<any>(null);
  const gridRef = useRef<any>(null);
  const axesRef = useRef<any>(null);
  const renderRef = useRef<() => void>(() => {});
  const partsRef = useRef(parts);

  useEffect(() => { partsRef.current = parts; }, [parts]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x11161d);
    const perspectiveCamera = new THREE.PerspectiveCamera(42, 1, 1e-9, 1e12);
    const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1e-9, 1e12);
    perspectiveCamera.position.set(7, 5, 8);
    orthographicCamera.position.copy(perspectiveCamera.position);
    let camera: any = perspectiveCamera;
    let projection: ProjectionMode = "perspective";
    let orthographicHalfHeight = 5;

    let renderer: any;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch (reason) {
      onError(`The 3D viewport could not start: ${(reason as { message?: string })?.message ?? String(reason)}. Update the graphics driver or enable WebGL, then reopen this page.`);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.setAttribute("aria-label", "Interactive 3D digital twin assembly. Drag to orbit, scroll to zoom, and click a part to select it.");
    renderer.domElement.tabIndex = 0;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    controls.minDistance = 1e-9;
    controls.maxDistance = 1e12;
    controls.minZoom = 1e-9;
    controls.maxZoom = 1e9;
    controls.listenToKeyEvents?.(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x2d3748, 2.1));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
    keyLight.position.set(8, 12, 10);
    keyLight.castShadow = true;
    scene.add(keyLight);

    const grid = new THREE.GridHelper(20, 20, 0x566678, 0x2c3744);
    gridRef.current = grid;
    scene.add(grid);
    const axes = new THREE.AxesHelper(2.5);
    axesRef.current = axes;
    scene.add(axes);

    const assembly = new THREE.Group();
    const constraintLayer = new THREE.Group();
    assemblyRef.current = assembly;
    constraintLayerRef.current = constraintLayer;
    scene.add(assembly, constraintLayer);

    const render = () => renderer.render(scene, camera);
    renderRef.current = render;
    controls.addEventListener("change", render);

    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      const aspect = width / height;
      perspectiveCamera.aspect = aspect;
      perspectiveCamera.updateProjectionMatrix();
      orthographicCamera.left = -orthographicHalfHeight * aspect;
      orthographicCamera.right = orthographicHalfHeight * aspect;
      orthographicCamera.top = orthographicHalfHeight;
      orthographicCamera.bottom = -orthographicHalfHeight;
      orthographicCamera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const fit = () => {
      const box = new THREE.Box3().setFromObject(assembly);
      if (box.isEmpty()) {
        controls.target.set(0, 0, 0);
        camera.position.set(7, 5, 8);
      } else {
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(sphere.radius, 1e-9);
        const currentDirection = camera.position.clone().sub(controls.target);
        const direction = currentDirection.lengthSq() > 0
          ? currentDirection.normalize()
          : new THREE.Vector3(1, 0.72, 1).normalize();
        const distance = projection === "perspective"
          ? radius / Math.sin(THREE.MathUtils.degToRad(perspectiveCamera.fov / 2)) * 1.25
          : radius * 4;
        controls.target.copy(sphere.center);
        camera.position.copy(sphere.center).add(direction.multiplyScalar(distance));
        camera.near = Math.max(distance / 1000, 1e-9);
        camera.far = Math.max(distance * 100, 1);
        if (projection === "orthographic") {
          const aspect = Math.max(host.clientWidth, 1) / Math.max(host.clientHeight, 1);
          orthographicHalfHeight = radius * 1.25 / Math.min(aspect, 1);
          orthographicCamera.zoom = 1;
          orthographicCamera.left = -orthographicHalfHeight * aspect;
          orthographicCamera.right = orthographicHalfHeight * aspect;
          orthographicCamera.top = orthographicHalfHeight;
          orthographicCamera.bottom = -orthographicHalfHeight;
        }
        camera.updateProjectionMatrix();
      }
      controls.update();
      render();
    };

    const setProjection = (nextProjection: ProjectionMode) => {
      if (projection === nextProjection) return;
      const previousCamera = camera;
      const offset = previousCamera.position.clone().sub(controls.target);
      const direction = offset.lengthSq() > 0 ? offset.normalize() : new THREE.Vector3(1, 0.72, 1).normalize();
      projection = nextProjection;
      camera = nextProjection === "orthographic" ? orthographicCamera : perspectiveCamera;
      camera.up.copy(previousCamera.up);
      camera.position.copy(controls.target).add(direction.multiplyScalar(Math.max(previousCamera.position.distanceTo(controls.target), 1)));
      controls.object = camera;
      fit();
    };

    const setView = (view: "front" | "top" | "right" | "iso") => {
      const distance = Math.max(camera.position.distanceTo(controls.target), 1);
      const direction = view === "front" ? new THREE.Vector3(0, 0, 1)
        : view === "top" ? new THREE.Vector3(0, 1, 0.001)
        : view === "right" ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(1, 0.72, 1).normalize();
      camera.position.copy(controls.target).add(direction.multiplyScalar(distance));
      if (view === "top") camera.up.set(0, 0, -1);
      else camera.up.set(0, 1, 0);
      camera.lookAt(controls.target);
      controls.update();
      render();
    };
    onReady({ fit, render, setProjection, setView });

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerStart = { x: 0, y: 0 };
    const handlePointerDown = (event: PointerEvent) => {
      pointerStart = { x: event.clientX, y: event.clientY };
    };
    const handlePointer = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(assembly.children, true)[0]?.object;
      if (!hit) { onSelect(null); return; }
      const part = partsRef.current.find((candidate) => {
        let cursor: any = hit;
        while (cursor) {
          if (cursor === candidate.object) return true;
          cursor = cursor.parent;
        }
        return false;
      });
      onSelect(part?.id ?? null);
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointer);
    resize();

    return () => {
      onReady(null);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointer);
      controls.removeEventListener("change", render);
      controls.stopListenToKeyEvents?.();
      controls.dispose();
      grid.geometry.dispose();
      (grid.material as any).dispose?.();
      constraintLayer.traverse((node: any) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
      renderer.dispose();
      renderer.domElement.remove();
      assemblyRef.current = null;
      constraintLayerRef.current = null;
      gridRef.current = null;
      axesRef.current = null;
    };
  }, [onError, onReady, onSelect]);

  useEffect(() => {
    const assembly = assemblyRef.current;
    if (!assembly) return;
    assembly.clear();
    for (const part of parts) assembly.add(part.object);
    const box = new THREE.Box3().setFromObject(assembly);
    if (!box.isEmpty()) {
      const size = box.getSize(new THREE.Vector3());
      const largest = Math.max(size.x, size.y, size.z, 1e-9);
      const magnitude = 10 ** Math.floor(Math.log10(largest));
      const normalized = largest / magnitude;
      const niceLargest = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
      const gridSpan = niceLargest * magnitude * 2;
      gridRef.current?.scale.setScalar(gridSpan / 20);
      axesRef.current?.scale.setScalar(gridSpan / 10);
    }
    renderRef.current();
  }, [parts]);

  useEffect(() => {
    for (const part of parts) {
      part.object.visible = part.visible;
      part.object.traverse?.((node: any) => {
        if (!node.isMesh || !node.material) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (!material.userData.digitalTwinOriginalEmissive && material.emissive) {
            material.userData.digitalTwinOriginalEmissive = material.emissive.clone();
          }
          if (material.emissive) {
            const original = material.userData.digitalTwinOriginalEmissive;
            material.emissive.copy(original);
            if (part.id === selectedId) material.emissive.add(new THREE.Color(0x183d52));
          }
        }
      });
    }
    renderRef.current();
  }, [parts, selectedId]);

  useEffect(() => {
    if (!parts.length) return;
    const assemblyBounds = new THREE.Box3();
    for (const part of parts) assemblyBounds.expandByObject(part.object);
    const center = assemblyBounds.getCenter(new THREE.Vector3());
    const radius = Math.max(assemblyBounds.getBoundingSphere(new THREE.Sphere()).radius, 1);
    for (const part of parts) {
      const base = new THREE.Vector3(...part.basePosition);
      const partCenter = new THREE.Box3().setFromObject(part.object).getCenter(new THREE.Vector3());
      const direction = partCenter.sub(center);
      if (direction.lengthSq() < 0.000001) direction.set((parts.indexOf(part) % 2 ? 1 : -1), 0, 0);
      direction.normalize().multiplyScalar(explode * radius * 0.65);
      part.object.position.copy(base.add(direction));
    }
    renderRef.current();
  }, [explode, parts]);

  useEffect(() => {
    const layer = constraintLayerRef.current;
    if (!layer) return;
    layer.traverse((node: any) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
    layer.clear();
    const byId = new Map(parts.map((part) => [part.id, part]));
    for (const constraint of constraints) {
      const source = byId.get(constraint.sourceId);
      const target = byId.get(constraint.targetId);
      if (!source || !target) continue;
      const a = new THREE.Box3().setFromObject(source.object).getCenter(new THREE.Vector3());
      const b = new THREE.Box3().setFromObject(target.object).getCenter(new THREE.Vector3());
      const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
      const color = constraint.kind === "axis" ? 0x55c7ff
        : constraint.kind === "plane" ? 0xd99bff
        : constraint.kind === "offset" ? 0xffc766 : 0x62e6a7;
      layer.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, linewidth: 2 })));
    }
    renderRef.current();
  }, [constraints, parts, explode]);

  return <div ref={hostRef} style={{ width: "100%", height: "100%", minHeight: 0 }} />;
}

const panelStyle: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
};

const buttonStyle: CSSProperties = {
  minHeight: 32,
  padding: "6px 11px",
  borderRadius: 7,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-panel)",
  color: "var(--fg)",
  fontWeight: 650,
  cursor: "pointer",
};

const fieldStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  padding: "7px 9px",
  borderRadius: 6,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-panel)",
  color: "var(--fg)",
  boxSizing: "border-box",
};

export default function DigitalTwinPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const gltfAssetInputRef = useRef<HTMLInputElement | null>(null);
  const partsRef = useRef<ImportedPart[]>([]);
  const importRunRef = useRef(0);
  const importAbortRef = useRef<AbortController | null>(null);
  const importingRef = useRef(false);
  const [parts, setParts] = useState<ImportedPart[]>([]);
  const [constraints, setConstraints] = useState<AssemblyConstraint[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [constraintKind, setConstraintKind] = useState<ConstraintKind>("mate");
  const [offset, setOffset] = useState(0);
  const [explode, setExplode] = useState(0);
  const [importUnit, setImportUnit] = useState<ImportUnit>("auto");
  const [projection, setProjection] = useState<ProjectionMode>("perspective");
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFiles, setLastFiles] = useState<File[]>([]);
  const [viewerApi, setViewerApi] = useState<ViewerApi | null>(null);

  useEffect(() => { partsRef.current = parts; }, [parts]);
  useEffect(() => () => {
    importRunRef.current += 1;
    importAbortRef.current?.abort();
    importingRef.current = false;
    for (const part of partsRef.current) disposeObject(part.object);
  }, []);

  const selectedPart = parts.find((part) => part.id === selectedId) ?? null;
  const visibleCount = parts.filter((part) => part.visible).length;
  const totalBytes = useMemo(() => parts.reduce((sum, part) => sum + part.bytes, 0), [parts]);

  const importFiles = async (incoming: File[]) => {
    if (importingRef.current || !incoming.length) return;
    const files = Array.from(incoming);
    const modelFiles = files.filter((file) => ACCEPTED_EXTENSIONS.has(extensionOf(file.name)));
    if (!modelFiles.length) {
      setError("No supported 3D model found. Choose STEP, IGES, GLB, GLTF, OBJ, or STL. Linked GLTF assets can be added after choosing the model.");
      return;
    }
    const oversized = modelFiles.find((file) => file.size > MAX_IMPORT_BYTES);
    if (oversized) {
      setError(`${oversized.name} is larger than the 100 MB interactive import limit. Reduce or split the model before importing so the UI remains responsive.`);
      return;
    }
    const aggregateError = aggregateImportError(files);
    if (aggregateError) {
      setError(aggregateError);
      return;
    }

    const importRun = ++importRunRef.current;
    const importAbort = new AbortController();
    importAbortRef.current?.abort();
    importAbortRef.current = importAbort;
    importingRef.current = true;
    setLoading(true);
    setError(null);
    setLastFiles(files);
    const imported: ImportedPart[] = [];
    const failures: string[] = [];
    for (const file of modelFiles) {
      if (importRun !== importRunRef.current) {
        for (const part of imported) disposeObject(part.object);
        return;
      }
      try {
        // Yield between files so a multi-part assembly never turns into one
        // uninterrupted main-thread task. Timers still run when the window is
        // occluded, unlike requestAnimationFrame, and cancellation is checked next.
        await yieldToMainThread();
        const unit = importUnit === "auto" ? defaultModelUnit(extensionOf(file.name)) : importUnit;
        const object = await loadModel(file, files, unit, importAbort.signal);
        if (importRun !== importRunRef.current) {
          disposeObject(object);
          for (const part of imported) disposeObject(part.object);
          return;
        }
        if (!object) throw new Error("The file contained no renderable scene");
        prepareObject(object, file.name);
        applySourceUnit(object, unit);
        const p = object.position ?? new THREE.Vector3();
        const dimensionsMetres = measureObject(object);
        imported.push({
          id: uniqueId("part"),
          name: file.name.replace(/\.[^.]+$/, ""),
          sourceName: file.name,
          format: extensionOf(file.name).toUpperCase(),
          bytes: file.size,
          object,
          basePosition: [p.x, p.y, p.z],
          dimensionsMetres,
          unit,
          sizeWarning: modelSizeWarning(dimensionsMetres),
          visible: true,
        });
      } catch (reason) {
        failures.push(`${file.name}: ${(reason as { message?: string })?.message ?? String(reason)}`);
      }
    }
    if (importRun !== importRunRef.current) {
      for (const part of imported) disposeObject(part.object);
      return;
    }
    importingRef.current = false;
    if (importAbortRef.current === importAbort) importAbortRef.current = null;
    setLoading(false);
    if (imported.length) {
      setParts((current) => [...current, ...imported]);
      setSelectedId(imported[0].id);
      setSourceId((current) => current || imported[0].id);
      setTargetId((current) => current || imported[1]?.id || "");
      window.setTimeout(() => viewerApi?.fit(), 0);
    }
    if (failures.length) setError(`Some files could not be imported. ${failures.join(" · ")}`);
  };

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void importFiles(files);
  };

  const handleGltfAssets = (event: ChangeEvent<HTMLInputElement>) => {
    const companions = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!lastFiles.some((file) => extensionOf(file.name) === "gltf")) {
      setError("Choose the GLTF model first, then add its linked .bin and texture files here.");
      return;
    }
    void importFiles([...lastFiles, ...companions]);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (importingRef.current) {
      setError("An import is already in progress. Wait for it to finish or clear the assembly to cancel it, then drop these files again.");
      return;
    }
    void importFiles(Array.from(event.dataTransfer.files));
  };

  const updatePart = (id: string, patch: Partial<Pick<ImportedPart, "name" | "visible">>) => {
    setParts((current) => current.map((part) => part.id === id ? { ...part, ...patch } : part));
  };

  const updatePartUnit = (id: string, unit: ModelUnit) => {
    setParts((current) => current.map((part) => {
      if (part.id !== id || part.unit === unit) return part;
      const ratio = metresPerModelUnit(unit) / metresPerModelUnit(part.unit);
      part.object.scale.multiplyScalar(ratio);
      const basePosition = part.basePosition.map((value) => value * ratio) as Vector3Tuple;
      part.object.position.set(...basePosition);
      const dimensionsMetres = part.dimensionsMetres.map((value) => value * ratio) as Vector3Tuple;
      return { ...part, basePosition, dimensionsMetres, unit, sizeWarning: modelSizeWarning(dimensionsMetres) };
    }));
    window.setTimeout(() => viewerApi?.fit(), 0);
  };

  const removePart = (id: string) => {
    const part = parts.find((candidate) => candidate.id === id);
    if (part) disposeObject(part.object);
    setParts((current) => current.filter((candidate) => candidate.id !== id));
    setConstraints((current) => current.filter((constraint) => constraint.sourceId !== id && constraint.targetId !== id));
    if (selectedId === id) setSelectedId(null);
    if (sourceId === id) setSourceId("");
    if (targetId === id) setTargetId("");
  };

  const clearAssembly = () => {
    importRunRef.current += 1;
    importAbortRef.current?.abort();
    importAbortRef.current = null;
    importingRef.current = false;
    setLoading(false);
    for (const part of parts) disposeObject(part.object);
    setParts([]);
    setConstraints([]);
    setSelectedId(null);
    setSourceId("");
    setTargetId("");
    setExplode(0);
    setError(null);
  };

  const addConstraint = () => {
    if (!sourceId || !targetId || sourceId === targetId) {
      setError("Choose two different parts before adding a constraint.");
      return;
    }
    setConstraints((current) => [...current, {
      id: uniqueId("constraint"),
      kind: constraintKind,
      sourceId,
      targetId,
      offset: constraintKind === "offset" ? offset : 0,
    }]);
    setError(null);
  };

  const partName = (id: string) => parts.find((part) => part.id === id)?.name ?? "Missing part";

  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg-panel)", color: "var(--fg)" }}>
      <input ref={fileInputRef} type="file" accept={MODEL_ACCEPT} multiple onChange={handleFiles} style={{ display: "none" }} />
      <input ref={gltfAssetInputRef} type="file" accept={GLTF_ASSET_ACCEPT} multiple onChange={handleGltfAssets} style={{ display: "none" }} />

      <header style={{ minHeight: 58, padding: "10px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-card)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ marginRight: 8 }}>
          <div style={{ color: "var(--fg-strong)", fontSize: 18, fontWeight: 800 }}>Digital Twin/3D</div>
          <div style={{ color: "var(--fg-muted)", fontSize: 11 }}>Local assembly workspace · nothing leaves this device</div>
        </div>
        <button type="button" style={{ ...buttonStyle, background: "var(--accent)", color: "var(--accent-fg)", borderColor: "var(--accent)" }} onClick={() => fileInputRef.current?.click()} disabled={loading}>
          {loading ? "Importing…" : "Import 3D"}
        </button>
        <label htmlFor="digital-twin-import-unit" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-muted)", fontSize: 11 }}>
          Source unit
          <select id="digital-twin-import-unit" value={importUnit} onChange={(event) => setImportUnit(event.target.value as ImportUnit)} disabled={loading} style={{ ...fieldStyle, width: "auto", minHeight: 32, padding: "5px 8px" }}>
            <option value="auto">Auto · GLTF m, CAD/OBJ/STL mm</option>
            {UNIT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <button type="button" style={buttonStyle} onClick={() => viewerApi?.fit()} disabled={!parts.length}>Fit assembly</button>
        {(["perspective", "orthographic"] as const).map((mode) => (
          <button key={mode} type="button" aria-pressed={projection === mode} style={{ ...buttonStyle, borderColor: projection === mode ? "var(--accent)" : "var(--border-strong)", background: projection === mode ? "rgba(var(--accent-rgb), 0.16)" : "var(--bg-panel)" }} onClick={() => { setProjection(mode); viewerApi?.setProjection(mode); }}>
            {mode === "orthographic" ? "Orthographic" : "Perspective"}
          </button>
        ))}
        {(["front", "top", "right", "iso"] as const).map((view) => (
          <button key={view} type="button" style={buttonStyle} onClick={() => viewerApi?.setView(view)} disabled={!parts.length}>
            {view === "iso" ? "Isometric" : view[0].toUpperCase() + view.slice(1)}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {parts.length > 0 && (
          <button type="button" style={{ ...buttonStyle, color: "#ff9e9e" }} onClick={clearAssembly}>Clear assembly</button>
        )}
      </header>

      <div
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={handleDrop}
        style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(190px, 250px) minmax(360px, 1fr) minmax(230px, 300px)", gap: 10, padding: 10, position: "relative" }}
      >
        {dragging && (
          <div role="status" style={{ position: "absolute", inset: 10, zIndex: 20, border: "2px dashed var(--accent)", borderRadius: 12, background: "rgba(10, 16, 24, 0.92)", display: "grid", placeItems: "center", color: "var(--fg-strong)", fontSize: 18, fontWeight: 800 }}>
            Drop model files to import
          </div>
        )}

        <aside aria-label="Assembly parts" style={{ ...panelStyle, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "12px 12px 9px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontWeight: 800, color: "var(--fg-strong)" }}>Assembly</div>
            <div style={{ marginTop: 3, fontSize: 11, color: "var(--fg-muted)" }}>{parts.length} parts · {visibleCount} visible · {formatBytes(totalBytes)}</div>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 8 }}>
            {!parts.length && !loading && <div style={{ padding: 12, fontSize: 12, lineHeight: 1.5, color: "var(--fg-muted)" }}>Imported parts appear here. Import several files together to begin an assembly.</div>}
            {loading && Array.from({ length: 4 }, (_, index) => (
              <div key={index} aria-hidden="true" style={{ height: 48, marginBottom: 7, borderRadius: 7, background: "rgba(var(--accent-rgb), 0.09)", border: "1px solid rgba(var(--accent-rgb), 0.12)", opacity: 1 - index * 0.14 }} />
            ))}
            {parts.map((part) => (
              <div key={part.id} style={{ marginBottom: 7, padding: 8, borderRadius: 7, border: part.id === selectedId ? "1px solid var(--accent)" : "1px solid var(--border)", background: part.id === selectedId ? "rgba(var(--accent-rgb), 0.10)" : "var(--bg-panel)" }}>
                <button type="button" onClick={() => setSelectedId(part.id)} style={{ width: "100%", padding: 0, border: 0, background: "transparent", color: "inherit", textAlign: "left", cursor: "pointer" }}>
                  <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700 }}>{part.name}</span>
                  <span style={{ display: "block", marginTop: 2, color: "var(--fg-muted)", fontSize: 10 }}>{part.format} · {formatModelDimensions(part.dimensionsMetres, part.unit)}</span>
                </button>
                <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
                  <button type="button" style={{ ...buttonStyle, minHeight: 26, padding: "3px 7px", fontSize: 11 }} onClick={() => updatePart(part.id, { visible: !part.visible })}>{part.visible ? "Hide" : "Show"}</button>
                  <button type="button" style={{ ...buttonStyle, minHeight: 26, padding: "3px 7px", fontSize: 11, color: "#ff9e9e" }} onClick={() => removePart(part.id)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </aside>

        <main style={{ ...panelStyle, minHeight: 0, position: "relative", overflow: "hidden", background: "#11161d" }}>
          <DigitalTwinViewer
            parts={parts}
            selectedId={selectedId}
            constraints={constraints}
            explode={explode}
            onSelect={setSelectedId}
            onReady={setViewerApi}
            onError={setError}
          />

          {!parts.length && !loading && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 24, pointerEvents: "none" }}>
              <div style={{ width: "min(520px, 90%)", padding: "28px 30px", border: "1px solid var(--border-strong)", borderRadius: 12, background: "color-mix(in srgb, var(--bg-card) 94%, transparent)", textAlign: "center", pointerEvents: "auto" }}>
                <div style={{ color: "var(--fg-strong)", fontSize: 21, fontWeight: 850 }}>Build a digital twin from your 3D parts</div>
                <div style={{ margin: "9px auto 17px", maxWidth: 430, color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.55 }}>Import STEP, IGES, GLB, GLTF, OBJ, or STL locally. Select parts, inspect the assembly, and record mate, axis, plane, or offset intent without changing Studio or agent runs.</div>
                <button type="button" style={{ ...buttonStyle, background: "var(--accent)", color: "var(--accent-fg)", borderColor: "var(--accent)" }} onClick={() => fileInputRef.current?.click()}>Choose 3D files</button>
                <div style={{ marginTop: 10, color: "var(--fg-subtle)", fontSize: 10 }}>STEP and IGES are tessellated locally. For linked GLTF assets, choose the model first; the error action will request only its companion files.</div>
              </div>
            </div>
          )}

          {loading && (
            <div aria-live="polite" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "color-mix(in srgb, var(--bg-panel) 92%, transparent)" }}>
              <div style={{ width: "min(480px, 70%)" }}>
                <div style={{ color: "var(--fg-strong)", fontWeight: 750, marginBottom: 12 }}>Preparing geometry on this device…</div>
                {[100, 83, 92, 64].map((width, index) => <div key={width} style={{ height: index === 0 ? 70 : 12, width: `${width}%`, marginBottom: 9, borderRadius: 6, background: "rgba(var(--accent-rgb), 0.14)", border: "1px solid rgba(var(--accent-rgb), 0.18)" }} />)}
              </div>
            </div>
          )}

          {parts.length > 0 && (
            <div style={{ position: "absolute", left: 12, bottom: 12, width: 210, padding: "8px 10px", borderRadius: 8, background: "color-mix(in srgb, var(--bg-card) 88%, transparent)", border: "1px solid var(--border-strong)" }}>
              <label htmlFor="digital-twin-explode" style={{ display: "flex", justifyContent: "space-between", color: "var(--fg-strong)", fontSize: 11, fontWeight: 700 }}><span>Exploded view</span><span>{Math.round(explode * 100)}%</span></label>
              <input id="digital-twin-explode" type="range" min="0" max="1" step="0.01" value={explode} onChange={(event) => setExplode(Number(event.target.value))} style={{ width: "100%", accentColor: "var(--accent)" }} />
            </div>
          )}
          {parts.length > 0 && <div style={{ position: "absolute", right: 12, bottom: 12, padding: "6px 8px", borderRadius: 7, background: "color-mix(in srgb, var(--bg-card) 88%, transparent)", border: "1px solid var(--border-strong)", color: "var(--fg-muted)", fontSize: 10 }}>Scene normalized to metres · adaptive grid</div>}
        </main>

        <aside aria-label="Digital twin inspector" style={{ ...panelStyle, minHeight: 0, overflow: "auto", padding: 12 }}>
          <section>
            <div style={{ fontWeight: 800, color: "var(--fg-strong)", marginBottom: 9 }}>Part inspector</div>
            {selectedPart ? (
              <>
                <label style={{ display: "block", marginBottom: 5, color: "var(--fg-muted)", fontSize: 11 }} htmlFor="digital-twin-part-name">Part name</label>
                <input id="digital-twin-part-name" value={selectedPart.name} onChange={(event) => updatePart(selectedPart.id, { name: event.target.value })} style={fieldStyle} />
                <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.55, color: "var(--fg-muted)" }}>
                  Source: {selectedPart.sourceName}<br />Format: {selectedPart.format}<br />File size: {formatBytes(selectedPart.bytes)}<br />Dimensions: {formatModelDimensions(selectedPart.dimensionsMetres, selectedPart.unit)}
                </div>
                <label style={{ display: "block", margin: "9px 0 4px", color: "var(--fg-muted)", fontSize: 11 }} htmlFor="digital-twin-part-unit">Source unit</label>
                <select id="digital-twin-part-unit" value={selectedPart.unit} onChange={(event) => updatePartUnit(selectedPart.id, event.target.value as ModelUnit)} style={fieldStyle}>
                  {UNIT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <div style={{ marginTop: 5, color: "var(--fg-subtle)", fontSize: 10, lineHeight: 1.45 }}>STEP/IGES units are converted during tessellation. OBJ and STL do not store units; correct those if the displayed dimensions do not match the source.</div>
                {selectedPart.sizeWarning && <div role="status" style={{ marginTop: 8, padding: "7px 8px", border: "1px solid rgba(255, 190, 90, 0.45)", borderRadius: 6, color: "var(--fg-strong)", background: "rgba(255, 190, 90, 0.08)", fontSize: 10, lineHeight: 1.45 }}>{selectedPart.sizeWarning}</div>}
              </>
            ) : <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5 }}>Select a part in the list or viewport to inspect it.</div>}
          </section>

          <div style={{ height: 1, background: "var(--border)", margin: "16px 0" }} />

          <section>
            <div style={{ fontWeight: 800, color: "var(--fg-strong)" }}>Constraint intent</div>
            <div style={{ margin: "4px 0 10px", color: "var(--fg-muted)", fontSize: 11, lineHeight: 1.45 }}>Record how two parts should relate. Lines in the viewport are drafts; they do not alter source geometry.</div>
            <label htmlFor="digital-twin-constraint-kind" style={{ display: "block", marginBottom: 4, color: "var(--fg-muted)", fontSize: 11 }}>Type</label>
            <select id="digital-twin-constraint-kind" value={constraintKind} onChange={(event) => setConstraintKind(event.target.value as ConstraintKind)} style={fieldStyle}>
              <option value="mate">Mate</option>
              <option value="axis">Axis align</option>
              <option value="plane">Plane align</option>
              <option value="offset">Offset</option>
            </select>
            <label htmlFor="digital-twin-source-part" style={{ display: "block", margin: "9px 0 4px", color: "var(--fg-muted)", fontSize: 11 }}>From part</label>
            <select id="digital-twin-source-part" value={sourceId} onChange={(event) => setSourceId(event.target.value)} style={fieldStyle}>
              <option value="">Choose a part…</option>
              {parts.map((part) => <option key={part.id} value={part.id}>{part.name}</option>)}
            </select>
            <label htmlFor="digital-twin-target-part" style={{ display: "block", margin: "9px 0 4px", color: "var(--fg-muted)", fontSize: 11 }}>To part</label>
            <select id="digital-twin-target-part" value={targetId} onChange={(event) => setTargetId(event.target.value)} style={fieldStyle}>
              <option value="">Choose a part…</option>
              {parts.map((part) => <option key={part.id} value={part.id}>{part.name}</option>)}
            </select>
            {constraintKind === "offset" && (
              <>
                <label htmlFor="digital-twin-offset" style={{ display: "block", margin: "9px 0 4px", color: "var(--fg-muted)", fontSize: 11 }}>Offset (metres)</label>
                <input id="digital-twin-offset" type="number" value={offset} onChange={(event) => setOffset(Number(event.target.value))} style={fieldStyle} />
              </>
            )}
            <button type="button" onClick={addConstraint} disabled={parts.length < 2} style={{ ...buttonStyle, width: "100%", marginTop: 10, background: parts.length >= 2 ? "rgba(var(--accent-rgb), 0.18)" : "var(--bg-panel)", cursor: parts.length >= 2 ? "pointer" : "not-allowed" }}>Add constraint</button>
          </section>

          <div style={{ marginTop: 13 }}>
            {constraints.length === 0 ? (
              <div style={{ padding: 10, border: "1px dashed var(--border-strong)", borderRadius: 7, color: "var(--fg-muted)", fontSize: 11 }}>No constraints yet. Import at least two parts to define one.</div>
            ) : constraints.map((constraint) => (
              <div key={constraint.id} style={{ padding: 8, marginBottom: 7, border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-panel)", fontSize: 11 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <strong style={{ color: "var(--fg-strong)", textTransform: "capitalize" }}>{constraint.kind}</strong>
                  <span style={{ flex: 1 }} />
                  <button type="button" aria-label={`Remove ${constraint.kind} constraint`} onClick={() => setConstraints((current) => current.filter((item) => item.id !== constraint.id))} style={{ border: 0, background: "transparent", color: "#ff9e9e", cursor: "pointer", fontWeight: 700 }}>Remove</button>
                </div>
                <div style={{ marginTop: 4, color: "var(--fg-muted)", overflowWrap: "anywhere" }}>{partName(constraint.sourceId)} → {partName(constraint.targetId)}{constraint.kind === "offset" ? ` · ${constraint.offset} m` : ""}</div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {error && (
        <div role="alert" style={{ margin: "0 10px 10px", padding: "9px 11px", borderRadius: 8, border: "1px solid rgba(255, 120, 120, 0.45)", background: "rgba(255, 90, 90, 0.10)", color: "#ffb1b1", display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
          <span style={{ flex: 1 }}>{error}</span>
          {lastFiles.some((file) => extensionOf(file.name) === "gltf") && error.includes("Missing linked asset") && <button type="button" style={buttonStyle} onClick={() => gltfAssetInputRef.current?.click()} disabled={loading}>Add linked GLTF files</button>}
          {lastFiles.length > 0 && <button type="button" style={buttonStyle} onClick={() => void importFiles(lastFiles)} disabled={loading}>Retry import</button>}
          <button type="button" style={buttonStyle} onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
