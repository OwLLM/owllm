import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
// three is bundled with OwLLM; the repository intentionally does not carry
// the optional @types package (same convention as TeamMemoryGraph).
// @ts-ignore: bundled dependency has no local declaration package
import * as THREE from "three";
// @ts-ignore: bundled Three.js example module
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useLocalization } from "../../localization";
import { getIdentity, listDevices, type DeviceRecord } from "../advanced/remoteDevices";
import {
  loadWorldPresence,
  readPresenceEnabled,
  readWorldMapMode,
  savePresenceEnabled,
  saveWorldMapMode,
  sendAnonymousHeartbeat,
  type PublicPresenceNode,
  type WorldMapMode,
} from "./worldPresence";

type GlobeNode = {
  id: string;
  label: string;
  detail: string;
  latitude: number;
  longitude: number;
  online: boolean;
  kind: "world" | "fleet";
};

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const CONTINENTS: Array<Array<[number, number]>> = [
  [[-168,72],[-145,70],[-128,55],[-124,44],[-112,31],[-96,18],[-82,25],[-79,44],[-62,49],[-54,61],[-73,72],[-105,82],[-140,78]],
  [[-81,12],[-68,9],[-51,-2],[-35,-10],[-43,-23],[-53,-34],[-66,-55],[-73,-41],[-78,-18]],
  [[-18,35],[-5,45],[18,57],[42,71],[75,73],[103,77],[135,58],[158,54],[146,36],[122,19],[104,6],[78,8],[58,26],[40,31],[31,42],[12,37]],
  [[-17,34],[10,37],[33,31],[49,12],[42,-13],[30,-34],[17,-35],[3,-24],[-9,4]],
  [[112,-11],[132,-10],[154,-26],[147,-39],[123,-35]],
  [[-52,60],[-28,72],[-38,83],[-61,82]],
];

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function fleetCoordinates(id: string): { latitude: number; longitude: number } {
  const hash = hashNumber(id);
  return {
    latitude: ((hash % 12000) / 100) - 60,
    longitude: (((hash >>> 12) % 36000) / 100) - 180,
  };
}

function recent(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  const value = Date.parse(lastSeen);
  return Number.isFinite(value) && Date.now() - value < 5 * 60_000;
}

