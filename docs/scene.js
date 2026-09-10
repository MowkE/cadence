import * as THREE from './vendor/three.module.js';

// A small, self-contained sculpture renderer. No image requests, postprocessing,
// physics loop, or animation work while the sculpture is outside the viewport.
export function initSculpture({ canvas, reducedMotion, onReady = () => {} } = {}) {
  const inert = { setMode() {}, setEnergy() {}, setProgress() {}, setPaused() {}, reset() {}, dispose() {} };
  if (!canvas) { onReady(false); return inert; }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    onReady(false);
    return inert;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 65);
  const sculpture = new THREE.Group();
  scene.add(sculpture);
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;

  let environment;
  let disposed = false;
  let contextLost = false;
  let visible = false;
  let paused = false;
  let frame = 0;
  let lastTick = 0;
  let lastDraw = 0;
  let elapsed = 0;
  let dirty = true;
  let pointer = null;
  let yaw = -0.2;
  let pitch = 0.96;
  let targetYaw = yaw;
  let targetPitch = pitch;
  let energy = 0.48;
  let targetEnergy = energy;
  let progress = 0;
  let targetProgress = 0;
  let mode = 'vinyl';
  const weights = { vinyl: 1, wave: 0, orbit: 0 };
  const resources = new Set();
  const textureResources = new Set();
  const rings = [];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const own = (resource) => { resources.add(resource); return resource; };
  const motionAllowed = () => !reducedMotion?.matches && !paused;
  const canAnimate = () => visible && !document.hidden && !contextLost && motionAllowed();

  function makeEnvironment() {
    const room = new THREE.Scene();
    const roomObjects = [];
    const wall = new THREE.Mesh(new THREE.BoxGeometry(24, 24, 24), new THREE.MeshBasicMaterial({ color: 0x252b27, side: THREE.BackSide }));
    room.add(wall);
    roomObjects.push(wall);
    const panel = (width, height, color, intensity, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), toneMapped: false, side: THREE.DoubleSide }));
      mesh.position.set(x, y, z);
      mesh.lookAt(0, 0, 0);
      room.add(mesh);
      roomObjects.push(mesh);
    };
    panel(9, 4, 0xf3fff5, 5, 0, 7, 3);
    panel(2.2, 11, 0xffffff, 6, -5, 1, 4);
    panel(5, 10, 0xffffff, 3, 7, 1, -2);
    panel(9, 1, 0xdaff78, 2.4, 0, -3, 5);
    panel(1.4, 9, 0xc2d5de, 2.5, -2, 0, -6);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const nextEnvironment = pmrem.fromScene(room, 0.045, 0.1, 40, { size: 128 });
    pmrem.dispose();
    for (const mesh of roomObjects) { mesh.geometry.dispose(); mesh.material.dispose(); }
    environment?.dispose();
    environment = nextEnvironment;
    scene.environment = environment.texture;
    scene.environmentIntensity = 1.05;
  }

  function brushedTexture() {
    const surface = document.createElement('canvas');
    surface.width = 256;
    surface.height = 64;
    const ctx = surface.getContext('2d');
    if (!ctx) return null;
    const pixels = ctx.createImageData(256, 64);
    let seed = 93217;
    for (let y = 0; y < 64; y++) {
      seed = (seed * 16807) % 2147483647;
      const line = 174 + (seed % 61);
      for (let x = 0; x < 256; x++) {
        seed = (seed * 16807) % 2147483647;
        const shade = line + (seed % 15);
        const i = (y * 256 + x) * 4;
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = shade;
        pixels.data[i + 3] = 255;
      }
    }
    ctx.putImageData(pixels, 0, 0);
    const texture = new THREE.CanvasTexture(surface);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 1);
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    textureResources.add(texture);
    return texture;
  }

  try {
    makeEnvironment();
    const roughnessMap = brushedTexture();
    const chrome = own(new THREE.MeshStandardMaterial({ color: 0x727971, metalness: 1, roughness: 0.33, roughnessMap }));
    const darkChrome = own(new THREE.MeshStandardMaterial({ color: 0x373f3a, metalness: 1, roughness: 0.3, roughnessMap }));
    const edgeChrome = own(new THREE.MeshStandardMaterial({ color: 0xa6b2a6, metalness: 1, roughness: 0.24, roughnessMap }));
    const acid = own(new THREE.MeshStandardMaterial({ color: 0xd5ff64, emissive: 0x739b09, emissiveIntensity: 0.25, metalness: 0.5, roughness: 0.28 }));
    const labelMaterial = own(new THREE.MeshStandardMaterial({ color: 0xb5c0a7, metalness: 0.65, roughness: 0.36 }));

    // Twenty-four flattened toroids read as the machined grooves of one record
    // until scroll and the three arrangements pull them into a floating object.
    const count = 24;
    for (let index = 0; index < count; index++) {
      const n = index / (count - 1);
      const radius = 0.49 + n * 1.91;
      const group = new THREE.Group();
      const thickness = 0.035 + n * 0.013;
      const geometry = own(new THREE.TorusGeometry(radius, thickness, 8, 112));
      const ring = new THREE.Mesh(geometry, index % 6 === 0 ? edgeChrome : index % 3 === 0 ? darkChrome : chrome);
      ring.scale.z = 0.65;
      group.add(ring);
      if (index === 1 || index === 12 || index === 23) {
        const arcGeometry = own(new THREE.TorusGeometry(radius, index === 23 ? 0.015 : 0.01, 6, 96, index === 23 ? Math.PI * 1.35 : Math.PI * 0.9));
        const inlay = new THREE.Mesh(arcGeometry, acid);
        inlay.position.z = thickness * 0.64;
        inlay.rotation.z = index * 1.1;
        group.add(inlay);
      }
      sculpture.add(group);
      rings.push({ group, n, index });
    }

    const center = new THREE.Group();
    const hub = new THREE.Mesh(own(new THREE.CylinderGeometry(0.4, 0.4, 0.12, 64)), darkChrome);
    hub.rotation.x = Math.PI / 2;
    center.add(hub);
    const label = new THREE.Mesh(own(new THREE.CylinderGeometry(0.3, 0.3, 0.018, 64)), labelMaterial);
    label.rotation.x = Math.PI / 2;
    label.position.z = 0.067;
    center.add(label);
    const hubInlay = new THREE.Mesh(own(new THREE.TorusGeometry(0.34, 0.017, 8, 64)), acid);
    hubInlay.position.z = 0.073;
    center.add(hubInlay);
    const spindle = new THREE.Mesh(own(new THREE.CylinderGeometry(0.057, 0.075, 0.42, 24)), edgeChrome);
    spindle.rotation.x = Math.PI / 2;
    spindle.position.z = 0.12;
    center.add(spindle);
    const tip = new THREE.Mesh(own(new THREE.SphereGeometry(0.062, 16, 8)), acid);
    tip.position.z = 0.34;
    center.add(tip);
    sculpture.add(center);

    const particles = new THREE.InstancedMesh(own(new THREE.OctahedronGeometry(0.012, 0)), own(new THREE.MeshBasicMaterial({ color: 0xabbca4, transparent: true, opacity: 0.42, depthWrite: false })), 90);
    particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    particles.frustumCulled = false;
    scene.add(particles);
    const dummy = new THREE.Object3D();
    const seeds = Array.from({ length: 90 }, (_, i) => ({
      angle: i * 2.39996323,
      radius: 2.6 + ((i * 47) % 83) / 83 * 1.4,
      elevation: (((i * 31) % 97) / 97 - 0.5) * 3.8,
      scale: 0.5 + ((i * 17) % 29) / 29,
    }));

    const key = new THREE.DirectionalLight(0xf7ffec, 2.1);
    key.position.set(-3, 6, 7);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xc6e7df, 1.1);
    rim.position.set(5, -2, -3);
    scene.add(rim, new THREE.AmbientLight(0xe7eee1, 0.28));

    function update(dt, snap) {
      const ease = snap ? 1 : 1 - Math.exp(-dt * 7);
      yaw += (targetYaw - yaw) * ease;
      pitch += (targetPitch - pitch) * ease;
      energy += (targetEnergy - energy) * ease;
      progress += (targetProgress - progress) * ease;
      for (const name of Object.keys(weights)) weights[name] += ((mode === name ? 1 : 0) - weights[name]) * ease;
      const pulse = reducedMotion?.matches ? 0 : elapsed;
      sculpture.rotation.set(pitch + Math.sin(pulse * 0.2) * 0.035, yaw + progress * 0.68 + Math.sin(pulse * 0.13) * 0.08, -0.27 + progress * 0.13);
      sculpture.position.y = Math.sin(pulse * 0.42) * 0.055;
      for (const { group, n, index } of rings) {
        const ripple = Math.sin(n * Math.PI * 3.4 - pulse * (0.65 + energy * 0.7));
        const rest = Math.sin(index * 0.42 + pulse * 0.25) * 0.025 * energy;
        group.position.z = rest + (n - 0.38) * progress * 1.65 + weights.wave * ripple * (0.12 + energy * 0.55);
        group.position.x = weights.wave * Math.sin(n * 5.7 + pulse * 0.4) * n * 0.1;
        group.position.y = weights.orbit * Math.sin(n * 4 + pulse * 0.2) * 0.15;
        group.rotation.x = weights.orbit * Math.sin(n * Math.PI * 1.45 + pulse * 0.16) * (0.38 + energy * 0.65) + weights.wave * ripple * 0.1;
        group.rotation.y = weights.orbit * Math.cos(n * Math.PI * 1.25 + pulse * 0.13) * (0.25 + energy * 0.7);
        group.rotation.z = weights.orbit * n * 0.48 + pulse * 0.025 * (0.3 + n * energy);
        const scale = 1 + progress * n * 0.085;
        group.scale.setScalar(scale);
      }
      center.position.z = -progress * 0.32;
      center.rotation.z = pulse * 0.07;
      for (let i = 0; i < seeds.length; i++) {
        const seed = seeds[i];
        const angle = seed.angle + pulse * (0.022 + energy * 0.012);
        dummy.position.set(Math.cos(angle) * seed.radius, seed.elevation + Math.sin(angle * 2 + pulse * 0.12) * 0.09, Math.sin(angle) * seed.radius * 0.55 - 0.5);
        dummy.scale.setScalar(seed.scale);
        dummy.updateMatrix();
        particles.setMatrixAt(i, dummy.matrix);
      }
      particles.instanceMatrix.needsUpdate = true;
    }

    function draw(now) {
      frame = 0;
      if (disposed || contextLost || document.hidden || !visible) return;
      const dt = lastTick ? Math.min((now - lastTick) / 1000, 0.05) : 1 / 30;
      lastTick = now;
      if (canAnimate()) elapsed += dt;
      // The slow sculpture only needs 30 fps; direct manipulation stays at 60.
      if (dirty || pointer || now - lastDraw >= 1000 / 30) {
        update(lastDraw ? Math.min((now - lastDraw) / 1000, 0.08) : dt, !motionAllowed());
        renderer.render(scene, camera);
        lastDraw = now;
        dirty = false;
      }
      if (canAnimate()) frame = requestAnimationFrame(draw);
    }

    function requestRender() {
      dirty = true;
      if (!frame && !disposed && !contextLost && visible && !document.hidden) {
        lastTick = 0;
        frame = requestAnimationFrame(draw);
      }
    }

    function resize() {
      if (disposed) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      const distance = 9.3 / Math.min(camera.aspect, 1);
      camera.position.set(0, 0.3, distance);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      requestRender();
    }

    function pauseLoop() {
      cancelAnimationFrame(frame);
      frame = 0;
      lastTick = 0;
    }
    function activityChanged() {
      if (!canAnimate()) pauseLoop();
      requestRender();
    }
    function pointerDown(event) {
      if (event.button !== 0 || pointer) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' };
      canvas.setPointerCapture?.(event.pointerId);
      canvas.dataset.dragging = 'true';
      if (event.pointerType !== 'touch') canvas.focus({ preventScroll: true });
      requestRender();
    }
    function pointerMove(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      targetYaw += dx * 0.008;
      if (!pointer.touch) targetPitch = clamp(targetPitch + dy * 0.006, -0.65, 1.55);
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      requestRender();
    }
    function pointerUp(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      pointer = null;
      delete canvas.dataset.dragging;
      requestRender();
    }
    function keyDown(event) {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') targetYaw -= 0.13;
      if (event.key === 'ArrowRight') targetYaw += 0.13;
      if (event.key === 'ArrowUp') targetPitch = clamp(targetPitch - 0.13, -0.65, 1.55);
      if (event.key === 'ArrowDown') targetPitch = clamp(targetPitch + 0.13, -0.65, 1.55);
      if (event.key === 'Home') { targetYaw = -0.2; targetPitch = 0.96; }
      requestRender();
    }
    function lost(event) {
      event.preventDefault();
      contextLost = true;
      pauseLoop();
      onReady(false);
    }
    function restored() {
      if (disposed) return;
      try {
        makeEnvironment();
        contextLost = false;
        requestRender();
        onReady(true);
      } catch { onReady(false); }
    }

    canvas.style.touchAction = 'pan-y';
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerUp);
    canvas.addEventListener('lostpointercapture', pointerUp);
    canvas.addEventListener('keydown', keyDown);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    document.addEventListener('visibilitychange', activityChanged);
    reducedMotion?.addEventListener?.('change', activityChanged);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      activityChanged();
    }, { threshold: 0.01 });
    observer.observe(canvas);
    const bounds = canvas.getBoundingClientRect();
    visible = bounds.bottom > 0 && bounds.top < window.innerHeight && bounds.right > 0 && bounds.left < window.innerWidth;
    resize();
    update(0, true);
    // Render once before signaling ready, so the CSS fallback cannot blink away
    // before a frame exists (including if initialized below the fold).
    renderer.render(scene, camera);
    onReady(true);

    return {
      setMode(value) {
        if (!Object.hasOwn(weights, value) || mode === value) return;
        mode = value;
        requestRender();
      },
      setEnergy(value) {
        if (!Number.isFinite(Number(value))) return;
        targetEnergy = clamp(Number(value), 0, 1);
        requestRender();
      },
      setProgress(value) {
        if (!Number.isFinite(Number(value))) return;
        const next = clamp(Number(value), 0, 1);
        if (Math.abs(next - targetProgress) < 0.0001) return;
        targetProgress = next;
        requestRender();
      },
      setPaused(value) {
        paused = Boolean(value);
        activityChanged();
      },
      reset() { targetYaw = -0.2; targetPitch = 0.96; requestRender(); },
      dispose() {
        if (disposed) return;
        disposed = true;
        pauseLoop();
        observer.disconnect();
        resizeObserver.disconnect();
        document.removeEventListener('visibilitychange', activityChanged);
        reducedMotion?.removeEventListener?.('change', activityChanged);
        canvas.removeEventListener('pointerdown', pointerDown);
        canvas.removeEventListener('pointermove', pointerMove);
        canvas.removeEventListener('pointerup', pointerUp);
        canvas.removeEventListener('pointercancel', pointerUp);
        canvas.removeEventListener('lostpointercapture', pointerUp);
        canvas.removeEventListener('keydown', keyDown);
        canvas.removeEventListener('webglcontextlost', lost);
        canvas.removeEventListener('webglcontextrestored', restored);
        for (const resource of resources) resource.dispose();
        for (const texture of textureResources) texture.dispose();
        environment?.dispose();
        renderer.dispose();
      },
    };
  } catch (error) {
    cancelAnimationFrame(frame);
    for (const resource of resources) resource.dispose();
    for (const texture of textureResources) texture.dispose();
    environment?.dispose();
    renderer.dispose();
    console.warn('The interactive sculpture could not start.', error);
    onReady(false);
    return inert;
  }
}
