// Bridge-safe placeholders: preview page may receive shared JS calls before main scene is ready.
window.updateLabels = window.updateLabels || (() => {});
window.assignVisual = window.assignVisual || (() => {});
window.characterSay = window.characterSay || (() => {});
window.characterAction = window.characterAction || (() => {});
window.sceneInteract = window.sceneInteract || (() => {});
window.getSceneReady = window.getSceneReady || (() => false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xaed1ff);
scene.fog = new THREE.Fog(0xaed1ff, 10, 36);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.15, 4.5);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.outputEncoding = THREE.sRGBEncoding;
document.getElementById("canvas-container").appendChild(renderer.domElement);
const statusLabel = document.createElement("div");
statusLabel.style.cssText = "position:absolute;top:10px;left:50%;transform:translateX(-50%);background:rgba(20,25,35,0.72);color:#f7f1dc;padding:4px 10px;border-radius:10px;font:12px sans-serif;pointer-events:none;opacity:0;transition:opacity 0.2s;";
statusLabel.textContent = "Loading...";
document.body.appendChild(statusLabel);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.autoRotate = true;
controls.autoRotateSpeed = 2.0;

scene.add(new THREE.HemisphereLight(0xcde5ff, 0x5d7f40, 0.9));
const dirLight = new THREE.DirectionalLight(0xfff2da, 1.2);
dirLight.position.set(5, 10, 7);
dirLight.castShadow = true;
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0xf4e6c8, 0.32);
fillLight.position.set(-6, 4, 2);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffd5a0, 0.4);
rimLight.position.set(0, 5, -6);
scene.add(rimLight);

const grassCanvas = document.createElement("canvas");
grassCanvas.width = 256;
grassCanvas.height = 256;
const grassCtx = grassCanvas.getContext("2d");
grassCtx.fillStyle = "#6da750";
grassCtx.fillRect(0, 0, 256, 256);
for (let i = 0; i < 2600; i += 1) {
    const x = Math.floor(Math.random() * 256);
    const y = Math.floor(Math.random() * 256);
    const g = 90 + Math.floor(Math.random() * 85);
    grassCtx.fillStyle = `rgb(${28 + Math.floor(Math.random() * 38)},${g},${26 + Math.floor(Math.random() * 24)})`;
    grassCtx.fillRect(x, y, 1, 1);
}
const grassTexture = new THREE.CanvasTexture(grassCanvas);
grassTexture.wrapS = THREE.RepeatWrapping;
grassTexture.wrapT = THREE.RepeatWrapping;
grassTexture.repeat.set(8, 8);

