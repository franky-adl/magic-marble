varying float a_pos;
varying vec3 v_pos;
varying vec3 v_dir;
varying vec3 v_cam;
varying vec2 vUv;

#define PI 3.14159265359

// angle returned in radians
float angleBetweenVs(vec3 v1, vec3 v2) {
    return acos(dot(v1, v2) / (length(v1) * length(v2)));
}

void main() {
    vUv = uv;
    v_pos = position;
    v_cam = cameraPosition;
    v_dir = position - cameraPosition; // Points from camera to vertex
    a_pos = angleBetweenVs(cameraPosition, position); // angle between vertex vec and camera vec

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); 
}