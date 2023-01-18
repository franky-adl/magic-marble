#ifdef GL_ES
precision mediump float;
#endif

#include <common>

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
 * Reference: https://en.wikipedia.org/wiki/Quadratic_equation
 * This function basically solves a quadratic equation
 * and saves the roots in the roots param
 * roots[0] saves the number of roots found
 * roots[1] saves the first root
 * roots[2] saves the 2nd root
 */
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

/**
 * The function the march the ray between the roots
 * @param ray       : the ray to be marched
 * @param marched   : the marched distance in terms of the t variable in the line equation p = v_cam + t * ray
 * @param endPoint  : the endpoint distance in terms of the t variable
 * @param marchStep : the distance between consecutive march steps
 * @param stepWeight: the volume/color weight each march step should weigh
 */
float marchRay(vec3 ray, float marched, float endPoint, float marchStep, float stepWeight) {
    float totalVolume = 0.;
    while (marched <= endPoint) {
        vec3 p = v_cam + marched * ray;
        // equirectUv function is included from the common shader lib
        vec2 uv = equirectUv(normalize(p));
        float heightMapVal = texture(heightMap, uv).r;
        totalVolume += heightMapVal * stepWeight;
        marched += marchStep;
    }
    return totalVolume;
}

void main() {
    vec3 rayDir = normalize(v_dir); // the ray pointing from camera to the vertex
    float radius = 1.0; // should be the same as the size you define for the SphereGeometry
    float totalVolume = 0.;
    float marchStep = 1. / float(iterations);
    float stepWeight = marchStep * 2.;

    // Calculation Logic:
    // 1. Assume we have a range for the aurora bands, bounded by a outer sphere and inner sphere
    // 2. Find the intersection points of the current ray with both shells
    // 3. march the ray between the roots/intersections while mapping from the color map value at each uv position along the way
    // 4. add up all the values on the ray, constituting the totalVolume
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