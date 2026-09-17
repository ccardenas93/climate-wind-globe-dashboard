import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Stars, Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

import { GLOBE_RADIUS, SURFACE_RADIUS, latLonToVector3 } from '../lib/geo.js';
import { WindParticleSim } from '../lib/windField.js';
import {
  PARTICLE_VERTEX,
  PARTICLE_FRAGMENT,
  MIST_VERTEX,
  MIST_FRAGMENT,
  GLOBE_VERTEX,
  GLOBE_FRAGMENT,
} from '../lib/shaders.js';

const PHYSICS_STEP = 1 / 45;

/** Physical wind tracers driven by the sampled u/v field. */
function WindParticles({ field, time, rate, count }) {
  const simRef = useRef();
  const accumulated = useRef(0);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(count), 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(count), 1));
    geo.setAttribute('aMotion', new THREE.BufferAttribute(new Float32Array(count), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SURFACE_RADIUS * 1.4);
    return geo;
  }, [count]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: PARTICLE_VERTEX,
        fragmentShader: PARTICLE_FRAGMENT,
        uniforms: {
          uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
      }),
    []
  );

  useEffect(() => {
    const sim = new WindParticleSim(count);
    simRef.current = sim;

    const position = geometry.getAttribute('position');
    const alpha = geometry.getAttribute('aAlpha');
    const size = geometry.getAttribute('aSize');
    const motion = geometry.getAttribute('aMotion');

    sim.fillPointAttributes(alpha.array, size.array, motion.array);
    position.array.set(sim.positions);

    position.needsUpdate = true;
    alpha.needsUpdate = true;
    size.needsUpdate = true;
    motion.needsUpdate = true;

    return () => {
      simRef.current = null;
    };
  }, [count, geometry]);

  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  useEffect(() => {
    if (material.uniforms) material.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2);
  }, [material]);

  useFrame((_, delta) => {
    const sim = simRef.current;
    if (!sim || !field) return;

    // Fixed-step integration keeps the flow stable regardless of frame rate.
    accumulated.current = Math.min(accumulated.current + delta * Math.max(rate, 0), 0.5);
    let stepped = false;

    while (accumulated.current >= PHYSICS_STEP) {
      clock.current += PHYSICS_STEP;
      sim.step(field, time, PHYSICS_STEP, 1);
      accumulated.current -= PHYSICS_STEP;
      stepped = true;
    }

    if (!stepped) return;

    const position = geometry.getAttribute('position');
    const alpha = geometry.getAttribute('aAlpha');
    const size = geometry.getAttribute('aSize');
    const motion = geometry.getAttribute('aMotion');

    sim.fillPointAttributes(alpha.array, size.array, motion.array);
    position.array.set(sim.positions);

    position.needsUpdate = true;
    alpha.needsUpdate = true;
    size.needsUpdate = true;
    motion.needsUpdate = true;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}

/** Stacked cloud shells that give the atmosphere a sense of depth. */
function MistShells({ cloudTexture, density, fieldSize }) {
  const shells = useMemo(
    () => [
      { radius: GLOBE_RADIUS * 1.008, opacity: 0.5, drift: 0.006, offset: 0 },
      { radius: GLOBE_RADIUS * 1.03, opacity: 0.34, drift: 0.0042, offset: 28 },
      { radius: GLOBE_RADIUS * 1.055, opacity: 0.2, drift: 0.0028, offset: 74 },
    ],
    []
  );

  const materials = useMemo(
    () =>
      shells.map(
        (shell) =>
          new THREE.ShaderMaterial({
            vertexShader: MIST_VERTEX,
            fragmentShader: MIST_FRAGMENT,
            uniforms: {
              uField: { value: cloudTexture },
              uFieldSize: { value: fieldSize },
              uTime: { value: 0 },
              uOffset: { value: shell.offset / 360 },
              uOpacity: { value: shell.opacity * density },
              uDrift: { value: shell.drift },
            },
            transparent: true,
            depthWrite: false,
            side: THREE.FrontSide,
            blending: THREE.AdditiveBlending,
          })
      ),
    [shells, cloudTexture]
  );

  useEffect(() => {
    materials.forEach((material, index) => {
      material.uniforms.uOpacity.value = shells[index].opacity * density;
      material.uniforms.uFieldSize.value = fieldSize;
      material.uniforms.uField.value = cloudTexture;
    });
  }, [materials, shells, density, fieldSize, cloudTexture]);

  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    materials.forEach((material) => {
      material.uniforms.uTime.value = t;
    });
  });

  return (
    <group>
      {shells.map((shell, index) => (
        <mesh key={shell.radius} scale={shell.radius}>
          <sphereGeometry args={[1, 64, 48]} />
          <primitive object={materials[index]} attach="material" />
        </mesh>
      ))}
    </group>
  );
}

