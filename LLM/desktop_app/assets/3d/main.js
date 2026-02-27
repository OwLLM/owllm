const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9bc7ff);
scene.fog = new THREE.Fog(0x9bc7ff, 28, 90);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 6.5, 16);
camera.lookAt(0, 1.2, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
document.getElementById("canvas-container").appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xbfdcff, 0x4f7f3a, 0.95));
const keyLight = new THREE.DirectionalLight(0xfff4dd, 1.2);
keyLight.position.set(8, 12, 6);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xe3ffd0, 0.38);
fillLight.position.set(-10, 7, -4);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffefc8, 0.28);
rimLight.position.set(0, 5, -10);
scene.add(rimLight);

const floor = new THREE.Mesh(
    new THREE.CircleGeometry(42, 96),
    new THREE.MeshStandardMaterial({ color: 0x69aa4f, roughness: 0.93, metalness: 0.02 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const stoneArena = new THREE.Mesh(
    new THREE.CircleGeometry(8.8, 72),
    new THREE.MeshStandardMaterial({ color: 0xb9b7a8, roughness: 0.78, metalness: 0.08 })
);
stoneArena.rotation.x = Math.PI * 0.5;
stoneArena.position.y = 0.015;
stoneArena.receiveShadow = true;
scene.add(stoneArena);

for (let i = 0; i < 28; i += 1) {
    const angle = (i / 28) * Math.PI * 2;
    const fence = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.45, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x8d5f33, roughness: 0.92, metalness: 0.02 })
    );
    const radius = 12.2;
    fence.position.set(Math.cos(angle) * radius, 0.24, Math.sin(angle) * radius);
    fence.lookAt(0, 0.24, 0);
    scene.add(fence);

    if (i % 2 === 0) {
        const post = new THREE.Mesh(
            new THREE.CylinderGeometry(0.09, 0.09, 0.8, 10),
            new THREE.MeshStandardMaterial({ color: 0x6f4727, roughness: 0.9, metalness: 0.03 })
        );
        post.position.set(Math.cos(angle) * radius, 0.4, Math.sin(angle) * radius);
        scene.add(post);
    }
}

const labelsRoot = document.getElementById("labels");
const loader = new THREE.GLTFLoader();
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const clock = new THREE.Clock();

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // don't go below ground
controls.minDistance = 2;
controls.maxDistance = 30;

let selectedCharacter = null;
let isDragging = false;
let dragOffset = new THREE.Vector3();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

const keys = { w: false, a: false, s: false, d: false, ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false };

window.addEventListener("keydown", (e) => {
    if (keys.hasOwnProperty(e.key)) keys[e.key] = true;
});
window.addEventListener("keyup", (e) => {
    if (keys.hasOwnProperty(e.key)) keys[e.key] = false;
});

const MODEL_CATALOG = {
    fantasy_knight: { path: "models/fantasy_knight.glb", scale: 1.2, yOffset: 0 },
    fantasy_mage: { path: "models/fantasy_mage.glb", scale: 1.0, yOffset: 0 },
    fantasy_rogue: { path: "models/fantasy_rogue.glb", scale: 0.013, yOffset: 0 },
    fantasy_guardian: { path: "models/rigged_figure.glb", scale: 1.5, yOffset: 0 },
    anime_blade: { path: "models/kira.glb", scale: 1.0, yOffset: 0 },
    anime_guardian: { path: "models/michelle.glb", scale: 1.0, yOffset: 0 },
    anime_urban: { path: "models/readyplayer.me.glb", scale: 1.0, yOffset: 0 },
    anime_tokyo: { path: "models/littlest_tokyo.glb", scale: 0.012, yOffset: 0 },
    anime_android: { path: "models/robot_expressive.glb", scale: 0.3, yOffset: 0 },
    anime_scout: { path: "models/rigged_simple.glb", scale: 1.0, yOffset: 0 },
};

const dracoLoader = new THREE.DRACOLoader();
dracoLoader.setDecoderPath('js/draco/');
loader.setDRACOLoader(dracoLoader);

function applyStyle(root, cfg) {
    if (!cfg || (!cfg.tint && !cfg.emissive && cfg.metalness === undefined && cfg.roughness === undefined)) {
        return;
    }
    root.traverse((node) => {
        if (!node.isMesh || !node.material) return;
        node.material = node.material.clone();
        if (cfg.tint) node.material.color.setHex(cfg.tint);
        if (cfg.emissive && node.material.emissive) {
            node.material.emissive.setHex(cfg.emissive);
            node.material.emissiveIntensity = cfg.emissiveIntensity || 0.15;
        }
        if (cfg.metalness !== undefined && node.material.metalness !== undefined) {
            node.material.metalness = cfg.metalness;
        }
        if (cfg.roughness !== undefined && node.material.roughness !== undefined) {
            node.material.roughness = cfg.roughness;
        }
    });
}

