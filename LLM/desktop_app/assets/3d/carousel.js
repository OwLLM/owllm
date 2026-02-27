const scene = new THREE.Scene();

// We want a transparent/dark background to fit in the widget
scene.background = new THREE.Color(0x1e222b); // Matches dark theme container

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 2.0, 6.5);
camera.lookAt(0, 0.8, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
document.getElementById("canvas-container").appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xcce4ff, 0x1a1a1a, 0.8));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(5, 8, 5);
keyLight.castShadow = true;
scene.add(keyLight);

const floor = new THREE.Mesh(
    new THREE.CircleGeometry(8, 64),
    new THREE.MeshStandardMaterial({ color: 0x2a313d, roughness: 0.8, metalness: 0.1 })
);
floor.rotation.x = -Math.PI * 0.5;
floor.position.y = -0.1;
floor.receiveShadow = true;
scene.add(floor);

// Catalog data
const BASE_MODELS = {
    robot: { path: "models/robot.glb", scale: 0.4 },
    soldier: { path: "models/soldier.glb", scale: 1.2 },
    xbot: { path: "models/xbot.glb", scale: 0.013 },
    parrot: { path: "models/parrot.glb", scale: 0.02, dy: 1.5 },
    fox: { path: "models/fox.glb", scale: 0.015 },
    cesium_man: { path: "models/cesium_man.glb", scale: 1.2 },
    brainstem: { path: "models/brainstem.glb", scale: 1.2 },
    robot_expressive: { path: "models/robot_expressive.glb", scale: 0.3 },
    flamingo: { path: "models/flamingo.glb", scale: 0.015, dy: 1.5 },
    horse: { path: "models/horse.glb", scale: 0.008 },
    stork: { path: "models/stork.glb", scale: 0.015, dy: 1.5 },
};

const charKeys = [
    // Stylized
    "soldier", "paladin", "mage", "parrot", "fox", "cesium_man", "brainstem", "flamingo", "horse", "stork",
    // Sci-Fi
    "robot", "cyborg", "mech", "xbot", "rogue", "neon", "titan", "scout", "drone", "robot_expressive"
];

const MODEL_CATALOG = {
    soldier: { base: "soldier", tint: null },
    paladin: { base: "soldier", tint: 0xeab308, scale: 1.35 },
    mage: { base: "soldier", tint: 0xa855f7, scale: 1.15 },
    robot: { base: "robot", tint: null },
    cyborg: { base: "robot", tint: 0xa855f7, scale: 0.42 },
    mech: { base: "robot", tint: 0x475569, scale: 0.55 },
    xbot: { base: "xbot", tint: null },
    rogue: { base: "xbot", tint: 0x10b981, scale: 0.012 },
    neon: { base: "robot", tint: 0x10b981, scale: 0.4 },
    titan: { base: "robot", tint: 0xeab308, scale: 0.6 },
    scout: { base: "xbot", tint: 0x3b82f6, scale: 0.011 },
    drone: { base: "robot", tint: 0x8b5cf6, scale: 0.35 },
    parrot: { base: "parrot", tint: null },
    fox: { base: "fox", tint: null },
    cesium_man: { base: "cesium_man", tint: null },
    brainstem: { base: "brainstem", tint: null },
    robot_expressive: { base: "robot_expressive", tint: null },
    flamingo: { base: "flamingo", tint: null },
    horse: { base: "horse", tint: null },
    stork: { base: "stork", tint: null },
};

const loader = new THREE.GLTFLoader();
const carouselGroup = new THREE.Group();
scene.add(carouselGroup);

const radius = 6.0;
const total = charKeys.length;
const angleStep = (Math.PI * 2) / total;

const mixers = [];
let currentIndex = 0;
let targetRotation = 0;

// Read query param if any (e.g. ?initial=robot)
const urlParams = new URLSearchParams(window.location.search);
const initialKey = urlParams.get('initial');
if (initialKey && charKeys.includes(initialKey)) {
    currentIndex = charKeys.indexOf(initialKey);
    targetRotation = currentIndex * angleStep;
    carouselGroup.rotation.y = targetRotation;
}

function updateLabel() {
    document.getElementById("name-label").innerText = charKeys[currentIndex].replace("_", " ");
}
updateLabel();

// Load all models and place them
charKeys.forEach((key, i) => {
    const charCfg = MODEL_CATALOG[key];
    const baseCfg = BASE_MODELS[charCfg.base];
    
    const angle = i * angleStep;
    const x = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;

    // Anchor group
    const wrapper = new THREE.Group();
    wrapper.position.set(x, baseCfg.dy || 0, z);
    // Make them face outward from the center
    wrapper.rotation.y = angle; 
    carouselGroup.add(wrapper);

    loader.load(baseCfg.path, (gltf) => {
        const root = gltf.scene;
        const finalScale = charCfg.scale || baseCfg.scale;
        root.scale.setScalar(finalScale);

        root.traverse((node) => {
            if (node.isMesh) {
                node.castShadow = true;
                node.receiveShadow = true;
                if (charCfg.tint) {
                    if (node.material) {
                        node.material = node.material.clone();
                        node.material.color.setHex(charCfg.tint);
                    }
                }
            }
        });
        wrapper.add(root);

        // Setup idle animation
        if (gltf.animations && gltf.animations.length > 0) {
            const mixer = new THREE.AnimationMixer(root);
            mixers.push(mixer);
            const clip = gltf.animations.find(c => c.name.toLowerCase().includes('idle')) || gltf.animations[0];
            if (clip) {
                const action = mixer.clipAction(clip);
                action.play();
            }
        }
    });
});

document.getElementById("btn-prev").addEventListener("pointerdown", () => {
    currentIndex = (currentIndex - 1 + total) % total;
    targetRotation = currentIndex * angleStep;
    updateLabel();
    notifySelection();
});

document.getElementById("btn-next").addEventListener("pointerdown", () => {
    currentIndex = (currentIndex + 1) % total;
    targetRotation = currentIndex * angleStep;
    updateLabel();
    notifySelection();
});

// Also allow dragging
let isDragging = false;
let previousX = 0;
window.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("nav-btn")) return;
    isDragging = true;
    previousX = e.clientX;
});
window.addEventListener("pointermove", (e) => {
    if (isDragging) {
        const delta = e.clientX - previousX;
        targetRotation -= delta * 0.01;
        carouselGroup.rotation.y -= delta * 0.01;
        previousX = e.clientX;
    }
});
window.addEventListener("pointerup", () => {
    if (isDragging) {
        isDragging = false;
        // Snap to nearest
        let snapIndex = Math.round(targetRotation / angleStep);
        targetRotation = snapIndex * angleStep;
        
        // Update index based on normalized snapIndex
        let nIndex = snapIndex % total;
        if (nIndex < 0) nIndex += total;
        currentIndex = nIndex;
        updateLabel();
        notifySelection();
    }
});

let debounceTimer = null;
function notifySelection() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        // We set the document title to communicate with PySide6
        document.title = "SELECTED:" + charKeys[currentIndex];
    }, 400); // 400ms delay to avoid spamming while spinning
}

window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    
    // Smooth rotation towards target
    if (!isDragging) {
        carouselGroup.rotation.y = THREE.MathUtils.lerp(carouselGroup.rotation.y, targetRotation, dt * 5.0);
    }

    mixers.forEach(m => m.update(dt));
    renderer.render(scene, camera);
}
animate();
