// ThreeJS and Third-party deps
import * as THREE from "three"
import * as dat from 'dat.gui'
import Stats from "three/examples/jsm/libs/stats.module"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls"
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader"

// Core boilerplate code deps
import { createCamera, createComposer, createRenderer, runApp, getDefaultUniforms } from "./core-utils"
import { loadHDRI } from "./common-utils"

// Other deps
const hdriURL = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/empty_warehouse_01_1k.hdr'
const displacementMapURL = 'https://i.imgur.com/L1pqRg9.jpeg'
import TextureImg from "./assets/texture.jpeg"

global.THREE = THREE

/**************************************************
 * 0. Tweakable parameters for the scene
 *************************************************/
const params = {
  // general scene params
  roughness: 0.1,
  iterations: 48,
  depth: 0.6,
  smoothing: 0.2,
  displacement: 0.1,
  speed: 0.05,
  colorA: '#000000',
  colorB: '#00ffaa'
}
const uniforms = {
  ...getDefaultUniforms(),
  iterations: { value: params.iterations },
  depth: { value: params.depth },
  smoothing: { value: params.smoothing },
  colorA: { value: new THREE.Color(params.colorA) },
  colorB: { value: new THREE.Color(params.colorB) },
  displacement: { value: params.displacement },
  time: { value: 0 }
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

    // set up environment
    const envMap = await loadHDRI(hdriURL)
    scene.environment = envMap

    const geometry = new THREE.SphereGeometry(1, 64, 32)
    const material = new THREE.MeshStandardMaterial({ roughness: params.roughness })

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

    material.onBeforeCompile = shader => {
      // Wire up local uniform references
      shader.uniforms = { ...shader.uniforms, ...uniforms }

      // Add to top of vertex shader
      shader.vertexShader = `
        varying vec3 v_pos;
        varying vec3 v_dir;
      ` + shader.vertexShader

      // Assign values to varyings inside of main()
      shader.vertexShader = shader.vertexShader.replace(/void main\(\) {/, (match) => match + `
        v_dir = position - cameraPosition; // Points from camera to vertex
        v_pos = position;
      `)

      // Add to top of fragment shader
      shader.fragmentShader = `
        #define FLIP vec2(1., -1.)

        uniform vec3 colorA;
        uniform vec3 colorB;
        uniform sampler2D heightMap;
        uniform sampler2D displacementMap;
        uniform int iterations;
        uniform float depth;
        uniform float smoothing;
        uniform float displacement;
        uniform float time;
        
        varying vec3 v_pos;
        varying vec3 v_dir;
      ` + shader.fragmentShader

      // Add above fragment shader main() so we can access common.glsl.js
      shader.fragmentShader = shader.fragmentShader.replace(/void main\(\) {/, (match) => `
        /**
         * @param p - Point to displace
         * @param strength - How much the map can displace the point
         * @returns Point with scrolling displacement applied
         */
        vec3 displacePoint(vec3 p, float strength) {
        	vec2 uv = equirectUv(normalize(p));
          vec2 scroll = vec2(time, 0.);
          vec3 displacementA = texture(displacementMap, uv + scroll).rgb; // Upright
					vec3 displacementB = texture(displacementMap, uv * FLIP - scroll).rgb; // Upside down
          
          // Center the range to [-0.5, 0.5], note the range of their sum is [-1, 1]
          displacementA -= 0.5;
          displacementB -= 0.5;
          
          return p + strength * (displacementA + displacementB);
        }

				/**
          * @param rayOrigin - Point on sphere
          * @param rayDir - Normalized ray direction
          * @returns Diffuse RGB color
          */
        vec3 marchMarble(vec3 rayOrigin, vec3 rayDir) {
          float perIteration = 1. / float(iterations);
          vec3 deltaRay = rayDir * perIteration * depth;

          // Start at point of intersection and accumulate volume
          vec3 p = rayOrigin;
          float totalVolume = 0.;

          for (int i=0; i<iterations; ++i) {
            // Read heightmap from spherical direction of displaced ray position
            vec3 displaced = displacePoint(p, displacement);
            vec2 uv = equirectUv(normalize(displaced));
            float heightMapVal = texture(heightMap, uv).r;

            // Take a slice of the heightmap
            // float height = length(p); // 1 at surface, 0 at core, assuming radius = 1
            float cutoff = 1. - float(i) * perIteration;
            float slice = smoothstep(cutoff, cutoff + smoothing, heightMapVal);

            // Accumulate the volume and advance the ray forward one step
            totalVolume += slice * perIteration;
            p += deltaRay;
          }
          // a lower total volume means closer to colorA (which is supposed to be a darker color)
          return mix(colorA, colorB, totalVolume);
        }
      ` + match)

      shader.fragmentShader = shader.fragmentShader.replace(/vec4 diffuseColor.*;/, `
      	vec3 rayDir = normalize(v_dir);
        vec3 rayOrigin = v_pos;
        
        vec3 rgb = marchMarble(rayOrigin, rayDir);
				vec4 diffuseColor = vec4(rgb, 1.);
      `)
    }

    this.mesh = new THREE.Mesh(geometry, material)
    scene.add(this.mesh)

    // GUI controls
    const gui = new dat.GUI()
    gui.add(params, 'roughness', 0, 1, 0.01).onChange(v => material.roughness = v)
    gui.add(params, 'iterations', 0, 64, 1).onChange(v => uniforms.iterations.value = v)
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

    uniforms.time.value += interval * params.speed
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
runApp(app, scene, renderer, camera, true, undefined, undefined)
