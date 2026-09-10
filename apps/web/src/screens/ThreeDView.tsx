// 3D tab: `RunBoardJobExport3D` (GLB) into the job output directory, loaded with three.js
// (GLTFLoader + OrbitControls). "Refresh" re-exports after edits. The mock services have no
// GLB, so the tab shows the job error instead.

import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useServices } from '@/services';
import type { JobRun } from '@/services/types';
import { log } from '@/state/logStore';

interface Viewer {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  model: THREE.Object3D | null;
  frame: number;
  dispose(): void;
}

function createViewer(el: HTMLDivElement): Viewer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(el.clientWidth || 800, el.clientHeight || 600);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b2733);
  const camera = new THREE.PerspectiveCamera(40, (el.clientWidth || 800) / (el.clientHeight || 600), 0.1, 10_000);
  camera.position.set(0, -180, 140);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(80, -120, 200);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-120, 80, -100);
  scene.add(fill);
  scene.add(new THREE.GridHelper(400, 40, 0x335577, 0x223344).rotateX(Math.PI / 2));
  const v: Viewer = {
    renderer,
    scene,
    camera,
    controls,
    model: null,
    frame: 0,
    dispose() {
      cancelAnimationFrame(v.frame);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
  const tick = () => {
    v.frame = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  };
  tick();
  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(el);
  const origDispose = v.dispose;
  v.dispose = () => {
    ro.disconnect();
    origDispose();
  };
  return v;
}

function fit(v: Viewer, obj: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.75 || 50;
  v.controls.target.copy(centre);
  v.camera.position.set(centre.x, centre.y - radius * 1.6, centre.z + radius * 1.4);
  v.camera.near = radius / 100;
  v.camera.far = radius * 50;
  v.camera.updateProjectionMatrix();
  v.controls.update();
}

export function ThreeDView() {
  const { jobs, session } = useServices();
  const ref = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: 'Exporting GLB…' });
  const [run, setRun] = useState<JobRun | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const load = useCallback(async (url: string) => {
    const v = viewer.current;
    if (!v) return;
    setStatus({ text: `Loading ${url.split('path=').pop()?.split('%2F').pop() ?? 'model'}…` });
    const gltf = await new GLTFLoader().loadAsync(url);
    if (v.model) v.scene.remove(v.model);
    const model = gltf.scene;
    // KiCad exports in millimetres with +Z up; glTF is +Y up, so lay the board flat.
    model.rotation.x = Math.PI / 2;
    let meshes = 0;
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    v.scene.add(model);
    v.model = model;
    fit(v, model);
    setStatus({ text: `${meshes} mesh${meshes === 1 ? '' : 'es'} · drag to orbit, wheel to zoom, right-drag to pan` });
  }, []);

  const refresh = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus({ text: 'RunBoardJobExport3D (GLB)…' });
    try {
      const r = await jobs.run('board.glb', { substituteModels: true, includeDnp: false });
      setRun(r);
      if (r.state !== 'done') throw new Error(r.error ?? 'export failed');
      const glb = r.outputs.find((o) => o.name.toLowerCase().endsWith('.glb'));
      if (!glb?.url) throw new Error(`no .glb in the job output (${r.outputs.map((o) => o.name).join(', ') || 'no files'})`);
      await load(glb.url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`3D view: ${msg}`, 'error');
      setStatus({ text: `3D export failed: ${msg}`, error: true });
    } finally {
      setBusy(false);
    }
  }, [busy, jobs, load]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      viewer.current = createViewer(el);
    } catch (e) {
      setStatus({ text: `WebGL unavailable: ${e instanceof Error ? e.message : String(e)}`, error: true });
      return;
    }
    if (!started.current) {
      started.current = true;
      void refresh();
    }
    return () => {
      viewer.current?.dispose();
      viewer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="three-view" data-testid="three-view">
      <div className="three-toolbar">
        <span>3D viewer</span>
        <span className="faint">{session.session?.projectName ? `${session.session.projectName}.kicad_pcb` : ''}</span>
        <span className="spacer" />
        {run && (
          <span className="faint" title={run.log.join('\n')}>
            {run.title}: {run.state}
            {run.finishedAt ? ` · ${((run.finishedAt - run.startedAt) / 1000).toFixed(1)} s` : ''}
          </span>
        )}
        <button className="btn sm" onClick={() => viewer.current?.model && fit(viewer.current, viewer.current.model)} disabled={!viewer.current?.model}>
          Fit
        </button>
        <button className="btn primary sm" onClick={() => void refresh()} disabled={busy} data-testid="three-refresh">
          {busy ? 'Exporting…' : 'Refresh (re-export GLB)'}
        </button>
      </div>
      <div className="three-canvas" ref={ref}>
        <div className={`three-status${status.error ? ' error' : ''}`} data-testid="three-status">
          {status.text}
        </div>
      </div>
    </div>
  );
}