function latLonVector(latitude: number, longitude: number, radius: number) {
  const phi = (90 - latitude) * Math.PI / 180;
  const theta = (longitude + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function earthTexture(accent: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#08152c");
  gradient.addColorStop(0.5, "#03101f");
  gradient.addColorStop(1, "#07162b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(125,180,235,.15)";
  ctx.lineWidth = 1;
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = (lon + 180) / 360 * canvas.width;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = (90 - lat) / 180 * canvas.height;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }

  ctx.globalAlpha = 0.5;
  ctx.fillStyle = accent;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  for (const polygon of CONTINENTS) {
    ctx.beginPath();
    polygon.forEach(([lon, lat], index) => {
      const x = (lon + 180) / 360 * canvas.width;
      const y = (90 - lat) / 180 * canvas.height;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function useThemeColors() {
  const read = () => {
    const style = getComputedStyle(document.documentElement);
    return { accent: style.getPropertyValue("--accent").trim() || "#72d9ff" };
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
    return () => observer.disconnect();
  }, []);
  return colors;
}

function Globe({ nodes, accent, onSelect }: {
  nodes: GlobeNode[];
  accent: string;
  onSelect: (node: GlobeNode) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0.4, 8.4);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute("aria-label", "Interactive 3D OWLLM world map");
    renderer.domElement.setAttribute("role", "img");
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 5.4;
    controls.maxDistance = 12;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.42;

    const earthMap = earthTexture(accent);
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(2.35, 72, 48),
      new THREE.MeshPhongMaterial({ map: earthMap, shininess: 18, specular: new THREE.Color(accent).multiplyScalar(0.3) }),
    );
    scene.add(globe);
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(2.43, 64, 40),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.08, side: THREE.BackSide }),
    );
    scene.add(atmosphere);
    const outerGlow = new THREE.Mesh(
      new THREE.SphereGeometry(2.55, 48, 32),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.035, side: THREE.BackSide }),
    );
    scene.add(outerGlow);

    const starsGeometry = new THREE.BufferGeometry();
    const starPositions = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const radius = 12 + (i % 17) * 0.45;
      const theta = (i * 2.399963) % (Math.PI * 2);
      const z = 1 - 2 * ((i * 37 % 899) / 899);
      const planar = Math.sqrt(1 - z * z);
      starPositions[i * 3] = radius * planar * Math.cos(theta);
      starPositions[i * 3 + 1] = radius * z;
      starPositions[i * 3 + 2] = radius * planar * Math.sin(theta);
    }
    starsGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    scene.add(new THREE.Points(starsGeometry, new THREE.PointsMaterial({ color: 0xa8c8ff, size: 0.022, transparent: true, opacity: 0.6 })));

    scene.add(new THREE.AmbientLight(0x7b9ac8, 1.6));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(5, 3, 6);
    scene.add(keyLight);
    const rimLight = new THREE.PointLight(new THREE.Color(accent), 3, 18);
    rimLight.position.set(-5, -1, -4);
    scene.add(rimLight);

    const clickable: any[] = [];
    const pulseMeshes: any[] = [];
    nodes.forEach((node, index) => {
      const radius = node.kind === "fleet" ? 2.82 + (index % 3) * 0.22 : 2.39;
      const position = latLonVector(node.latitude, node.longitude, radius);
      if (node.kind === "fleet") {
        const orbit = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, i) => {
            const angle = i / 96 * Math.PI * 2;
            return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
          })),
          new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.09 }),
        );
        orbit.rotation.x = ((hashNumber(node.id) % 70) - 35) * Math.PI / 180;
        orbit.rotation.z = ((hashNumber(node.id + "z") % 60) - 30) * Math.PI / 180;
        scene.add(orbit);
      }
      const mesh = new THREE.Mesh(
        node.kind === "fleet" ? new THREE.OctahedronGeometry(0.095, 0) : new THREE.SphereGeometry(0.065, 16, 12),
        new THREE.MeshBasicMaterial({ color: node.online ? accent : 0x718096 }),
      );
      mesh.position.copy(position);
      mesh.userData.node = node;
      scene.add(mesh);
      clickable.push(mesh);

      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(node.kind === "fleet" ? 0.19 : 0.14, 16, 12),
        new THREE.MeshBasicMaterial({ color: node.online ? accent : 0x718096, transparent: true, opacity: node.online ? 0.2 : 0.08 }),
      );
      halo.position.copy(position);
      halo.userData.offset = index * 0.63;
      scene.add(halo);
      pulseMeshes.push(halo);
    });

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const click = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(clickable, false)[0];
      if (hit?.object?.userData?.node) onSelect(hit.object.userData.node as GlobeNode);
    };
    renderer.domElement.addEventListener("pointerup", click);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    let frame = 0;
    const started = performance.now();
    const animate = (now: number) => {
      const elapsed = (now - started) / 1000;
      globe.rotation.y = elapsed * 0.012;
      atmosphere.rotation.y = -elapsed * 0.018;
      pulseMeshes.forEach((mesh) => {
        const scale = 0.82 + (Math.sin(elapsed * 2.4 + mesh.userData.offset) + 1) * 0.18;
        mesh.scale.setScalar(scale);
      });
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerup", click);
      controls.dispose();
      earthMap.dispose();
      scene.traverse((object: any) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) object.material.forEach((material: any) => material.dispose?.());
        else object.material?.dispose?.();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [accent, nodes, onSelect]);

  return <div ref={hostRef} data-ui="WorldMap:globe" style={{ position: "absolute", inset: 0 }} />;
}

function panelStyle(): CSSProperties {
  return {
    background: "linear-gradient(145deg, rgba(var(--accent-rgb),.10), var(--bg-card) 48%)",
    border: "1px solid var(--border-strong)",
    borderRadius: 16,
    boxShadow: "var(--shadow-lg)",
  };
}