function norm(s) {
    return String(s || "").trim().toLowerCase();
}

function pickClip(clips, candidates) {
    const names = candidates.map(norm);
    return clips.find((clip) => names.some((name) => norm(clip.name).includes(name))) || null;
}

class CharacterActor {
    constructor(id, title, spawnPos, visualKey) {
        this.id = id;
        this.title = title;
        this.anchorPos = spawnPos.clone();
        this.group = new THREE.Group();
        this.group.position.copy(spawnPos);
        this.group.userData.id = id;
        scene.add(this.group);

        this.visualKey = visualKey;
        this.rootMesh = null;
        this.mixer = null;
        this.actions = {};
        this.currentAction = "";
        this.headingTarget = null;
        this.moveTarget = null;
        this.moveSpeed = 2.6;
        this.onMoveDone = null;

        this.label = document.createElement("div");
        this.label.className = "name-label";
        this.label.textContent = title;
        labelsRoot.appendChild(this.label);

        this.bubble = document.createElement("div");
        this.bubble.className = "bubble";
        labelsRoot.appendChild(this.bubble);
        this.bubbleTimer = null;

        this._loadVisual(visualKey);
    }

    _loadVisual(visualKey) {
        const modelCfg = MODEL_CATALOG[visualKey] || MODEL_CATALOG.fantasy_knight;
        loader.load(
            modelCfg.path,
            (gltf) => {
                if (this.rootMesh) {
                    this.group.remove(this.rootMesh);
                    this.rootMesh.traverse((node) => {
                        if (node.isMesh && node.geometry) {
                            node.geometry.dispose();
                        }
                    });
                }
                this.rootMesh = gltf.scene;
                this.rootMesh.scale.setScalar(modelCfg.scale);
                this.rootMesh.position.y = modelCfg.yOffset || 0;
                applyStyle(this.rootMesh, modelCfg);
                this.rootMesh.traverse((node) => {
                    if (node.isMesh) {
                        node.castShadow = true;
                        node.receiveShadow = true;
                    }
                    node.userData.id = this.id;
                });
                this.group.add(this.rootMesh);
                this._setupAnimations(gltf.animations || []);
            },
            undefined,
            () => {
                this._createFallbackBody();
            }
        );
    }

