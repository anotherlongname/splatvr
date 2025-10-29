/* global THREE */
const canvas = document.getElementById('xr-canvas');
const fileInput = document.getElementById('fileInput');
const enterARBtn = document.getElementById('enterAR');
const statusEl = document.getElementById('status');

let renderer, scene, camera;
let xrSession = null;
let referenceSpace = null;
let hitTestSource = null;
let viewerSpace = null;
let reticle = null;
let modelRoot = null; // container for the STL model
let grabbedBy = null; // controller currently grabbing the model
let initialSqueezeDistance = null; // for scaling with two controllers
let controllers = []; // store controller objects

init();

function init() {
  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, canvas });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');

  // Scene + camera
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
  scene.add(camera);

  // Lighting for STL (which has no materials)
  const hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 0.8);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(0.5, 1, 0.2);
  scene.add(hemi, dir);

  // Reticle to indicate hit test placement
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.1, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x00ff88 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Controllers: rays for pointing
  setupController(0);
  setupController(1);

  window.addEventListener('resize', onWindowResize);
  fileInput.addEventListener('change', onFileSelected);
  enterARBtn.addEventListener('click', onEnterAR);
}

function onWindowResize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}

function onFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    loadSTL(reader.result);
  };
  reader.readAsArrayBuffer(file);
}

function loadSTL(arrayBuffer) {
  const loader = new THREE.STLLoader();
  const geometry = loader.parse(arrayBuffer);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0xcccccc,
    metalness: 0.1,
    roughness: 0.7
  });

  const mesh = new THREE.Mesh(geometry, material);

  // Normalize scale: fit to ~0.3m bounding box
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const size = new THREE.Vector3().subVectors(bb.max, bb.min);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const target = 0.3; // meters
  mesh.scale.setScalar(target / maxDim);

  // Center geometry at origin
  const center = new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5);
  mesh.position.sub(center);

  if (!modelRoot) {
    modelRoot = new THREE.Group();
    scene.add(modelRoot);
  } else {
    modelRoot.clear();
  }
  modelRoot.add(mesh);

  // Start above reticle if visible; else place at origin
  if (reticle.visible) {
    modelRoot.matrix.copy(reticle.matrix);
    modelRoot.matrix.decompose(modelRoot.position, modelRoot.quaternion, modelRoot.scale);
  } else {
    modelRoot.position.set(0, 0, -0.5);
  }

  statusEl.textContent = 'Model loaded. Point at a surface and press trigger to place. Grip to grab. Squeeze both controllers to scale.';
}

async function onEnterAR() {
  if (!navigator.xr) {
    statusEl.textContent = 'WebXR not supported.';
    return;
  }
  try {
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) {
      statusEl.textContent = 'Immersive AR not supported on this device/browser.';
      return;
    }

    xrSession = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'local-floor'],
      optionalFeatures: ['anchors']
    });

    renderer.xr.setSession(xrSession);

    viewerSpace = await xrSession.requestReferenceSpace('viewer');
    referenceSpace = await xrSession.requestReferenceSpace('local-floor');

    const hitTestSourceReq = await xrSession.requestHitTestSource({ space: viewerSpace });
    hitTestSource = hitTestSourceReq;

    xrSession.addEventListener('end', () => {
      xrSession = null;
      hitTestSource = null;
      reticle.visible = false;
      statusEl.textContent = 'Session ended.';
    });

    renderer.setAnimationLoop(onXRFrame);
    statusEl.textContent = 'AR session started. Upload an STL and aim at a surface.';
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Failed to start AR session.';
  }
}

function onXRFrame(time, frame) {
  const session = frame.session;
  const pose = frame.getViewerPose(referenceSpace);
  if (!pose) return;

  // Hit test update for reticle
  if (hitTestSource) {
    const hits = frame.getHitTestResults(hitTestSource);
    if (hits.length > 0) {
      const hit = hits[0];
      const hitPose = hit.getPose(referenceSpace);
      reticle.visible = true;
      reticle.matrix.fromArray(hitPose.transform.matrix);
    } else {
      reticle.visible = false;
    }
  }

  // Controller transforms come from Three.js helpers
  // If grabbing with one controller, attach model to controller
  if (grabbedBy && modelRoot) {
    modelRoot.position.copy(grabbedBy.position);
    modelRoot.quaternion.copy(grabbedBy.quaternion);
  }

  // Two-hand squeeze scaling
  const c0 = controllers[0], c1 = controllers[1];
  if (c0 && c1 && c0.userData.squeezing && c1.userData.squeezing && modelRoot) {
    const d = c0.position.distanceTo(c1.position);
    if (initialSqueezeDistance == null) {
      initialSqueezeDistance = d;
    } else {
      const scaleFactor = d / initialSqueezeDistance;
      modelRoot.scale.setScalar(modelRoot.scale.x * scaleFactor);
      initialSqueezeDistance = d; // incremental scaling
    }
  } else {
    initialSqueezeDistance = null;
  }

  renderer.render(scene, camera);
}

function setupController(index) {
  const controller = renderer.xr.getController(index);
  scene.add(controller);

  // Ray for pointing
  const rayGeo = new THREE.CylinderGeometry(0.002, 0.002, 1, 8);
  const rayMat = new THREE.MeshBasicMaterial({ color: index === 0 ? 0x44aa88 : 0x8888ff });
  const ray = new THREE.Mesh(rayGeo, rayMat);
  ray.rotation.x = Math.PI / 2;
  ray.position.z = -0.5;
  controller.add(ray);

  // Events
  controller.addEventListener('select', () => {
    // Trigger to place the model on the reticle
    if (reticle.visible && modelRoot) {
      modelRoot.matrix.copy(reticle.matrix);
      modelRoot.matrix.decompose(modelRoot.position, modelRoot.quaternion, modelRoot.scale);
    }
  });

  controller.addEventListener('squeeze', () => {
    controller.userData.squeezing = true;
  });

  controller.addEventListener('squeezeend', () => {
    controller.userData.squeezing = false;
  });

  controller.addEventListener('gripdown', () => {
    // Grip to grab the model
    if (!modelRoot) return;
    const distance = controller.position.distanceTo(modelRoot.position);
    if (distance < 0.5) {
      grabbedBy = controller;
    }
  });

  controller.addEventListener('gripup', () => {
    // Release
    if (grabbedBy === controller) {
      grabbedBy = null;
    }
  });

  controllers[index] = controller;
}
