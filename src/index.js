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
import TextureImg from "./assets/wavy6.png"

global.THREE = THREE

/**************************************************
 * 0. Tweakable parameters for the scene
 *************************************************/
const params = {
  // general scene params
  roughness: 0.1,
  iterations: 60,
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
    this.controls.autoRotateSpeed = 0.5

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
        varying float a_cam;
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
          vec3 revCam = cameraPosition * -1.;
          a_pos = angleBetweenVs(cameraPosition, position);
          a_cam = angleBetweenVs(v_dir, revCam);
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
        varying float a_cam;

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
        void solveQuadratic(float a, float b, float c, inout float roots[3], float a_pos) {
          float discriminant = b*b - 4.0*a*c;
          if (discriminant > 0.0 && a_pos > 0.0) {
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

        // From: https://www.shadertoy.com/view/Ws3Xzr
        // effect could still be improved, I don't want hard edges for the aurora
        float smoothClamp(float x, float a, float b)
        {
            return smoothstep(0., 1., (x - a)/(b - a))*(b - a) + a;
        }
        float softClamp(float x, float a, float b)
        {
            return smoothstep(0., 1., (2./3.)*(x - a)/(b - a) + (1./6.))*(b - a) + a;
        }

        // https://www.shadertoy.com/view/MsSBRh
        // inverse of y = x²(3-2x)
        float inverse_smoothstep( float x )
        {
            return 0.5-sin(asin(1.0-2.0*x)/3.0);
        }

        float cubicPulse( float c, float w, float x ){
          x = abs(x - c);
          if( x>w ) return 0.0;
          x /= w;
          return 1.0 - x*x*(3.0-2.0*x);
        }

        // angle returned in radians
        float angleBetweenVs(vec3 v1, vec3 v2) {
          return acos(dot(v1, v2) / (length(v1) * length(v2)));
        }

        void main() {
          vec3 rayDir = normalize(v_dir);
          float radius = 1.0;
          float totalVolume = 0.;
          float perIteration = 1. / float(iterations);
          int heightmapHits = 0;
          int intercepts = 0;

          // This is to make depth thinner at the fringes of the sphere
          // such that the shells/iterations are more compact,
          // if the shells are slightly too far apart, you will see the cross-section lines
          float m_depth = depth * (1.0 - smoothstep(0.0, 1.15, a_pos));
          // float m_depth = depth;

          // https://en.wikipedia.org/wiki/Line%E2%80%93sphere_intersection
          // calculate a,b,c of the line equation for v_dir
          for (int i=0; i<iterations; ++i) {
            float a = dot(rayDir, rayDir);
            float b = 2.0 * (dot(rayDir, v_cam));
            float c = dot(v_cam, v_cam) - pow(radius, 2.0);
            float roots[3];
            // solving for intersection points
            solveQuadratic(a, b, c, roots, a_pos);

            // loop through all intersections, roots[0] stores number of intersections
            for (int j=1; j<=int(roots[0]); ++j) {
              intercepts += 1;
              vec3 p = v_cam + roots[j] * rayDir;
              float ang_p = angleBetweenVs(v_cam, p);
              
              vec2 uv = equirectUv(normalize(p));
              float heightMapVal = texture(heightMap, uv).r;
              // dimmify color if it is at the back
              if (j == 2) {
                heightMapVal *= 0.4;
              }

              if (heightMapVal > 0.0) {
                heightmapHits += 1;
              }
              
              // Accumulate the volume and advance the ray forward one step
              // totalVolume += heightMapVal * perIteration;
              // if (ang_p >= 1.11 && j == 1) {
              //   totalVolume += 10.0;
              // }
              // trying to use cubicPulse to only amplify volume at the fringes
              // but the effect isn't enough... as long as you render them as shells,
              // it's still very easy to see the shell fringes even though they have high volume each
              // as long as there're still gaps between them
              // TODO: try to think of a way to 'remove' the gaps at the fringes
              float mid_angle = PI - PI/2. - a_cam;
              totalVolume += heightMapVal * perIteration * pow((cubicPulse(mid_angle, 0.3, ang_p) + 1.0), 2.0);
              // totalVolume += heightMapVal * perIteration;
            }
            // descend one shell downwards
            radius -= m_depth * perIteration;
          }
          // I want to increase the color for the aurora bands at the fringes
          // so I tried using clamp here for places where bands exist
          // but the effect isn't good because that makes the color difference
          // between bands and emptiness too abrupt
          // if (heightmapHits > 0) {
          //   totalVolume = smoothClamp(totalVolume, 0.15, 0.9);
          // }

          // Condition 1: p has to be a point touching a virtual shell
          // Condition 2: p cannot be lower than the lowest shell (1. - m_depth)
          // then check the uv of p and heightmap val there and add that to totalVolume
          // float targetRadius = sin(a_cam) * sqrt(dot(v_cam, v_cam));
          // if (targetRadius >= (1.-m_depth)) {
          //   float rayLength = cos(a_cam) * sqrt(dot(v_cam, v_cam));
          //   vec3 p = v_cam + rayLength * rayDir;
          //   vec2 uv = equirectUv(normalize(p));
          //   float heightMapVal = texture(heightMap, uv).r;
          //   totalVolume += heightMapVal * perIteration * 2.;
          // }

          // TODO: improve the above approximate fix
          // such that not only at the point of fringe that the color is magnified
          // but angles near the point of fringe need to receive the amplification proportionally/smoothly
          // Condition 1: set a range for a_pos that does amplification?
          // Condition 2: has to be where there are heightmap values
          
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