    _createFallbackBody() {
        if (this.rootMesh) {
            this.group.remove(this.rootMesh);
        }
        const body = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.45, 1.5, 8, 16),
            new THREE.MeshStandardMaterial({ color: 0x7ca8ff, roughness: 0.35, metalness: 0.25 })
        );
        body.position.y = 1.3;
        body.castShadow = true;
        body.userData.id = this.id;
        this.rootMesh = body;
        this.group.add(body);
        this.actions = {};
        this.currentAction = "";
    }

    _setupAnimations(clips) {
        this.actions = {};
        this.currentAction = "";
        if (!clips.length || !this.rootMesh) {
            return;
        }
        this.mixer = new THREE.AnimationMixer(this.rootMesh);
        const idleClip = pickClip(clips, ["idle", "standing", "breath", "pose"]) || clips[0];
        const walkClip = pickClip(clips, ["walk", "jog", "run", "locomotion"]);
        const waveClip = pickClip(clips, ["wave", "greet", "hello", "taunt", "attack", "punch"]);

        this.actions.idle = idleClip ? this.mixer.clipAction(idleClip) : null;
        this.actions.walk = walkClip ? this.mixer.clipAction(walkClip) : this.actions.idle;
        this.actions.wave = waveClip ? this.mixer.clipAction(waveClip) : this.actions.idle;

        Object.values(this.actions).forEach((act) => {
            if (act) {
                act.enabled = true;
                act.clampWhenFinished = true;
                act.loop = THREE.LoopRepeat;
            }
        });
        this.play("idle");
    }

    play(name) {
        if (!this.mixer || !this.actions[name]) {
            return;
        }
        if (this.currentAction === name) {
            return;
        }
        const next = this.actions[name];
        const prev = this.actions[this.currentAction];
        if (prev) {
            prev.fadeOut(0.2);
        }
        next.reset().fadeIn(0.2).play();
        this.currentAction = name;
    }

    setLabel(text) {
        this.label.textContent = text;
    }

    say(text) {
        this.bubble.textContent = text;
        this.bubble.style.opacity = 1;
        this.bubble.style.transform = "translate(-50%, -100%)";
        if (this.bubbleTimer) {
            clearTimeout(this.bubbleTimer);
        }
        this.bubbleTimer = setTimeout(() => {
            this.bubble.style.opacity = 0;
        }, Math.min(Math.max(text.length * 85, 2200), 9000));
    }

    moveTo(target, doneCallback = null) {
        this.moveTarget = target.clone();
        this.onMoveDone = doneCallback;
    }

    faceTowards(targetPos) {
        this.headingTarget = targetPos.clone();
    }

    walkBackToAnchor() {
        this.moveTo(this.anchorPos);
    }

    update(delta) {
        if (this.mixer) {
            this.mixer.update(delta);
        }

        let isManualMoving = false;
        if (selectedCharacter === this && !isDragging && !this.moveTarget) {
            let dx = 0, dz = 0;
            if (keys.w || keys.ArrowUp) dz -= 1;
            if (keys.s || keys.ArrowDown) dz += 1;
            if (keys.a || keys.ArrowLeft) dx -= 1;
            if (keys.d || keys.ArrowRight) dx += 1;
            
            if (dx !== 0 || dz !== 0) {
                isManualMoving = true;
                this.moveTarget = null; // Cancel any scripted movement
                this.headingTarget = null;
                
                const camForward = new THREE.Vector3();
                camera.getWorldDirection(camForward);
                camForward.y = 0;
                camForward.normalize();
                
                const camRight = new THREE.Vector3().crossVectors(camForward, new THREE.Vector3(0, 1, 0)).normalize();
                
                const finalMove = new THREE.Vector3()
                    .addScaledVector(camRight, dx)
                    .addScaledVector(camForward, -dz)
                    .normalize()
                    .multiplyScalar(this.moveSpeed * delta);

                this.group.position.add(finalMove);
                this.anchorPos.copy(this.group.position);
                
                const lookAngle = Math.atan2(finalMove.x, finalMove.z);
                this.group.rotation.y = THREE.MathUtils.lerp(this.group.rotation.y, lookAngle, 0.2);
                
                this.play("walk");
            } else {
                this.play("idle");
            }
        }

        if (this.moveTarget && !isManualMoving) {
            const deltaVec = new THREE.Vector3().subVectors(this.moveTarget, this.group.position);
            deltaVec.y = 0;
            const dist = deltaVec.length();
            if (dist <= 0.08) {
                this.group.position.copy(this.moveTarget);
                this.moveTarget = null;
                this.play("idle");
                if (this.onMoveDone) {
                    const fn = this.onMoveDone;
                    this.onMoveDone = null;
                    fn();
                }
            } else {
                this.play("walk");
                deltaVec.normalize();
                this.group.position.addScaledVector(deltaVec, this.moveSpeed * delta);
                this.faceTowards(this.moveTarget);
            }
        }

        if (this.headingTarget && !isManualMoving && !this.moveTarget) {
            const look = new THREE.Vector3().subVectors(this.headingTarget, this.group.position);
            const angle = Math.atan2(look.x, look.z);
            this.group.rotation.y = THREE.MathUtils.lerp(this.group.rotation.y, angle, 0.11);
        }

        const worldPos = new THREE.Vector3();
        worldPos.setFromMatrixPosition(this.group.matrixWorld);
        worldPos.y += 2.4;
        worldPos.project(camera);
        const sx = (worldPos.x * 0.5 + 0.5) * window.innerWidth;
        const sy = (worldPos.y * -0.5 + 0.5) * window.innerHeight;
        this.label.style.left = `${sx}px`;
        this.label.style.top = `${sy + 14}px`;
        this.bubble.style.left = `${sx}px`;
        this.bubble.style.top = `${sy - 6}px`;
    }
}

const characters = {
    A: new CharacterActor("A", "Arc", new THREE.Vector3(-2.8, 0, 1.2), "fantasy_knight"),
    B: new CharacterActor("B", "Nova", new THREE.Vector3(0, 0, -1.0), "anime_blade"),
    C: new CharacterActor("C", "Rune", new THREE.Vector3(2.8, 0, 1.2), "fantasy_mage"),
};

let isPointerDown = false;
let clickMoved = false;

