export const PARTICLE_VERTEX = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  attribute float aMotion;

  uniform float uPixelRatio;

  varying float vAlpha;
  varying float vMotion;

  void main() {
    vAlpha = aAlpha;
    vMotion = aMotion;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Perspective sizing so distant tracers shrink.
    gl_PointSize = aSize * uPixelRatio * (300.0 / max(-mvPosition.z, 0.0001)) * 0.045;
  }
`;

export const PARTICLE_FRAGMENT = /* glsl */ `
  varying float vAlpha;
  varying float vMotion;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float dist = length(uv);
    if (dist > 0.5) discard;

    // Soft falloff keeps the tracers looking like vapour rather than dots.
    float falloff = smoothstep(0.5, 0.0, dist);
    falloff *= falloff;

    // Slow air is pale cyan, fast air cools toward white-blue.
    vec3 slow = vec3(0.42, 0.83, 0.98);
    vec3 fast = vec3(0.80, 0.92, 1.0);
    vec3 tint = mix(slow, fast, clamp(vMotion, 0.0, 1.0));

    float alpha = falloff * vAlpha * (0.30 + 0.55 * clamp(vMotion, 0.0, 1.0));

    gl_FragColor = vec4(tint, alpha);
  }
`;

export const MIST_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPosition.xyz);

    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

/**
 * Drifting mist on a shell above the surface.
 *
 * Cloud cover drives opacity and the sampled wind colours the haze, so the
 * mist carries the same information as the tracer particles. Each shell is
 * offset in longitude to give the stack some depth without re-sampling.
 */
export const MIST_FRAGMENT = /* glsl */ `
  uniform sampler2D uField;
  uniform vec2 uFieldSize;
  uniform float uTime;
  uniform float uOffset;
  uniform float uOpacity;
  uniform float uDrift;

  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    vec3 dir = normalize(vNormal);

    float lat = degrees(asin(clamp(dir.y, -1.0, 1.0)));
    float lon = degrees(atan(dir.z, dir.x)) + 180.0;

    // Longitude scrolls so the shells never look frozen.
    lon += uOffset + uTime * uDrift;

    float u = lon / 360.0;
    float v = (lat + 90.0) / 180.0;

    vec2 texel = vec2(1.0 / uFieldSize.x, 1.0 / uFieldSize.y);
    float cloud = texture2D(uField, vec2(u, v)).r;

    // Blend in a finer octave so the large 15-degree cells read as texture.
    float detail = texture2D(uField, vec2(u * 2.0 + 0.37, v * 2.0 + 0.19)).r;
    float density = cloud * 0.72 + detail * 0.28;

    // Fade at the limb so the shell does not read as a hard sphere.
    float rim = pow(clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0), 0.85);
    float polar = 1.0 - smoothstep(62.0, 84.0, abs(lat));

    float alpha = smoothstep(0.18, 0.8, density) * uOpacity * rim * polar;
    if (alpha < 0.004) discard;

    vec3 haze = vec3(0.72, 0.85, 1.0);
    gl_FragColor = vec4(haze, alpha);
  }
`;

export const GLOBE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    vUv = uv;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPosition.xyz);

    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

export const GLOBE_FRAGMENT = /* glsl */ `
  uniform sampler2D uSea;
  uniform float uSeaOpacity;
  uniform float uHasSea;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    vec3 land = vec3(0.055, 0.075, 0.11);

    vec3 sea = vec3(0.0);
    float seaWeight = 0.0;

    if (uHasSea > 0.5) {
      vec4 texel = texture2D(uSea, vUv);
      sea = texel.rgb;
      seaWeight = texel.a;
    }

    vec3 base = mix(land, sea, seaWeight * uSeaOpacity);

    // Subtle atmospheric rim to separate the globe from the background.
    float rim = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0), 2.4);
    base += vec3(0.22, 0.46, 0.85) * rim * 0.55;

    gl_FragColor = vec4(base, 1.0);
  }
`;
