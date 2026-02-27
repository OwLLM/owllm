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
    fantasy_knight: { path: "models/fantasy_knight.glb", scale: 1.2, yOffset: 0, camY: 1.0, camDist: 3.8, aura: 0xe2c488 },
    fantasy_mage: { path: "models/fantasy_mage.glb", scale: 1.0, yOffset: 0, camY: 0.95, camDist: 3.6, aura: 0xa58ee2 },
    fantasy_rogue: { path: "models/fantasy_rogue.glb", scale: 0.013, yOffset: 0, camY: 1.0, camDist: 3.8, aura: 0x8fc9cf },
    fantasy_guardian: { path: "models/rigged_figure.glb", scale: 1.5, yOffset: 0, camY: 1.15, camDist: 4.4, aura: 0xcac7b8 },
    anime_blade: { path: "models/kira.glb", scale: 1.0, yOffset: 0, camY: 0.95, camDist: 3.5, aura: 0xffd7ba },
    anime_guardian: { path: "models/michelle.glb", scale: 1.0, yOffset: 0, camY: 0.95, camDist: 3.5, aura: 0xffdcc2 },
    anime_urban: { path: "models/readyplayer.me.glb", scale: 1.0, yOffset: 0, camY: 0.95, camDist: 3.5, aura: 0xffddc4 },
    anime_tokyo: { path: "models/littlest_tokyo.glb", scale: 0.012, yOffset: 0, camY: 1.5, camDist: 5.0, aura: 0xd6c8ff },
    anime_android: { path: "models/robot_expressive.glb", scale: 0.3, yOffset: 0, camY: 0.8, camDist: 3.0, aura: 0xa8b9ff },
    anime_scout: { path: "models/rigged_simple.glb", scale: 1.0, yOffset: 0, camY: 0.85, camDist: 3.3, aura: 0xf2d7bb },
    classic_soldier: { path: "models/soldier.glb", scale: 1.2, yOffset: 0, camY: 1.0, camDist: 3.8, aura: 0xdcc99a },
    classic_xbot: { path: "models/xbot.glb", scale: 0.013, yOffset: 0, camY: 1.0, camDist: 3.8, aura: 0xb9d4df },
    classic_cesium: { path: "models/cesium_man.glb", scale: 1.2, yOffset: 0, camY: 1.0, camDist: 3.8, aura: 0xd8c6a6 },
    classic_robot: { path: "models/robot.glb", scale: 0.4, yOffset: 0, camY: 0.85, camDist: 3.1, aura: 0xb1bfdf },
    wild_fox: { path: "models/fox.glb", scale: 0.025, yOffset: 0, camY: 0.65, camDist: 2.9, aura: 0xffc48d },
    wild_horse: { path: "models/horse.glb", scale: 0.018, yOffset: 0, camY: 1.0, camDist: 3.8, aura: 0xb9936a },
    wild_flamingo: { path: "models/flamingo.glb", scale: 0.02, yOffset: 0, camY: 1.25, camDist: 4.2, aura: 0xffaec6 },
    wild_parrot: { path: "models/parrot.glb", scale: 0.02, yOffset: 0, camY: 0.85, camDist: 3.0, aura: 0x9fd8ff },
    wild_stork: { path: "models/stork.glb", scale: 0.02, yOffset: 0, camY: 1.15, camDist: 3.8, aura: 0xffd7bf },
    mystic_brainstem: { path: "models/brainstem.glb", scale: 0.18, yOffset: 0, camY: 0.95, camDist: 3.2, aura: 0xa58dff },
};

const loader = new THREE.GLTFLoader();
const dracoLoader = new THREE.DRACOLoader();
dracoLoader.setDecoderPath('js/draco/');
loader.setDRACOLoader(dracoLoader);
let currentModel = null;
let mixer = null;
const clock = new THREE.Clock();
const auraRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.65, 0.05, 16, 96),
    new THREE.MeshStandardMaterial({ color: 0xeed8ad, emissive: 0xc69844, emissiveIntensity: 0.35, roughness: 0.55, metalness: 0.15 })
);
auraRing.rotation.x = Math.PI * 0.5;
auraRing.position.y = 0.03;
scene.add(auraRing);

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

window.setPreviewModel = (key) => {
    if (currentModel) {
        scene.remove(currentModel);
        currentModel = null;
        mixer = null;
    }
    const cfg = MODEL_CATALOG[key];
    if (!cfg) return;

    loader.load(cfg.path, (gltf) => {
        currentModel = gltf.scene;
        // Make it larger for the preview
        currentModel.scale.setScalar(cfg.scale * 1.5);
        
        currentModel.traverse(n => {
            if (n.isMesh) { 
                n.castShadow = true; 
                n.receiveShadow = true; 
            }
        });
        applyStyle(currentModel, cfg);
        
        scene.add(currentModel);
        frameModelToBodyCenter(currentModel, cfg);
        if (cfg.aura) {
            auraRing.material.color.setHex(cfg.aura);
            auraRing.material.emissive.setHex(cfg.aura);
        }

        const clip = gltf.animations.find(c => c.name.toLowerCase().includes('idle') || c.name.toLowerCase().includes('stand') || c.name.toLowerCase().includes('breath')) || gltf.animations[0];
        if (clip) {
            mixer = new THREE.AnimationMixer(currentModel);
            mixer.clipAction(clip).play();
        }
    });
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
    auraRing.rotation.z += dt * 0.55;
    auraRing.material.emissiveIntensity = 0.6 + Math.sin(performance.now() * 0.003) * 0.2;
    controls.update();
    renderer.render(scene, camera);
}
animate();