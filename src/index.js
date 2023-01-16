// ThreeJS and Third-party deps
import * as THREE from "three"
import * as dat from 'dat.gui'
import Stats from "three/examples/jsm/libs/stats.module"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls"

// Core boilerplate code deps
import { createCamera, createComposer, createRenderer, runApp, getDefaultUniforms } from "./core-utils"
import { loadHDRI } from "./common-utils"

// Other deps
const hdriURL = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/empty_warehouse_01_1k.hdr'
const displacementMapURL = 'https://i.imgur.com/L1pqRg9.jpeg'
import TextureImg from "./assets/wavy6.png"

global.THREE = THREE

/**************************************************
 * 0. Tweakable parameters for the scene
 *************************************************/
const params = {
  // general scene params
  roughness: 0.1,
  iterations: 100,
  depth: 0.3,
  smoothing: 0.2,
  displacement: 0.1,
  speed: 0.05,
  colorA: '#000000',
  colorB: '#e000ff'
}
const uniforms = {
  ...getDefaultUniforms(),
  iterations: { value: params.iterations },
  depth: { value: params.depth },
  smoothing: { value: params.smoothing },
  colorA: { value: new THREE.Color(params.colorA) },
  colorB: { value: new THREE.Color(params.colorB) },
  displacement: { value: params.displacement },
}

/**************************************************
 * 1. Initialize core threejs components
 *************************************************/
// Create the scene
let scene = new THREE.Scene()

// Create the renderer via 'createRenderer',
// 1st param receives additional WebGLRenderer properties
// 2nd param receives a custom callback to further configure the renderer
let renderer = createRenderer({ antialias: true, alpha: true }, (_renderer) => {
  _renderer.toneMapping = THREE.ACESFilmicToneMapping
  // e.g. uncomment below if you want the output to be in sRGB color space
  _renderer.outputEncoding = THREE.sRGBEncoding
})

// Create the camera
// Pass in fov, near, far and camera position respectively
let camera = createCamera(75, 0.1, 100, { x: 0, y: 0, z: 2 })


/**************************************************
 * 2. Build your scene in this threejs app
 * This app object needs to consist of at least the async initScene() function (it is async so the animate function can wait for initScene() to finish before being called)
 * initScene() is called after a basic threejs environment has been set up, you can add objects/lighting to you scene in initScene()
 * if your app needs to animate things(i.e. not static), include a updateScene(interval, elapsed) function in the app as well
 *************************************************/