export default function WorldMapPage() {
  const { t } = useLocalization();
  const colors = useThemeColors();
  const [mode, setMode] = useState<WorldMapMode>(readWorldMapMode);
  const [publicNodes, setPublicNodes] = useState<PublicPresenceNode[]>([]);
  const [fleet, setFleet] = useState<DeviceRecord[]>([]);
  const [selfId, setSelfId] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [presenceEnabled, setPresenceEnabled] = useState(readPresenceEnabled);
  const [selected, setSelected] = useState<GlobeNode | null>(null);

  useEffect(() => { saveWorldMapMode(mode); setSelected(null); }, [mode]);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      setLoading(true);
      try {
        const snapshot = await loadWorldPresence(controller.signal);
        setConfigured(snapshot.configured);
        setPublicNodes(snapshot.nodes);
        setError("");
      } catch (reason) {
        setConfigured(true);
        setError(String(reason));
      } finally {
        setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!presenceEnabled) return;
    const controller = new AbortController();
    const heartbeat = async () => {
      try {
        const sent = await sendAnonymousHeartbeat(true, controller.signal);
        if (!sent) setConfigured(false);
      } catch (reason) {
        if (!controller.signal.aborted) setError(String(reason));
      }
    };
    void heartbeat();
    const timer = window.setInterval(heartbeat, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [presenceEnabled]);

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    const refresh = async () => {
      try {
        const [identity, devices] = await Promise.all([getIdentity(), listDevices()]);
        if (!alive) return;
        setSelfId(identity.device_id);
        setFleet(devices);
      } catch { /* Devices may be disabled; the map remains usable. */ }
    };
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const togglePresence = async (enabled: boolean) => {
    setPresenceEnabled(enabled);
    savePresenceEnabled(enabled);
    try {
      const sent = await sendAnonymousHeartbeat(enabled);
      if (!sent) setConfigured(false);
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  };

  const nodes = useMemo<GlobeNode[]>(() => mode === "world"
    ? publicNodes.map((node) => ({
        id: node.id,
        label: node.region || t("Anonymous OWLLM node"),
        detail: t("Approximate server region"),
        latitude: node.latitude,
        longitude: node.longitude,
        online: true,
        kind: "world",
      }))
    : fleet.map((device) => {
        const coords = fleetCoordinates(device.device_id);
        const online = device.is_self || recent(device.last_seen);
        return {
          id: device.device_id,
          label: device.is_self || device.device_id === selfId ? t("This device") : device.name,
          detail: `${device.os} · ${online ? t("Online") : t("Offline")}`,
          ...coords,
          online,
          kind: "fleet" as const,
        };
      }), [fleet, mode, publicNodes, selfId, t]);

  const onlineCount = nodes.filter((node) => node.online).length;

  return (
    <div data-ui="WorldMapPage" style={{ height: "100%", minHeight: 0, overflow: "auto", padding: "18px 20px", color: "var(--fg)" }}>
      <div style={{ width: "100%", maxWidth: 1500, minHeight: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 18, flexWrap: "wrap" }}>
          <div>
            <div style={{ color: "var(--accent-ink)", fontSize: 11, fontWeight: 800, letterSpacing: 2.4, textTransform: "uppercase" }}>{t("OWLLM Network")}</div>
            <h1 style={{ margin: "4px 0 5px", fontSize: "clamp(28px, 4vw, 48px)", lineHeight: 1, color: "var(--fg-strong)" }}>{t("World Map")}</h1>
            <div style={{ color: "var(--fg-muted)", fontSize: 13.5 }}>{t("Anonymous presence around the world and your private device fleet.")}</div>
          </div>
          <div role="tablist" aria-label={t("World map mode")} style={{ display: "flex", padding: 4, gap: 4, borderRadius: 13, background: "var(--bg-elevated)", border: "1px solid var(--border-strong)" }}>
            {(["world", "fleet"] as const).map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                style={{
                  minHeight: 38, padding: "0 17px", border: mode === value ? "1px solid var(--accent-strong)" : "1px solid transparent",
                  borderRadius: 10, background: mode === value ? "rgba(var(--accent-rgb),.16)" : "transparent",
                  color: mode === value ? "var(--accent-ink)" : "var(--fg-muted)", fontWeight: 750, cursor: "pointer",
                }}
              >{value === "world" ? t("Live World") : t("My Fleet")}</button>
            ))}
          </div>
        </header>

        <div className="world-map-layout" style={{ display: "grid", gap: 14, flex: 1, minHeight: 560 }}>
          <section className="world-map-globe-panel" style={{ ...panelStyle(), position: "relative", minHeight: 560, overflow: "hidden", background: "radial-gradient(circle at 50% 45%, rgba(var(--accent-rgb),.10), #030711 67%, #01030a)" }}>
            <Globe nodes={nodes} accent={colors.accent} onSelect={setSelected} />
            <div style={{ position: "absolute", top: 13, left: 13, display: "flex", gap: 8, pointerEvents: "none" }}>
              <span style={{ padding: "5px 9px", borderRadius: 999, background: "rgba(2,6,16,.72)", border: "1px solid rgba(var(--accent-rgb),.28)", color: "var(--fg-strong)", fontSize: 11.5 }}>
                <b style={{ color: "var(--accent-ink)" }}>{onlineCount}</b> {mode === "world" ? t("nodes online") : t("devices online")}
              </span>
              <span style={{ padding: "5px 9px", borderRadius: 999, background: "rgba(2,6,16,.72)", border: "1px solid var(--border)", color: "var(--fg-muted)", fontSize: 11.5 }}>{t("Drag to orbit · scroll to zoom")}</span>
            </div>
            {mode === "world" && !configured && !loading && (
              <div style={{ position: "absolute", inset: "auto 18px 18px 18px", padding: "12px 14px", borderRadius: 12, border: "1px solid rgba(var(--accent-rgb),.35)", background: "rgba(3,7,17,.88)", backdropFilter: "blur(12px)", color: "var(--fg-muted)", fontSize: 12.5 }}>
                <b style={{ color: "var(--fg-strong)" }}>{t("World presence service is not connected yet.")}</b>{" "}
                {t("The globe is ready; real anonymous nodes will appear when the presence endpoint is configured.")}
              </div>
            )}
          </section>

          <aside style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div style={{ ...panelStyle(), padding: 15 }}>
              <div style={{ fontSize: 11, color: "var(--accent-ink)", fontWeight: 800, letterSpacing: 1.3, textTransform: "uppercase" }}>{mode === "world" ? t("Live World") : t("My Fleet")}</div>
              <div style={{ marginTop: 7, fontSize: 25, fontWeight: 800, color: "var(--fg-strong)" }}>{nodes.length}</div>
              <div style={{ color: "var(--fg-muted)", fontSize: 12.5 }}>{mode === "world" ? t("anonymous active installations") : t("paired OwLLM devices")}</div>
            </div>

            {mode === "world" && (
              <label style={{ ...panelStyle(), padding: 15, display: "flex", gap: 11, cursor: "pointer", alignItems: "flex-start" }}>
                <input type="checkbox" checked={presenceEnabled} onChange={(event) => void togglePresence(event.target.checked)} style={{ marginTop: 3, width: 17, height: 17, accentColor: "var(--accent)" }} />
                <span>
                  <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 13.5, fontWeight: 750 }}>{t("Appear anonymously")}</span>
                  <span style={{ display: "block", marginTop: 4, color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.45 }}>{t("Shares no name, account, device, project, prompt, or exact coordinates.")}</span>
                </span>
              </label>
            )}

            <div style={{ ...panelStyle(), padding: 15, flex: 1, minHeight: 180, overflow: "auto" }}>
              <div style={{ color: "var(--fg-strong)", fontWeight: 750, fontSize: 13, marginBottom: 10 }}>{t("Network signals")}</div>
              {error && <div style={{ color: "var(--error)", fontSize: 11.5, marginBottom: 10 }}>{error}</div>}
              {nodes.length === 0 ? (
                <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5 }}>
                  {loading ? t("Scanning the network…") : mode === "world" ? t("No live presence data yet.") : t("No paired devices found.")}
                </div>
              ) : nodes.map((node) => (
                <button key={node.id} onClick={() => setSelected(node)} style={{ width: "100%", display: "grid", gridTemplateColumns: "9px minmax(0,1fr)", gap: 9, textAlign: "left", padding: "9px 7px", border: "none", borderBottom: "1px solid var(--border)", background: selected?.id === node.id ? "rgba(var(--accent-rgb),.10)" : "transparent", color: "var(--fg)", cursor: "pointer" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", marginTop: 5, background: node.online ? "var(--accent)" : "var(--fg-dim)", boxShadow: node.online ? "0 0 9px var(--accent)" : "none" }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.label}</span>
                    <span style={{ display: "block", marginTop: 2, fontSize: 10.5, color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.detail}</span>
                  </span>
                </button>
              ))}
            </div>

            {selected && (
              <div style={{ ...panelStyle(), padding: 15, borderColor: "var(--accent-strong)" }}>
                <div style={{ color: "var(--fg-strong)", fontWeight: 800 }}>{selected.label}</div>
                <div style={{ marginTop: 4, color: "var(--fg-muted)", fontSize: 11.5 }}>{selected.detail}</div>
                <div style={{ marginTop: 9, color: "var(--accent-ink)", fontSize: 10.5, fontWeight: 700 }}>{selected.kind === "fleet" ? t("Private fleet orbit · not a location") : t("Coarse server region only")}</div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
