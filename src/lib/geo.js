import * as THREE from 'three';

export const GLOBE_RADIUS = 1.5;
export const SURFACE_RADIUS = 1.5;

export const DEG = Math.PI / 180;

/**
 * Maps geographic coordinates onto the sphere used by the globe mesh.
 *
 * This is the exact inverse of the equirectangular texture mapping that
 * `sphereGeometry` applies, which is what lets a generated texture and real
 * geography land in the same place:
 *
 *   texture u = (lon + 180) / 360   -> longitude -180 at u=0, 0 at u=0.5
 *   texture v = 1 - (lat + 90) / 180 -> latitude +90 at v=0 (the north pole)
 *
 * so longitude 0 faces +X and the texture seam sits on the -X side.
 */
export function latLonToVector3(lat, lon, radius = SURFACE_RADIUS) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;

  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

/** Longitude wrap-around, kept in [-180, 180). */
export function wrapLongitude(lon) {
  let value = ((lon + 180) % 360 + 360) % 360 - 180;
  if (value === 180) value = -180;
  return value;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function isPolar(lat, margin = 20) {
  return Math.abs(lat) < margin;
}