const floor = new THREE.Mesh(
    new THREE.CircleGeometry(18, 96),
    new THREE.MeshStandardMaterial({ map: grassTexture, roughness: 0.95, metalness: 0.0 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(1.75, 1.95, 0.45, 64),
    new THREE.MeshStandardMaterial({ color: 0xb5b0a2, roughness: 0.8, metalness: 0.08 })
);
pedestal.position.y = -0.22;
pedestal.receiveShadow = true;
scene.add(pedestal);

const backdrop = new THREE.Mesh(
    new THREE.CylinderGeometry(7.5, 7.5, 8.8, 64, 1, true, Math.PI * 0.1, Math.PI * 0.8),
    new THREE.MeshStandardMaterial({ color: 0xd8e2cc, roughness: 0.96, metalness: 0.01, side: THREE.DoubleSide })
);
backdrop.position.set(0, 3.1, -2.8);
backdrop.rotation.y = Math.PI;
scene.add(backdrop);

const MODEL_CATALOG = {
    // FANTASY HUMANOIDS (Baseline height ~1.8 units)
    fantasy_knight: { path: "models/fantasy_knight.glb", scale: 1.0, yOffset: 0, autoGround: true, speedMul: 1.0, camY: 1.0, camDist: 3.8, aura: 0xe2c488 },
    fantasy_mage: { path: "models/fantasy_mage.glb", scale: 460.0, yOffset: 0, autoGround: true, speedMul: 1.0, camY: 0.95, camDist: 3.6, aura: 0xa58ee2 },
    fantasy_rogue: { path: "models/fantasy_rogue.glb", scale: 100.0, yOffset: 0, autoGround: true, speedMul: 1.15, camY: 1.0, camDist: 3.8, aura: 0x8fc9cf },
    fantasy_guardian: { path: "models/rigged_figure.glb", scale: 1.25, yOffset: 0, autoGround: true, speedMul: 0.95, camY: 1.15, camDist: 4.4, aura: 0xcac7b8 },
    
    // ANIME HUMANOIDS
    anime_blade: { path: "models/kira.glb", scale: 0.42, yOffset: 0, autoGround: true, speedMul: 1.0, camY: 0.95, camDist: 3.5, aura: 0xffd7ba },
    anime_guardian: { path: "models/michelle.glb", scale: 460.0, yOffset: 0, autoGround: true, speedMul: 1.0, camY: 0.95, camDist: 3.5, aura: 0xffdcc2 },
    anime_urban: { path: "models/readyplayer.me.glb", scale: 0.96, yOffset: 0, autoGround: true, speedMul: 1.0, camY: 0.95, camDist: 3.5, aura: 0xffddc4 },
    anime_tokyo: { path: "models/littlest_tokyo.glb", scale: 0.004, yOffset: 0, autoGround: true, speedMul: 1.05, camY: 1.5, camDist: 5.0, aura: 0xd6c8ff },
    anime_android: { path: "models/robot_expressive.glb", scale: 0.38, yOffset: 0, autoGround: true, speedMul: 1.05, camY: 0.8, camDist: 3.0, aura: 0xa8b9ff },
    anime_scout: { path: "models/rigged_simple.glb", scale: 0.2, yOffset: 0, autoGround: true, speedMul: 1.0, camY: 0.85, camDist: 3.3, aura: 0xf2d7bb },
    
    // CLASSIC
    classic_soldier: { path: "models/soldier.glb", scale: 1.0, yOffset: 0, autoGround: true, speedMul: 1.0, camY: 1.0, camDist: 3.8, aura: 0xdcc99a },
    classic_xbot: { path: "models/xbot.glb", scale: 100.0, yOffset: 0, autoGround: true, speedMul: 1.15, camY: 1.0, camDist: 3.8, aura: 0xb9d4df },
    classic_cesium: { path: "models/cesium_man.glb", scale: 1.2, yOffset: 0, autoGround: true, speedMul: 1.0, camY: 1.0, camDist: 3.8, aura: 0xd8c6a6 },
    classic_robot: { path: "models/robot.glb", scale: 0.38, yOffset: 0, autoGround: true, speedMul: 1.0, camY: 0.85, camDist: 3.1, aura: 0xb1bfdf },
    
    // CREATURES / MONSTERS (Tuned to roughly match humanoid height)
    wild_fox: { path: "models/fox.glb", scale: 0.015, yOffset: 0, autoGround: true, speedMul: 1.2, camY: 0.74, camDist: 3.0, aura: 0xffc48d },
    wild_horse: { path: "models/horse.glb", scale: 0.006, yOffset: 0, autoGround: true, speedMul: 1.15, camY: 1.0, camDist: 3.8, aura: 0xb9936a },
    wild_flamingo: { path: "models/flamingo.glb", scale: 0.004, yOffset: 0, autoGround: true, speedMul: 1.2, camY: 1.3, camDist: 4.3, aura: 0xffaec6 },
    wild_parrot: { path: "models/parrot.glb", scale: 0.006, yOffset: 0, autoGround: true, speedMul: 1.25, camY: 0.95, camDist: 3.1, aura: 0x9fd8ff },
    wild_stork: { path: "models/stork.glb", scale: 0.008, yOffset: 0, autoGround: true, speedMul: 1.2, camY: 1.2, camDist: 3.9, aura: 0xffd7bf },
    mystic_brainstem: { path: "models/brainstem.glb", scale: 0.87, yOffset: 0, autoGround: true, speedMul: 1.0, camY: 0.98, camDist: 3.2, aura: 0xa58dff },
    
    // D-REX
    d_rex: { path: "models/T-Rex_Spider.glb", scale: 120.0, yOffset: 0, autoGround: true, speedMul: 0.95, turnLerp: 0.28, headingLerp: 0.16, camY: 1.3, camDist: 4.5, aura: 0xff8f70 },
    
    // CUSTOM
    julio_cesar: { path: "models/Julio_Cesar.glb", scale: 1.0, yOffset: 0, autoGround: true, speedMul: 1.0, camY: 1.0, camDist: 3.8, aura: 0xe2c488 },
};

const loader = new THREE.GLTFLoader();
const dracoLoader = new THREE.DRACOLoader();
dracoLoader.setDecoderPath('js/draco/');
loader.setDRACOLoader(dracoLoader);
let currentModel = null;
let mixer = null;
const clock = new THREE.Clock();

function frameModelToBodyCenter(root, cfg) {
    // Reset rotations and force manual offsets for absolute reliability
    root.rotation.set(0, 0, 0);
    root.position.set(0, cfg.yOffset || 0, 0);

    const targetY = (cfg.camY || 1.0) + 0.22;
    const distance = (cfg.camDist || 3.5) * 1.15;

    controls.target.set(0, targetY, 0);
    camera.position.set(0, targetY + 0.2, distance);
    camera.lookAt(controls.target);
    controls.minDistance = distance * 0.5;
    controls.maxDistance = distance * 2.5;
}

function applyStyle(root, cfg) {
    // Keep original artist textures/materials for visual fidelity.
    return;
}

function normalizeModelHeight(root, targetHeight) {
    if (!targetHeight || targetHeight <= 0) return;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    if (!isFinite(size.y) || size.y <= 0.001) return;
    const factor = targetHeight / size.y;
    root.scale.multiplyScalar(factor);
}

function clampModelScale(root, minScale, maxScale) {
    if (!minScale && !maxScale) return;
    const s = root.scale.x;
    let clamped = s;
    if (minScale) clamped = Math.max(clamped, minScale);
    if (maxScale) clamped = Math.min(clamped, maxScale);
    if (Math.abs(clamped - s) > 1e-6) {
        const ratio = clamped / s;
        root.scale.multiplyScalar(ratio);
    }
}

function applyGroundOffset(root, yOffset, autoGround) {
    if (!autoGround) {
        root.position.y = yOffset || 0;
        return;
    }
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (!isFinite(box.min.y)) {
        root.position.y = yOffset || 0;
        return;
    }
    root.position.y = (yOffset || 0) - box.min.y;
}

function norm(s) {
    return String(s || "").trim().toLowerCase();
}

function pickClip(clips, candidates) {
    const names = candidates.map(norm);
    for (const name of names) {
        const found = clips.find((clip) => norm(clip.name).includes(name));
        if (found) return found;
    }
    return null;
}

function createFallbackPreviewMesh() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.42, 1.3, 8, 16),
        new THREE.MeshStandardMaterial({ color: 0x7ca8ff, roughness: 0.46, metalness: 0.14 })
    );
    body.castShadow = true;
    body.receiveShadow = true;
    body.position.y = 0.88;
    group.add(body);
    return group;
}

