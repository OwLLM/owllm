import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
// three is bundled with OwLLM; the repository intentionally does not carry
// the optional @types package (same convention as TeamMemoryGraph).
// @ts-ignore: bundled dependency has no local declaration package
import * as THREE from "three";
// @ts-ignore: bundled Three.js example module
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useLocalization } from "../../localization";
import { getIdentity, listDevices, type DeviceIdentity, type DeviceRecord } from "../advanced/remoteDevices";
import {
  includeSelfDevice,
  readPresenceEnabled,
  readWorldMapMode,
  savePresenceEnabled,
  saveWorldMapMode,
  subscribeWorldPresence,
  type PublicPresenceNode,
  type WorldMapMode,
} from "./worldPresence";

type OrbitParams = {
  radius: number;
  inclination: number;
  ascendingNode: number;
  phase: number;
  speed: number;
};

type GlobeNode = {
  id: string;
  label: string;
  detail: string;
  online: boolean;
  kind: "world" | "fleet";
  // World mode: surface coordinates from the presence service.
  latitude?: number;
  longitude?: number;
  // Fleet mode: each paired device is a private satellite in a stable orbit.
  orbit?: OrbitParams;
};

const EARTH_TEXTURES = {
  day: "/world-map/earth-day.jpg",
  normal: "/world-map/earth-normal.jpg",
  specular: "/world-map/earth-specular.jpg",
  clouds: "/world-map/earth-clouds.png",
} as const;

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function fleetOrbit(id: string): OrbitParams {
  const h = hashNumber(id);
  const h2 = hashNumber(`${id}:orbit`);
  return {
    radius: 2.95 + ((h % 1000) / 1000) * 1.55,
    inclination: ((h % 160) - 80) * Math.PI / 180,
    ascendingNode: (h2 % 360) * Math.PI / 180,
    phase: ((h2 >>> 10) % 360) * Math.PI / 180,
    speed: (0.12 + ((h % 500) / 500) * 0.42) * (h % 2 === 0 ? 1 : -1),
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

function orbitPosition(orbit: OrbitParams, elapsed: number) {
  const theta = orbit.phase + orbit.speed * elapsed;
  const cosI = Math.cos(orbit.inclination);
  const sinI = Math.sin(orbit.inclination);
  const cosO = Math.cos(orbit.ascendingNode);
  const sinO = Math.sin(orbit.ascendingNode);
  const xp = orbit.radius * Math.cos(theta);
  const yp = orbit.radius * Math.sin(theta);
  const xpp = xp;
  const ypp = yp * cosI;
  const zpp = yp * sinI;
  return new THREE.Vector3(
    xpp * cosO + zpp * sinO,
    ypp,
    -xpp * sinO + zpp * cosO,
  );
}

function fleetWithSelf(identity: DeviceIdentity, devices: DeviceRecord[]): DeviceRecord[] {
  if (devices.some((device) => device.device_id === identity.device_id)) return devices;
  const self: DeviceRecord = {
    device_id: identity.device_id,
    name: identity.name,
    ed25519_pub: identity.ed25519_pub,
    x25519_pub: identity.x25519_pub,
    os: identity.os,
    arch: identity.arch,
    app_version: identity.app_version,
    github_login: identity.github_login,
    capabilities: identity.capabilities,
    endpoint: identity.endpoint,
    endpoints: identity.endpoints,
    p2p_node_id: identity.p2p_node_id,
    last_seen: new Date().toISOString(),
    is_self: true,
  };
  return includeSelfDevice(self, devices);
}

function satelliteLabel(text: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 112;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "700 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,.95)";
  ctx.shadowBlur = 12;
  ctx.fillStyle = "rgba(2,8,20,.84)";
  ctx.beginPath();
  ctx.roundRect(10, 10, 492, 92, 32);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.shadowBlur = 5;
  ctx.fillStyle = "#f4f8ff";
  ctx.fillText(text.slice(0, 24), 256, 57);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.18, 0.26, 1);
  return sprite;
}

function atmosphereMaterial(accent: string) {
  return new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      color: { value: new THREE.Color(accent) },
    },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 color;
      varying vec3 vNormal;
      void main() {
        float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.6);
        gl_FragColor = vec4(color, fresnel * 0.55);
      }
    `,
  });
}

function useThemeColors() {
  const read = () => {
    const style = getComputedStyle(document.documentElement);
    return {
      accent: style.getPropertyValue("--accent").trim() || "#72d9ff",
      accentInk: style.getPropertyValue("--accent-ink").trim() || "#72d9ff",
    };
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
    return () => observer.disconnect();
  }, []);
  return colors;
}

function Globe({ nodes, accent, selectedId, onSelect }: {
  nodes: GlobeNode[];
  accent: string;
  selectedId: string | null;
  onSelect: (node: GlobeNode) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Live inputs flow into the animation loop / rebuild through refs so that
  // selecting a node, refreshing the fleet, or switching mode never re-runs
  // the scene-building effect below. Rebuilding the WebGL renderer + Earth
  // textures on every button click is what made the whole globe flash and
  // restart — the GUI was hostage to the right-column buttons.
  const nodesRef = useRef(nodes);
  const selectedIdRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  const rebuildNodesRef = useRef<(() => void) | null>(null);
  nodesRef.current = nodes;
  selectedIdRef.current = selectedId;
  onSelectRef.current = onSelect;

  // Scene is built ONCE per theme accent. Node data / selection / pointer
  // callbacks are read from refs, never from this effect's dependency array.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0.24, 9.4);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    renderer.domElement.setAttribute("aria-label", "Interactive 3D OWLLM world map");
    renderer.domElement.setAttribute("role", "img");
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 5.8;
    controls.maxDistance = 15;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.32;

    const textureLoader = new THREE.TextureLoader();
    const earthMap = textureLoader.load(EARTH_TEXTURES.day);
    const earthNormal = textureLoader.load(EARTH_TEXTURES.normal);
    const earthSpecular = textureLoader.load(EARTH_TEXTURES.specular);
    const cloudMap = textureLoader.load(EARTH_TEXTURES.clouds);
    earthMap.colorSpace = THREE.SRGBColorSpace;
    cloudMap.colorSpace = THREE.SRGBColorSpace;
    const maxAnisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    earthMap.anisotropy = maxAnisotropy;
    earthNormal.anisotropy = maxAnisotropy;
    earthSpecular.anisotropy = maxAnisotropy;
    cloudMap.anisotropy = maxAnisotropy;

    const earthGroup = new THREE.Group();
    earthGroup.rotation.z = -0.14;
    scene.add(earthGroup);
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(2.35, 128, 64),
      new THREE.MeshPhongMaterial({
        map: earthMap,
        normalMap: earthNormal,
        normalScale: new THREE.Vector2(0.48, 0.48),
        specularMap: earthSpecular,
        specular: new THREE.Color(0x557799),
        shininess: 18,
      }),
    );
    earthGroup.add(globe);

    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(2.382, 128, 64),
      new THREE.MeshPhongMaterial({
        map: cloudMap,
        transparent: true,
        opacity: 0.68,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    earthGroup.add(clouds);

    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(2.47, 96, 64), atmosphereMaterial(accent));
    scene.add(atmosphere);
    const outerGlow = new THREE.Mesh(
      new THREE.SphereGeometry(2.56, 80, 48),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.035, side: THREE.BackSide, depthWrite: false }),
    );
    scene.add(outerGlow);

    // Starfield.
    const starsGeometry = new THREE.BufferGeometry();
    const starCount = 2500;
    const starPositions = new Float32Array(starCount * 3);
    const starSizes = new Float32Array(starCount);
    for (let i = 0; i < starCount; i++) {
      const radius = 14 + (i % 23) * 0.32;
      const theta = (i * 2.399963) % (Math.PI * 2);
      const z = 1 - 2 * ((i * 37 % 997) / 997);
      const planar = Math.sqrt(1 - z * z);
      starPositions[i * 3] = radius * planar * Math.cos(theta);
      starPositions[i * 3 + 1] = radius * z;
      starPositions[i * 3 + 2] = radius * planar * Math.sin(theta);
      starSizes[i] = 0.015 + (i % 7) * 0.004;
    }
    starsGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    starsGeometry.setAttribute("size", new THREE.BufferAttribute(starSizes, 1));
    scene.add(new THREE.Points(starsGeometry, new THREE.PointsMaterial({
      color: 0xc9ddff,
      size: 0.025,
      transparent: true,
      opacity: 0.75,
      sizeAttenuation: true,
    })));

    scene.add(new THREE.HemisphereLight(0x91bdff, 0x071224, 1.25));
    scene.add(new THREE.AmbientLight(0x8aaee0, 0.42));
    const sunLight = new THREE.DirectionalLight(0xffffff, 3.9);
    sunLight.position.set(5.8, 2.6, 7.2);
    scene.add(sunLight);
    const rimLight = new THREE.PointLight(new THREE.Color(accent), 1.6, 20);
    rimLight.position.set(-6, -1.5, -5);
    scene.add(rimLight);

    // Node layer — rebuilt in place (arrays are cleared + repopulated, never
    // reassigned) so the animation loop and click handler keep working across
    // rebuilds without re-running this effect.
    const clickable: THREE.Mesh[] = [];
    const pulseMeshes: THREE.Mesh[] = [];
    const orbitRings: { line: THREE.LineLoop; node: GlobeNode }[] = [];
    const nodeMeshes: { mesh: THREE.Mesh; halo: THREE.Mesh; label?: THREE.Sprite; node: GlobeNode; baseScale: number }[] = [];
    let hasFleet = false;

    const disposeNodeObject = (object: any) => {
      scene.remove(object);
      object.geometry?.dispose?.();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((m: any) => { m.map?.dispose?.(); m.dispose?.(); });
      else if (material) { material.map?.dispose?.(); material.dispose?.(); }
    };

    const buildNodes = () => {
      orbitRings.forEach(({ line }) => disposeNodeObject(line));
      nodeMeshes.forEach(({ mesh, halo, label }) => { disposeNodeObject(mesh); disposeNodeObject(halo); if (label) disposeNodeObject(label); });
      clickable.length = 0;
      pulseMeshes.length = 0;
      orbitRings.length = 0;
      nodeMeshes.length = 0;

      const list = nodesRef.current;
      list.forEach((node, index) => {
        const color = node.online ? accent : 0x718096;
        const baseScale = node.kind === "fleet" ? 1 : 1;

        if (node.kind === "fleet" && node.orbit) {
          const orbit = node.orbit;
          const ringGeometry = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 192 }, (_, i) =>
            orbitPosition({ ...orbit, phase: i / 192 * Math.PI * 2, speed: 0 }, 0),
          ));
          const ring = new THREE.LineLoop(ringGeometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: node.online ? 0.34 : 0.14 }));
          scene.add(ring);
          orbitRings.push({ line: ring, node });
        }

        const geometry = node.kind === "fleet"
          ? new THREE.OctahedronGeometry(0.15, 1)
          : new THREE.SphereGeometry(0.07, 20, 16);
        const material = new THREE.MeshStandardMaterial({
          color,
          emissive: new THREE.Color(color).multiplyScalar(node.online ? 0.6 : 0.1),
          roughness: 0.3,
          metalness: 0.4,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.node = node;
        scene.add(mesh);
        clickable.push(mesh);

        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(node.kind === "fleet" ? 0.31 : 0.16, 24, 18),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: node.online ? 0.30 : 0.09, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        halo.userData.offset = index * 0.63;
        scene.add(halo);
        pulseMeshes.push(halo);

        const label = node.kind === "fleet" ? satelliteLabel(node.label, new THREE.Color(color).getStyle()) : undefined;
        if (label) scene.add(label);
        nodeMeshes.push({ mesh, halo, label, node, baseScale });
      });

      // Reframe only when fleet-satellite presence actually changes (initial
      // populate or a real mode switch) — not on selection or the 30s poll,
      // so the user's current orbit/zoom is preserved.
      const nextHasFleet = list.some((node) => node.kind === "fleet");
      if (nextHasFleet !== hasFleet) {
        hasFleet = nextHasFleet;
        controls.minDistance = hasFleet ? 8.4 : 5.8;
        camera.position.set(0, 0.24, hasFleet ? 11.8 : 9.4);
      }
    };

    rebuildNodesRef.current = buildNodes;
    buildNodes();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const click = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(clickable, false)[0];
      if (hit?.object?.userData?.node) onSelectRef.current(hit.object.userData.node as GlobeNode);
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
      globe.rotation.y = elapsed * 0.018 - 0.34;
      clouds.rotation.y = elapsed * 0.024 - 0.34;
      atmosphere.rotation.y = elapsed * 0.018;
      outerGlow.rotation.y = -elapsed * 0.006;

      pulseMeshes.forEach((mesh) => {
        const scale = 0.78 + (Math.sin(elapsed * 2.4 + mesh.userData.offset) + 1) * 0.22;
        mesh.scale.setScalar(scale);
      });

      nodeMeshes.forEach(({ mesh, halo, label, node, baseScale }) => {
        const isSelected = selectedIdRef.current === node.id;
        const selectedScale = isSelected ? 1.55 : 1;
        if (node.kind === "fleet" && node.orbit) {
          const position = orbitPosition(node.orbit, elapsed);
          mesh.position.copy(position);
          halo.position.copy(position);
          if (label) label.position.copy(position).add(new THREE.Vector3(0, 0.24, 0));
          mesh.scale.setScalar(baseScale * selectedScale);
        } else if (node.latitude != null && node.longitude != null) {
          const position = latLonVector(node.latitude, node.longitude, 2.39);
          mesh.position.copy(position);
          halo.position.copy(position);
          mesh.scale.setScalar(baseScale * selectedScale);
        }
      });

      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      rebuildNodesRef.current = null;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerup", click);
      controls.dispose();
      earthMap.dispose();
      earthNormal.dispose();
      earthSpecular.dispose();
      cloudMap.dispose();
      scene.traverse((object: any) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) object.material.forEach((material: any) => { material.map?.dispose?.(); material.dispose?.(); });
        else if (object.material) { object.material.map?.dispose?.(); object.material.dispose?.(); }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [accent]);

  // Node-only rebuild when the node set changes (fleet refresh, mode switch,
  // presence updates). Cheap: touches just the marker/orbit meshes, leaving
  // the renderer, Earth textures, starfield, and camera view intact.
  useEffect(() => {
    rebuildNodesRef.current?.();
  }, [nodes]);

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
  const [fleetError, setFleetError] = useState("");

  useEffect(() => { saveWorldMapMode(mode); setSelected(null); }, [mode]);

  useEffect(() => {
    setLoading(true);
    return subscribeWorldPresence({
      onSnapshot: (snapshot) => {
        setPublicNodes(snapshot.nodes);
        setError("");
        setLoading(false);
      },
      onStatus: (status) => {
        setConfigured(status.configured);
        if (!status.configured) {
          setPublicNodes([]);
          setLoading(false);
        } else if (!status.connected) {
          setPublicNodes([]);
          if (status.error) {
            setError(status.error);
            setLoading(false);
          }
        } else {
          setError("");
        }
      },
    });
  }, []);

  const loadFleet = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setFleetError("");
    try {
      const [identity, devices] = await Promise.all([getIdentity(), listDevices()]);
      setSelfId(identity.device_id);
      setFleet(fleetWithSelf(identity, devices));
    } catch (reason) {
      setFleetError(String(reason));
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [identity, devices] = await Promise.all([getIdentity(), listDevices()]);
        if (!alive) return;
        setSelfId(identity.device_id);
        setFleet(fleetWithSelf(identity, devices));
        setFleetError("");
      } catch (reason) {
        if (alive) setFleetError(String(reason));
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (mode === "fleet") void loadFleet(false);
  }, [mode]);

  const togglePresence = (enabled: boolean) => {
    setPresenceEnabled(enabled);
    savePresenceEnabled(enabled);
  };

  const nodes = useMemo<GlobeNode[]>(() => mode === "world"
    ? publicNodes.map((node) => ({
        id: node.id,
        label: node.region || t("Anonymous OWLLM node"),
        detail: t("Approximate server region"),
        latitude: node.latitude,
        longitude: node.longitude,
        online: true,
        kind: "world" as const,
      }))
    : fleet.map((device) => {
        const online = device.is_self || recent(device.last_seen);
        return {
          id: device.device_id,
          label: device.is_self || device.device_id === selfId ? t("This device") : device.name,
          detail: `${device.os} · ${online ? t("Online") : t("Offline")}`,
          online,
          kind: "fleet" as const,
          orbit: fleetOrbit(device.device_id),
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

        <div className="world-map-layout" style={{ display: "grid", gap: 14, flex: 1, minHeight: 450 }}>
          <section className="world-map-globe-panel" style={{ ...panelStyle(), position: "relative", minHeight: 450, overflow: "hidden", background: "radial-gradient(circle at 50% 44%, #142b50 0%, #081326 38%, #020713 72%, #01030a 100%)" }}>
            <Globe nodes={nodes} accent={colors.accentInk} selectedId={selected?.id ?? null} onSelect={setSelected} />
            <div style={{ position: "absolute", top: 13, left: 13, display: "flex", gap: 8, pointerEvents: "none", flexWrap: "wrap" }}>
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
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 11, color: "var(--accent-ink)", fontWeight: 800, letterSpacing: 1.3, textTransform: "uppercase" }}>{mode === "world" ? t("Live World") : t("My Fleet")}</div>
                {mode === "fleet" && (
                  <button
                    onClick={() => void loadFleet(true)}
                    style={{ padding: "3px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--fg-muted)", fontSize: 11, cursor: "pointer" }}
                  >{t("Refresh")}</button>
                )}
              </div>
              <div style={{ marginTop: 7, fontSize: 25, fontWeight: 800, color: "var(--fg-strong)" }}>{nodes.length}</div>
              <div style={{ color: "var(--fg-muted)", fontSize: 12.5 }}>{mode === "world" ? t("anonymous active installations") : t("paired OwLLM devices")}</div>
            </div>

            {mode === "world" && (
              <label style={{ ...panelStyle(), padding: 15, display: "flex", gap: 11, cursor: "pointer", alignItems: "flex-start" }}>
                <input type="checkbox" checked={presenceEnabled} onChange={(event) => togglePresence(event.target.checked)} style={{ marginTop: 3, width: 17, height: 17, accentColor: "var(--accent)" }} />
                <span>
                  <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 13.5, fontWeight: 750 }}>{t("Appear anonymously")}</span>
                  <span style={{ display: "block", marginTop: 4, color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.45 }}>{t("Shares no name, account, device, project, prompt, or exact coordinates.")}</span>
                </span>
              </label>
            )}

            {mode === "fleet" && fleetError && (
              <div style={{ ...panelStyle(), padding: 12, borderColor: "var(--error)", color: "var(--error)", fontSize: 11.5, lineHeight: 1.5 }}>
                {fleetError}
              </div>
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
