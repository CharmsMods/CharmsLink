import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function initRenderer(canvas, onStatus) {
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
  if (!gl) {
    throw new Error('WebGL2 is required but not available.');
  }

  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 1.2, 3.5);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = new RoomEnvironment();
  const envMap = pmrem.fromScene(environment).texture;
  scene.environment = envMap;

  const pathTracer = new WebGLPathTracer(renderer);
  pathTracer.setScene(scene, camera);
  pathTracer.renderToCanvas = true;
  pathTracer.synchronizeRenderSize = true;

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(2, 5, 3);
  scene.add(keyLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));

  return {
    renderer,
    scene,
    camera,
    controls,
    pathTracer,
    resize(width, height) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    setRenderScale(scale) {
      pathTracer.renderScale = scale;
    },
    resetSamples() {
      pathTracer.reset();
    },
    dispose() {
      envMap.dispose();
      pmrem.dispose();
      renderer.dispose();
    }
  };
}

export function fitCameraToObject(camera, controls, object, offset = 1.25) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
  cameraZ *= offset;

  camera.position.set(center.x, center.y + maxDim * 0.1, center.z + cameraZ);
  camera.near = maxDim / 100;
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}