window.addEventListener("pointerdown", (event) => {
    isPointerDown = true;
    clickMoved = false;

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    const targets = Object.values(characters).map((c) => c.rootMesh).filter(Boolean);
    const hits = raycaster.intersectObjects(targets, true);

    if (hits.length > 0) {
        let obj = hits[0].object;
        while (obj) {
            if (obj.userData && obj.userData.id && characters[obj.userData.id]) {
                const actor = characters[obj.userData.id];
                selectedCharacter = actor;
                isDragging = true;
                controls.enabled = false;

                // Calculate intersection on floor plane for dragging offset
                raycaster.ray.intersectPlane(dragPlane, dragOffset);
                if (dragOffset) {
                    dragOffset.sub(actor.group.position);
                }
                
                // Set outline/highlight text via label
                Object.values(characters).forEach(c => c.label.style.textShadow = "1px 1px 2px black");
                actor.label.style.textShadow = "0px 0px 8px #4ade80, 0px 0px 4px #4ade80";

                return;
            }
            obj = obj.parent;
        }
    }

    // Deselect if clicked on nothing
    selectedCharacter = null;
    Object.values(characters).forEach(c => c.label.style.textShadow = "1px 1px 2px black");
});

window.addEventListener("pointermove", (event) => {
    if (isPointerDown) {
        clickMoved = true;
    }

    if (isDragging && selectedCharacter) {
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);

        const intersectPoint = new THREE.Vector3();
        raycaster.ray.intersectPlane(dragPlane, intersectPoint);
        if (intersectPoint) {
            const newPos = intersectPoint.sub(dragOffset);
            selectedCharacter.group.position.copy(newPos);
            selectedCharacter.anchorPos.copy(newPos);
        }
    }
});

window.addEventListener("pointerup", (event) => {
    isPointerDown = false;
    isDragging = false;
    controls.enabled = true;

    // Treat as click interaction if we didn't drag
    if (!clickMoved && selectedCharacter) {
        selectedCharacter.play("wave");
        selectedCharacter.say("Ready.");
        setTimeout(() => selectedCharacter.play("idle"), 850);
        console.log(JSON.stringify({ type: "click", id: selectedCharacter.id }));
    }
});

function handleResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    
    // Auto-adjust camera distance based on aspect ratio to keep characters visible
    const targetWidth = 9.0;
    const vFovTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const hFovTan = camera.aspect * vFovTan;
    const requiredZ = (targetWidth / 2) / hFovTan;
    
    // Only pull back if needed, don't zoom in too much
    if (requiredZ > 16) {
        camera.position.z = requiredZ;
    }
}

window.addEventListener("resize", handleResize);
handleResize();

function performInteraction(actorId, targetId, mode) {
    const actor = characters[actorId];
    const target = characters[targetId];
    if (!actor || !target) {
        return;
    }
    const dir = new THREE.Vector3().subVectors(target.group.position, actor.group.position).setY(0).normalize();
    const stopPos = target.group.position.clone().addScaledVector(dir, -1.4);
    actor.moveTo(stopPos, () => {
        actor.faceTowards(target.group.position);
        target.faceTowards(actor.group.position);
        actor.play("wave");
        if (mode === "combat") {
            target.play("wave");
        }
        setTimeout(() => {
            actor.play("idle");
            target.play("idle");
            actor.walkBackToAnchor();
            target.walkBackToAnchor();
        }, 1100);
    });
}

window.characterSay = (id, text) => {
    if (characters[id]) {
        characters[id].say(String(text || ""));
    }
};

window.characterAction = (id, action) => {
    const actor = characters[id];
    if (!actor) {
        return;
    }
    if (action === "wave") {
        actor.play("wave");
        setTimeout(() => actor.play("idle"), 900);
        return;
    }
    actor.play("idle");
};

window.sceneInteract = (fromId, toId, mode) => {
    performInteraction(String(fromId || ""), String(toId || ""), String(mode || "talk"));
};

window.updateLabels = (id, name) => {
    if (characters[id]) {
        characters[id].setLabel(String(name || id));
    }
};

window.assignVisual = (id, visualKey) => {
    const actor = characters[id];
    const key = String(visualKey || "").toLowerCase();
    if (!actor || !MODEL_CATALOG[key]) {
        return;
    }
    actor.visualKey = key;
    actor._loadVisual(key);
};

window.getSceneReady = () => true;

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    controls.update(); // Update orbit controls
    Object.values(characters).forEach((c) => c.update(dt));
    renderer.render(scene, camera);
}

animate();
