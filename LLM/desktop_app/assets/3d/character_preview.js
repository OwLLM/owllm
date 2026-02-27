const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e222b);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.5, 4.5);

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

scene.add(new THREE.HemisphereLight(0xcce4ff, 0x1a1a1a, 1.0));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(5, 10, 7);
dirLight.castShadow = true;
scene.add(dirLight);

const floor = new THREE.Mesh(
    new THREE.CircleGeometry(3, 32),
    new THREE.MeshStandardMaterial({ color: 0x2a313d, roughness: 0.8, metalness: 0.1 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const MODEL_CATALOG = {
    soldier: { path: "models/soldier.glb", scale: 1.2 },
    robot: { path: "models/robot.glb", scale: 0.4 },
    xbot: { path: "models/xbot.glb", scale: 0.013 },
    parrot: { path: "models/parrot.glb", scale: 0.02 },
    fox: { path: "models/fox.glb", scale: 0.015 },
    cesium_man: { path: "models/cesium_man.glb", scale: 1.2 },
    brainstem: { path: "models/brainstem.glb", scale: 1.2 },
    robot_expressive: { path: "models/robot_expressive.glb", scale: 0.3 },
    flamingo: { path: "models/flamingo.glb", scale: 0.015 },
    horse: { path: "models/horse.glb", scale: 0.008 },
    stork: { path: "models/stork.glb", scale: 0.015 },
    duck: { path: "models/duck.glb", scale: 0.8 },
    rigged_figure: { path: "models/rigged_figure.glb", scale: 1.5 },
};

const loader = new THREE.GLTFLoader();
let currentModel = null;
let mixer = null;
const clock = new THREE.Clock();

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
        // Make it slightly larger for the preview
        currentModel.scale.setScalar(cfg.scale * 1.3);
        
        currentModel.traverse(n => {
            if (n.isMesh) { 
                n.castShadow = true; 
                n.receiveShadow = true; 
            }
        });
        
        // Offset Y if needed (e.g. for birds)
        if (["parrot", "flamingo", "stork"].includes(key)) {
            currentModel.position.y = 1.0;
        } else {
            currentModel.position.y = 0;
        }

        scene.add(currentModel);

        if (gltf.animations && gltf.animations.length > 0) {
            mixer = new THREE.AnimationMixer(currentModel);
            const clip = gltf.animations.find(c => c.name.toLowerCase().includes('idle')) || gltf.animations[0];
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
    controls.update();
    renderer.render(scene, camera);
}
animate();