function prewarmModelCache() {
    ["anime_android", "fantasy_knight", "anime_blade", "wild_fox"].forEach((key) => {
        const cfg = MODEL_CATALOG[key];
        if (!cfg || !cfg.path) return;
        loader.load(cfg.path, () => {}, undefined, () => {});
    });
}

let currentModelKey = null;
let currentBaseScale = 1.0;
let dynamicScaleMultiplier = 1.0;

window.setPreviewScale = (mult) => {
    dynamicScaleMultiplier = mult;
    if (currentModel && currentModelKey) {
        const cfg = MODEL_CATALOG[currentModelKey];
        if (cfg) {
            currentModel.scale.setScalar(cfg.scale * 1.5 * dynamicScaleMultiplier);
            applyGroundOffset(currentModel, cfg.yOffset, cfg.autoGround);
        }
    }
};

let loadToken = 0;
window.setPreviewModel = (key) => {
    currentModelKey = key;
    dynamicScaleMultiplier = 1.0;
    const cfg = MODEL_CATALOG[key];
    if (!cfg) return;
    const token = ++loadToken;
    statusLabel.style.opacity = "1";

    loader.load(
        cfg.path,
        (gltf) => {
            if (token !== loadToken) return;
            if (currentModel) {
                scene.remove(currentModel);
                currentModel = null;
                mixer = null;
            }
            currentModel = gltf.scene;
            // Make it larger for the preview
            currentModel.scale.setScalar(cfg.scale * 1.5 * dynamicScaleMultiplier);
            normalizeModelHeight(currentModel, cfg.targetHeight);
            clampModelScale(currentModel, cfg.minScale, cfg.maxScale);
            applyGroundOffset(currentModel, cfg.yOffset, cfg.autoGround);
            
            currentModel.traverse(n => {
                if (n.isMesh) { 
                    n.castShadow = true; 
                    n.receiveShadow = true; 
                }
            });
            applyStyle(currentModel, cfg);
            
            scene.add(currentModel);
            frameModelToBodyCenter(currentModel, cfg);

            const clip = pickClip(gltf.animations, ["idle", "standing", "breath", "pose", "agree"]) || gltf.animations[0];
            if (clip) {
                mixer = new THREE.AnimationMixer(currentModel);
                mixer.clipAction(clip).play();
            }
            statusLabel.style.opacity = "0";
        },
        undefined,
        () => {
            if (token !== loadToken) return;
            if (currentModel) {
                scene.remove(currentModel);
                currentModel = null;
                mixer = null;
            }
            currentModel = createFallbackPreviewMesh();
            scene.add(currentModel);
            frameModelToBodyCenter(currentModel, { yOffset: 0, camY: 0.95, camDist: 3.1 });
            statusLabel.textContent = "Model failed - using fallback";
            statusLabel.style.opacity = "1";
            setTimeout(() => {
                if (token === loadToken) {
                    statusLabel.textContent = "Loading...";
                    statusLabel.style.opacity = "0";
                }
            }, 1200);
        }
    );
};

window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    if (mixer) mixer.update(dt);
    controls.update();
    renderer.render(scene, camera);
}
animate();
setTimeout(prewarmModelCache, 150);