let app = {
  async loadTexture(url) {
    this.textureLoader = this.textureLoader || new THREE.TextureLoader()
    return new Promise(resolve => {
      this.textureLoader.load(url, texture => {
        resolve(texture)
      })
    })
  },
  async initScene() {
    // OrbitControls
    this.controls = new OrbitControls(camera, renderer.domElement)
    this.controls.enableDamping = true
    this.controls.autoRotate = true
    this.controls.autoRotateSpeed = 1.0

    // set up environment
    const envMap = await loadHDRI(hdriURL)
    scene.environment = envMap
    scene.background = new THREE.Color(0xffffff)

    // Load heightmap and displacementMap textures
    const heightMap = await this.loadTexture(TextureImg)
    const displacementMap = await this.loadTexture(displacementMapURL)
    displacementMap.wrapS = displacementMap.wrapT = THREE.RepeatWrapping
    // Prevent seam introduced by THREE.LinearFilter
    heightMap.minFilter = THREE.NearestFilter
    // Add heightmap and displacementMap to local uniforms object
    uniforms.heightMap = {
      value: heightMap
    }
    uniforms.displacementMap = {
      value: displacementMap
    }

    const auroraGeometry = new THREE.SphereGeometry(1, 64, 32)
    const baseGeometry = new THREE.SphereGeometry(0.925, 64, 32)
    auroraMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        varying float a_pos;
        // varying float a_cam;
        varying vec3 v_pos;
        varying vec3 v_dir;
        varying vec3 v_cam;

        #define PI 3.14159265359

        // angle returned in radians
        float angleBetweenVs(vec3 v1, vec3 v2) {
          return acos(dot(v1, v2) / (length(v1) * length(v2)));
        }

        void main() {
          // cal the attackAngle
          v_pos = position;
          v_cam = cameraPosition;
          v_dir = position - cameraPosition; // Points from camera to vertex
          a_pos = angleBetweenVs(cameraPosition, position);
          // vec3 revCam = cameraPosition * -1.;
          // a_cam = angleBetweenVs(v_dir, revCam);
          // attackAngle = PI / 2. - anglePos - angleCam;

          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); 
        }
      `,
      fragmentShader: `
        #ifdef GL_ES
        precision mediump float;
        #endif

        #include <common>

        #define FLIP vec2(1., -1.)

        uniform vec3 colorA;
        uniform vec3 colorB;
        uniform sampler2D heightMap;
        uniform sampler2D displacementMap;
        uniform int iterations;
        uniform float depth;
        uniform float smoothing;
        uniform float displacement;

        uniform vec2 u_resolution;
        uniform vec2 u_mouse;
        uniform float u_time;
        
        varying vec3 v_pos;
        varying vec3 v_dir;
        varying vec3 v_cam;
        varying float a_pos;

        /**
         * @param p - Point to displace
         * @param strength - How much the map can displace the point
         * @returns Point with scrolling displacement applied
         */
        vec3 displacePoint(vec3 p, float strength) {
        	vec2 uv = equirectUv(normalize(p));
          vec2 scroll = vec2(u_time, 0.);
          vec3 displacementA = texture(displacementMap, uv + scroll).rgb; // Upright
					vec3 displacementB = texture(displacementMap, uv * FLIP - scroll).rgb; // Upside down
          
          // Center the range to [-0.5, 0.5], note the range of their sum is [-1, 1]
          displacementA -= 0.5;
          displacementB -= 0.5;
          
          return p + strength * (displacementA + displacementB);
        }

        // https://en.wikipedia.org/wiki/Quadratic_equation
        // we are only taking the larger result as we use + sign
        // but actually we might want to consider both intersections as that's more realistic
        void solveQuadratic(float a, float b, float c, inout float roots[3]) {
          float discriminant = b*b - 4.0*a*c;
          if (discriminant > 0.0) {
            roots[0] = 2.0;
            // a smaller value means a closer point
            roots[1] = (-b - sqrt(pow(b,2.0) - 4.0*a*c)) / (2.0 * a);
            // a larger value means a further point
            roots[2] = (-b + sqrt(pow(b,2.0) - 4.0*a*c)) / (2.0 * a);
          } else if (discriminant >= 0.0) {
            roots[0] = 1.0;
            roots[1] = (-b + sqrt(pow(b,2.0) - 4.0*a*c)) / (2.0 * a);
          } else {
            roots[0] = 0.0;
          }
        }

        float marchRay(vec3 ray, float marched, float endPoint, float marchStep, float stepWeight) {
          float totalVolume = 0.;
          while (marched <= endPoint) {
            vec3 p = v_cam + marched * ray;
            // below displacement effect is not suitable for the aurora pattern
            // p = displacePoint(p, displacement);
            vec2 uv = equirectUv(normalize(p));
            float heightMapVal = texture(heightMap, uv).r;
            totalVolume += heightMapVal * stepWeight;
            marched += marchStep;
          }
          return totalVolume;
        }

        void main() {
          vec3 rayDir = normalize(v_dir);
          float radius = 1.0;
          float totalVolume = 0.;
          float marchStep = 1. / float(iterations);
          float stepWeight = marchStep * 2.;

          float roots_outer[3];
          float roots_inner[3];
          float a = dot(rayDir, rayDir);
          float b = 2.0 * (dot(rayDir, v_cam));
          float c_outer = dot(v_cam, v_cam) - pow(radius, 2.0);
          float c_inner = dot(v_cam, v_cam) - pow((radius-depth), 2.0);
          // https://en.wikipedia.org/wiki/Line%E2%80%93sphere_intersection
          // calculate a,b,c of the line equation for v_dir
          // solving for outer and inner shells
          solveQuadratic(a, b, c_outer, roots_outer);
          solveQuadratic(a, b, c_inner, roots_inner);

          if (int(roots_outer[0]) == 1) {
            totalVolume = marchRay(rayDir, roots_outer[1], roots_outer[1], marchStep, stepWeight);
          } else if (int(roots_inner[0]) <= 1) {
            // starts at the closest intersection
            totalVolume = marchRay(rayDir, roots_outer[1], roots_outer[2], marchStep, stepWeight);
          } else if (int(roots_inner[0]) == 2) {
            // start with the first intersection pair
            totalVolume = marchRay(rayDir, roots_outer[1], roots_inner[1], marchStep, stepWeight);
            // next loop the second intersection pair
            totalVolume += marchRay(rayDir, roots_inner[2], roots_outer[2], marchStep, stepWeight);
          }
          
          // Top-clamp the totalVolume so the colors at overlapping areas won't be too blown-up
          vec4 rgba = mix(vec4(colorA, 0.0), vec4(colorB, 1.0), clamp(totalVolume, 0.0, 0.9));
          gl_FragColor = rgba;
        }
      `,
      uniforms: uniforms,
      // transparent: true
    })
    const baseMaterial = new THREE.MeshStandardMaterial({
      roughness: params.roughness,
      color: new THREE.Color(0x2299dd)
    })

    this.auroraMesh = new THREE.Mesh(auroraGeometry, auroraMaterial)
    scene.add(this.auroraMesh)
    // this.baseMesh = new THREE.Mesh(baseGeometry, baseMaterial)
    // scene.add(this.baseMesh)

    // GUI controls
    const gui = new dat.GUI()
    gui.add(params, 'roughness', 0, 1, 0.01).onChange(v => baseMaterial.roughness = v)
    gui.add(params, 'iterations', 10, 150, 1).onChange(v => uniforms.iterations.value = v)
    gui.add(params, 'depth', 0, 1, 0.01).onChange(v => uniforms.depth.value = v)
    gui.add(params, 'smoothing', 0, 1, 0.01).onChange(v => uniforms.smoothing.value = v)
    gui.add(params, 'displacement', 0, 0.3, 0.001).onChange(v => uniforms.displacement.value = v)
    gui.add(params, 'speed', 0, 0.1, 0.001)
    gui.addColor(params, 'colorA').onChange(v => uniforms.colorA.value.set(v))
    gui.addColor(params, 'colorB').onChange(v => uniforms.colorB.value.set(v))

    // Stats - show fps
    this.stats1 = new Stats()
    this.stats1.showPanel(0) // Panel 0 = fps
    this.stats1.domElement.style.cssText = "position:absolute;top:0px;left:0px;"
    // this.container is the parent DOM element of the threejs canvas element
    this.container.appendChild(this.stats1.domElement)
  },
  // @param {number} interval - time elapsed between 2 frames
  // @param {number} elapsed - total time elapsed since app start
  updateScene(interval, elapsed) {
    this.controls.update()
    this.stats1.update()
  }
}

/**************************************************
 * 3. Run the app
 * 'runApp' will do most of the boilerplate setup code for you:
 * e.g. HTML container, window resize listener, mouse move/touch listener for shader uniforms, THREE.Clock() for animation
 * Executing this line puts everything together and runs the app
 * ps. if you don't use custom shaders, pass undefined to the 'uniforms'(2nd-last) param
 * ps. if you don't use post-processing, pass undefined to the 'composer'(last) param
 *************************************************/
runApp(app, scene, renderer, camera, true, uniforms, undefined)