/** Ocean / sea-surface-temperature shell, driven by generated texture data. */
function OceanShell({ seaTexture, opacity, showSea }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: GLOBE_VERTEX,
        fragmentShader: GLOBE_FRAGMENT,
        uniforms: {
          uSea: { value: seaTexture },
          uSeaOpacity: { value: opacity },
          uHasSea: { value: showSea ? 1 : 0 },
        },
      }),
    []
  );

  useEffect(() => {
    material.uniforms.uSea.value = seaTexture;
    material.uniforms.uSeaOpacity.value = opacity;
    material.uniforms.uHasSea.value = showSea ? 1 : 0;
  }, [material, seaTexture, opacity, showSea]);

  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh scale={GLOBE_RADIUS}>
      <sphereGeometry args={[1, 128, 96]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

function SelectionMarker({ location, weather, showReadout }) {
  const position = useMemo(
    () => latLonToVector3(location.latitude, location.longitude, SURFACE_RADIUS * 1.02),
    [location]
  );

  const windSpeed = weather?.current?.wind_speed_10m ?? 0;

  return (
    <group>
      <mesh position={position.toArray()}>
        <sphereGeometry args={[0.045, 24, 24]} />
        <meshBasicMaterial color="#fde68a" />
      </mesh>

      <mesh position={position.toArray()}>
        <sphereGeometry args={[0.09, 24, 24]} />
        <meshBasicMaterial color="#fbbf24" transparent opacity={0.28} />
      </mesh>

      {showReadout && (
        <Html position={position.toArray()} center zIndexRange={[30, 0]} distanceFactor={6.5}>
          <div className="marker-readout">
            <span className="marker-wind">{Math.round(windSpeed)} km/h</span>
            <span className="marker-temp">
              {Math.round(weather?.current?.temperature_2m ?? 0)}° · {location.name}
            </span>
          </div>
        </Html>
      )}
    </group>
  );
}

export default function GlobeScene({
  field,
  time,
  layers,
  rate,
  density,
  seaTexture,
  cloudTexture,
  autoRotate,
  location,
  weather,
}) {
  const { gl } = useThree();

  useEffect(() => {
    gl.setClearColor('#04070f', 1);
  }, [gl]);

  const fieldSize = useMemo(
    () => new THREE.Vector2(field?.lonCount ?? 1, field?.latCount ?? 1),
    [field]
  );

  return (
    <>
      <color attach="background" args={['#04070f']} />
      <fog attach="fog" args={['#04070f', 6, 13]} />

      <ambientLight intensity={1.1} />
      <directionalLight position={[5, 3, 5]} intensity={1.2} color="#dbeafe" />
      <directionalLight position={[-4, -2, -3]} intensity={0.35} color="#60a5fa" />

      <Stars radius={60} depth={34} count={4200} factor={3} saturation={0} fade speed={0.6} />

      <group>
        <OceanShell
          seaTexture={seaTexture}
          opacity={layers.sea ? 0.95 : 0}
          showSea={Boolean(layers.sea && seaTexture)}
        />

        {field && layers.wind && (
          <WindParticles
            field={field}
            time={time}
            rate={rate}
            count={layers.windDensity ?? 9000}
          />
        )}

        {field && layers.mist && (
          <MistShells cloudTexture={cloudTexture} density={density} fieldSize={fieldSize} />
        )}

        <SelectionMarker location={location} weather={weather} showReadout={layers.marker} />
      </group>

      <OrbitControls
        enableZoom
        minDistance={3.2}
        maxDistance={9}
        enablePan={false}
        autoRotate={autoRotate}
        autoRotateSpeed={0.35}
        rotateSpeed={0.6}
        dampingFactor={0.08}
      />
    </>
  );
}
