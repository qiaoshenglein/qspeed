import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LAYOUTS } from './layouts.js';
import { MAPS, MODES } from './maps.js';
import { Track } from './track.js';
import { buildSky, buildClouds, buildGround, buildWater, buildMountains, Batch, makeNoise } from './world.js';
import { buildProps, isFree } from './props.js';
import { buildCar, CAR_SKINS } from './carModel.js';
import { PlayerCar, TUNE, NO_INPUT } from '../shared/vehicle.js';
import { AICar, AI_NAMES } from '../shared/ai.js';
import { placeOnGrid, applyHit } from '../shared/race.js';
import { NetClient, PHASE } from './net/net.js';
import { NetItemView } from './net/itemView.js';
import { Particles, SkidMarks } from './effects.js';
import { GameAudio } from './audio.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { ItemSystem } from './items.js';
import { clamp, lerp, damp, dampAngle, wrapAngle, mulberry32, formatTime, smoothstep } from '../shared/util.js';
import { setMaxAniso } from './textures.js';

const $ = (id) => document.getElementById(id);
const STORE = 'feiche3d.v1';
const DIFFS = [
  { id: 0, name: '新手', skill: [0.55, 0.75], rubber: [0.88, 1.03] },
  { id: 1, name: '熟练', skill: [0.85, 1.05], rubber: [0.93, 1.06] },
  { id: 2, name: '车神', skill: [1.2, 1.38], rubber: [0.97, 1.1] },
];
const QUALITY = [
  { id: 'low', name: '流畅' },
  { id: 'mid', name: '均衡' },
  { id: 'high', name: '极致' },
];
const LAPS = [1, 2, 3, 5];
const IS_TOUCH = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const DT = 1 / 120;

// ---------- 地形基准函数 ----------
function baseFor(id, noise, track, oases) {
  const { cx, cz } = track.bounds;
  if (id === 'city')
    return (x, z) => {
      const r = Math.abs(z);
      const river = r < 44 ? -6 : r < 64 ? lerp(-6, 0, smoothstep(44, 64, r)) : 0;
      return river + Math.max(0, Math.hypot(x - cx, z - cz) - 950) * 0.12;
    };
  if (id === 'aegean')
    return (x, z) => {
      const land = Math.pow(clamp((z + 195) / 420, 0, 1), 0.8) * 16 + noise.fbm(x * 0.008, z * 0.008) * 5 + Math.max(0, Math.hypot(x - cx, z - cz) - 900) * 0.1;
      return lerp(land, -14, smoothstep(-200, -262, z));
    };
  if (id === 'egypt')
    return (x, z) => {
      let h = 2 + noise.fbm(x * 0.0045, z * 0.0045, 4) * 18 + Math.max(0, Math.hypot(x - cx, z - cz) - 900) * 0.1;
      for (const [ox, oz, r] of oases) {
        const d = Math.hypot(x - ox, z - oz);
        if (d < r + 25) h = lerp(-2.6, h, smoothstep(r - 6, r + 25, d));
      }
      return h;
    };
  if (id === 'sunset')
    return (x, z) => {
      // 海岸台地 + 东北侧一个椭圆海湾：观海大桥（路面 9~10m）从水面上方跨过
      const ex = (x - 40) / 460, ez = (z - 330) / 300;
      const bay = clamp(1 - Math.hypot(ex, ez), 0, 1);
      const terrace = 0.8 + noise.fbm(x * 0.006, z * 0.006, 4) * 5;
      return lerp(terrace, -7, smoothstep(0.1, 0.75, bay));
    };
  if (id === 'neon')
    return (x, z) => {
      // 山体随盘山路线一起抬升：谷底 0m，山脊约 45m，东侧缓降回谷
      const rise = 45 * smoothstep(-220, 340, z) + noise.fbm(x * 0.007, z * 0.007, 4) * 5;
      const eastFall = Math.max(0, x - 300) * -0.02;
      return rise + eastFall;
    };
  return (x, z) => 3 + noise.fbm(x * 0.004, z * 0.004, 4) * 26 + Math.max(0, Math.hypot(x - cx, z - cz) - 650) * 0.18;
}

function tintFor(id, noise) {
  return (x, z, h, col) => {
    const n = noise(x * 0.02, z * 0.02);
    if (id === 'city') {
      if (h < -0.8) col.setRGB(1.25, 1.1, 0.8);
      else col.setRGB(0.88 + n * 0.2, 0.97 + n * 0.08, 0.86);
    } else if (id === 'aegean') {
      if (h < -0.5) col.setRGB(1.35, 1.25, 1.0);
      else { const r = clamp(0.5 + n * 1.2, 0, 1); col.setRGB(lerp(0.85, 1.2, r), lerp(1.0, 1.05, r), lerp(0.75, 1.0, r)); }
    } else if (id === 'egypt') {
      if (h < -1) col.setRGB(0.6, 0.85, 0.45);
      else col.setRGB(1 + n * 0.1, 0.97 + n * 0.08, 0.92);
    } else if (id === 'sunset') {
      if (h < -0.6) col.setRGB(1.3, 1.2, 0.95); // 水下的沙
      else { const r = clamp((h - 0.6) / 4, 0, 1); col.setRGB(1.2 - r * 0.3, 1.05 - r * 0.2, 0.8 + r * 0.1); }
    } else if (id === 'neon') {
      col.setRGB(0.42 + n * 0.16, 0.46 + n * 0.16, 0.6 + n * 0.2); // 夜里的岩壁偏冷蓝
    } else col.setRGB(0.92 + n * 0.06, 0.96 + n * 0.04, 1.0);
  };
}

const MOUNTAINS = {
  city: { color: 0x6f95b8, r0: 1600, r1: 500, h0: 140, h1: 200 },
  aegean: { color: 0x9c9a74, r0: 1500, r1: 500, h0: 140, h1: 220 },
  egypt: { color: 0xd9ae72, r0: 1500, r1: 600, h0: 50, h1: 90, count: 40 },
  snow: { color: 0x6f8fb8, cap: 0xf2f7ff, r0: 1400, r1: 500, h0: 240, h1: 300 },
  sunset: { color: 0x9a6f86, r0: 1500, r1: 520, h0: 120, h1: 190, count: 34 },
  neon: { color: 0x2b3556, cap: 0x9fb0d8, r0: 1300, r1: 460, h0: 260, h1: 340 },
};

class Game {
  constructor() {
    this.settings = Object.assign({ map: 'city', mode: 'speed', skin: 0, laps: 2, diff: 1, quality: IS_TOUCH ? 'mid' : 'high', song: 0, nick: '' }, this.load());
    if (!LAPS.includes(this.settings.laps)) this.settings.laps = 3;
    this.canvas = $('gl');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    setMaxAniso(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.3, 9000);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.28;

    this.audio = new GameAudio();
    this.input = new Input();
    this.hud = new HUD();
    this.fx = this.makeFx();
    this.scene.add(this.fx.smoke.points, this.fx.glow.points, this.fx.skids.mesh);
    this.state = 'menu';
    this.time = 0;
    this.camMode = 0;
    this.shake = 0;
    this.camPos = new THREE.Vector3(0, 50, 0);
    this.camLook = new THREE.Vector3();
    this.camYaw = 0;
    this.fovK = 68;
    this.acc = 0;
    this.racers = [];
    this.input.onKey = (code) => this.onKey(code);
    if (IS_TOUCH) {
      document.body.classList.add('touch');
      this.input.bindTouch($('touch'));
    }
    this.setupQuality();
    this.buildMenu();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    const unlock = () => {
      this.audio.init();
      if (!this.audio.playing) this.audio.startMusic();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    // Ctrl+W 在浏览器里是关闭标签页：比赛中拦一道确认，避免双喷时误触
    window.addEventListener('beforeunload', (e) => {
      if (this.state === 'race' || this.state === 'countdown' || this.state === 'paused') {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    this.loadMap(this.settings.map).then(() => {
      this.startDemo();
      this.last = performance.now();
      requestAnimationFrame(() => this.loop());
    });
  }

  load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } }
  save() { try { localStorage.setItem(STORE, JSON.stringify(this.settings)); } catch { /* 忽略 */ } }

  setupQuality() {
    const q = this.settings.quality;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(q === 'high' ? Math.min(dpr, 2) : q === 'mid' ? Math.min(dpr, 1.5) : 1);
    this.renderer.shadowMap.enabled = q !== 'low';
    if (this.sun) {
      this.sun.castShadow = q !== 'low';
      const ms = q === 'high' ? 2048 : 1024;
      if (this.sun.shadow.mapSize.x !== ms) {
        this.sun.shadow.mapSize.set(ms, ms);
        if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      }
    }
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      this.composer = null;
      this.bloom = null;
    }
    if (q === 'low') return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: q === 'high' ? 4 : 0 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.7, 0.5, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    const ph = h * this.renderer.getPixelRatio();
    this.fx.smoke.setScale(ph);
    this.fx.glow.setScale(ph);
  }

  // ---------- 菜单 ----------
  buildMenu() {
    const S = this.settings;
    const mapsEl = $('maps');
    mapsEl.innerHTML = MAPS.map((m) => `<div class="map" data-id="${m.id}"><div class="nm">${m.name}</div><div class="en">${m.en}</div><div class="tg">${m.tag}</div></div>`).join('');
    const opts = (el, list, key, label, sub) => {
      el.innerHTML = list.map((it, i) => `<div class="opt" data-i="${i}">${label(it)}${sub ? `<small>${sub(it)}</small>` : ''}</div>`).join('');
    };
    opts($('modes'), MODES, 'mode', (m) => m.name, (m) => m.desc);
    opts($('laps'), LAPS, 'laps', (l) => `${l} 圈`);
    opts($('diff'), DIFFS, 'diff', (d) => d.name);
    opts($('quality'), QUALITY, 'quality', (q) => q.name);
    $('skins').innerHTML = CAR_SKINS.map((s, i) => `<div class="skin" data-i="${i}" title="${s.name}" style="background:linear-gradient(135deg,#${s.body.toString(16).padStart(6, '0')} 55%,#${s.accent.toString(16).padStart(6, '0')} 56%)"></div>`).join('');
    const refresh = () => {
      mapsEl.querySelectorAll('.map').forEach((e) => e.classList.toggle('sel', e.dataset.id === S.map));
      $('modes').querySelectorAll('.opt').forEach((e) => e.classList.toggle('sel', MODES[e.dataset.i].id === S.mode));
      $('laps').querySelectorAll('.opt').forEach((e) => e.classList.toggle('sel', LAPS[e.dataset.i] === S.laps));
      $('diff').querySelectorAll('.opt').forEach((e) => e.classList.toggle('sel', +e.dataset.i === S.diff));
      $('quality').querySelectorAll('.opt').forEach((e) => e.classList.toggle('sel', QUALITY[e.dataset.i].id === S.quality));
      $('skins').querySelectorAll('.skin').forEach((e) => e.classList.toggle('sel', +e.dataset.i === S.skin));
      $('skinname').textContent = CAR_SKINS[S.skin].name;
      this.save();
    };
    mapsEl.addEventListener('click', (e) => {
      const m = e.target.closest('.map');
      if (!m || m.dataset.id === S.map || this.loading) return;
      S.map = m.dataset.id;
      refresh();
      this.audio.play('click');
      this.loadMap(S.map).then(() => this.startDemo());
    });
    const bind = (id, fn) => $(id).addEventListener('click', (e) => {
      const o = e.target.closest('.opt,.skin');
      if (!o) return;
      fn(+o.dataset.i);
      refresh();
      this.audio.play('click');
    });
    bind('modes', (i) => (S.mode = MODES[i].id));
    bind('laps', (i) => (S.laps = LAPS[i]));
    bind('diff', (i) => (S.diff = i));
    bind('quality', (i) => { S.quality = QUALITY[i].id; this.setupQuality(); });
    bind('skins', (i) => { S.skin = i; if (this.state === 'menu') this.startDemo(); });
    $('start').addEventListener('click', () => this.startRace());
    $('resume').addEventListener('click', () => this.togglePause());
    $('restart').addEventListener('click', () => { $('pause').classList.add('hidden'); this.startRace(); });
    $('quit').addEventListener('click', () => this.toMenu());
    $('again').addEventListener('click', () => { if (this.net) this.net.ready(true); else this.startRace(); });
    $('back').addEventListener('click', () => (this.net ? this.leaveOnline() : this.toMenu()));
    $('online').addEventListener('click', () => this.showLobby());
    $('joingame').addEventListener('click', () => this.joinOnline($('code').value));
    $('createroom').addEventListener('click', () => this.joinOnline('', { create: true }));
    $('refreshrooms').addEventListener('click', () => this.refreshRooms());
    const cmap = $('cmap');
    cmap.innerHTML = MAPS.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
    cmap.value = S.map;
    $('claps').value = String(S.laps || 2);
    $('cmode').value = S.mode || 'speed';
    for (const [id, key] of [['cmap', 'map'], ['claps', 'laps'], ['cmode', 'mode']]) {
      $(id).addEventListener('change', () => {
        S[key] = id === 'claps' ? Number($(id).value) : $(id).value;
        this.save();
      });
    }
    $('pname').value = S.nick || '';
    $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.joinOnline($('code').value); e.stopPropagation(); });
    $('readybtn').addEventListener('click', () => {
      this.netReady = !this.netReady;
      $('readybtn').textContent = this.netReady ? '取消准备' : '准备';
      this.net.ready(this.netReady);
      this.audio.play('click');
    });
    $('leavebtn').addEventListener('click', () => this.leaveOnline());
    $('copylink').addEventListener('click', () => {
      const url = location.origin + location.pathname + '#room=' + $('roomcode').textContent;
      navigator.clipboard?.writeText(url).then(() => { $('copylink').textContent = '已复制'; setTimeout(() => ($('copylink').textContent = '复制链接'), 1500); });
    });
    const m = /#room=(\w{4})/.exec(location.hash || '');
    if (m) $('code').value = m[1].toUpperCase();
    refresh();
  }

  toMenu() {
    ['pause', 'result'].forEach((i) => $(i).classList.add('hidden'));
    $('menu').classList.remove('hidden');
    $('touch').classList.add('hidden');
    this.hud.show(false);
    this.hud.countdown('');
    this.startDemo();
  }

  onKey(code) {
    if (code === 'Escape' || code === 'KeyP') {
      if (this.net) return; // 联机不能暂停别人
      if (this.state === 'race' || this.state === 'countdown' || this.state === 'paused') this.togglePause();
    } else if (code === 'KeyC') this.camMode = (this.camMode + 1) % 3;
    else if (code === 'KeyH') this.hud.toggleKeys();
    else if (code === 'KeyM') this.hud.song(this.audio.toggleMusic() ? '音乐：开' : '音乐：关');
    else if (code === 'PageUp' || code === 'PageDown') {
      this.settings.song = (this.settings.song ?? 0) + (code === 'PageUp' ? -1 : 1);
      this.hud.song(this.audio.setSong(this.settings.song));
    } else if (code === 'Enter' && this.state === 'menu' && !$('menu').classList.contains('hidden')) this.startRace();
  }

  togglePause() {
    if (this.state === 'paused') {
      this.state = this.pausedFrom;
      $('pause').classList.add('hidden');
      this.last = performance.now();
    } else {
      this.pausedFrom = this.state;
      this.state = 'paused';
      $('pause').classList.remove('hidden');
      this.audio.silence();
    }
  }

  // ---------- 关卡 ----------
  async loadMap(id) {
    this.loading = true;
    $('loading').classList.remove('hidden');
    $('loadtxt').textContent = `正在生成赛道：${MAPS.find((m) => m.id === id).name}…`;
    await new Promise((r) => setTimeout(r, 30));
    if (this.level) this.disposeLevel();
    const map = MAPS.find((m) => m.id === id);
    this.map = map;
    const root = new THREE.Group();
    const rnd = mulberry32(id.length * 997 + 13);
    const track = new Track(LAYOUTS[map.layout], { isBridge: map.isBridge, grip: map.physics ? map.physics.grip : 1 });
    const noise = makeNoise(id.charCodeAt(0) * 31 + 7);
    let oases = [];
    if (id === 'egypt') oases = [[-110, -60, 22], [200, -330, 24], [-120, 320, 20], [140, 200, 18], [-300, 60, 24]].filter(([x, z, r]) => isFree(track, x, z, r + 14));
    const flatR = track.halfW + (map.track.shoulder ? map.track.shoulder.width + 2.5 : 3.5);
    const ground = buildGround(track, { base: baseFor(id, noise, track, oases), flatR, texture: map.ground, colorAt: tintFor(id, noise), repeat: id === 'snow' ? 30 : 22 });
    root.add(ground.mesh);
    root.add(track.build(map.track, ground.heightAt));

    // 天空、雾、光
    const { sky, sunDir } = buildSky(map.sky);
    this.skyMesh = sky;
    root.add(sky);
    root.add(buildClouds(rnd, { x: track.bounds.cx, z: track.bounds.cz }, 30, map.cloudTint ?? 0xffffff));
    this.scene.fog = new THREE.Fog(map.fog[0], map.fog[1], map.fog[2]);
    this.scene.background = new THREE.Color(map.sky.horizon);
    const hemi = new THREE.HemisphereLight(map.hemi[0], map.hemi[1], map.hemi[2] * 0.62);
    root.add(hemi);
    const sun = new THREE.DirectionalLight(map.sky.sunColor, map.sky.sunI * 0.82);
    sun.castShadow = this.settings.quality !== 'low';
    const ms = this.settings.quality === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(ms, ms);
    const sc = sun.shadow.camera;
    sc.left = -75; sc.right = 75; sc.top = 75; sc.bottom = -75; sc.near = 1; sc.far = 500;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    root.add(sun, sun.target);
    this.sun = sun;
    this.sunDir = sunDir;
    if (map.water) {
      const water = buildWater(map.water, sunDir, map.sky.horizon, { x: track.bounds.cx, z: track.bounds.cz }, map.water.local ? 60 : 7000);
      if (map.water.local) {
        this.waters = oases.map(([x, z, r]) => {
          const w = water.clone();
          w.material = water.material;
          w.scale.setScalar((r + 12) / 30);
          w.position.set(x, map.water.y, z);
          root.add(w);
          return w;
        });
      } else {
        root.add(water);
        this.waters = [water];
      }
    } else this.waters = [];
    root.add(buildMountains(rnd, { x: track.bounds.cx, z: track.bounds.cz }, MOUNTAINS[id]));

    const ctx = { track, batch: new Batch(), rnd, groundAt: ground.heightAt, parent: root, updaters: [], quality: this.settings.quality, oases };
    this.gate = buildProps(id, ctx);
    ctx.batch.build(root);
    this.updaters = ctx.updaters;
    this.scene.add(root);
    this.level = root;
    this.track = track;
    this.groundAt = ground.heightAt;
    this.hud.setupMinimap(track);
    this.fx.skids.clear();
    this.audio.setSong(map.bgm);
    this.settings.song = map.bgm;
    try { this.renderer.compile(this.scene, this.camera); } catch { /* 忽略 */ }
    $('loading').classList.add('hidden');
    this.loading = false;
  }

  disposeLevel() {
    this.clearRacers();
    if (this.items) { this.items.dispose(); this.items = null; }
    this.level.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.scene.remove(this.level);
    this.level = null;
  }

  clearRacers() {
    for (const r of this.racers) {
      this.scene.remove(r.model);
      r.model.traverse((o) => {
        if (o.material && !o.isSprite) o.material.dispose();
      });
    }
    this.racers = [];
    this.player = null;
  }

  makeRacers(withPlayer) {
    this.clearRacers();
    const S = this.settings;
    const rnd = mulberry32((Date.now() & 0xffff) + 7);
    const diff = DIFFS[S.diff];
    const skins = CAR_SKINS.map((s, i) => i).filter((i) => i !== S.skin);
    for (let i = skins.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [skins[i], skins[j]] = [skins[j], skins[i]]; }
    const names = [...AI_NAMES];
    for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
    const total = 6;
    const playerSlot = withPlayer ? 3 : -1;
    let ai = 0;
    for (let k = 0; k < total; k++) {
      const d = -14 - Math.floor(k / 2) * 11;
      const lat = (k % 2 ? 1 : -1) * 5.5;
      let r;
      if (k === playerSlot) {
        const model = buildCar(CAR_SKINS[S.skin], { isPlayer: true });
        r = new PlayerCar(this.track, model, '我');
        r.reset(d, lat);
      } else {
        const skin = CAR_SKINS[withPlayer ? skins[ai % skins.length] : (k + S.skin) % CAR_SKINS.length];
        const model = buildCar(skin, { name: names[ai % names.length] });
        const skill = lerp(diff.skill[0], diff.skill[1], withPlayer ? rnd() : 0.8 + rnd() * 0.2);
        r = new AICar(this.track, model, names[ai % names.length], skill, rnd);
        r.reset(d, lat);
        ai++;
      }
      r.slot = k;
      r.lapTimes = [];
      r.items = [];
      r.itemTimer = 2 + rnd() * 2;
      r.finished = false;
      r.finishTime = 0;
      r.stats = { drift: 0, small: 0, perfect: 0, double: 0, nitro: 0, crash: 0, top: 0, land: 0 };
      if (r.isPlayer) {
        r.lapsDone = -1;
        r.owed = true;
        r.half = false;
        r.lastD = r.d;
        this.player = r;
      }
      this.scene.add(r.model);
      this.racers.push(r);
    }
    for (const r of this.racers) this.updateProgress(r, true);
    this.standings = [...this.racers];
  }

  startDemo() {
    if (!this.track) return;
    this.state = 'menu';
    this.makeRacers(false);
    this.raceTime = 0;
    this.demoTarget = 0;
    this.demoT = 0;
    if (this.items) { this.items.dispose(); this.items = null; }
  }

  startRace() {
    if (this.loading) return;
    this.audio.init();
    ['menu', 'pause', 'result'].forEach((i) => $(i).classList.add('hidden'));
    this.itemMode = this.settings.mode === 'item';
    this.makeRacers(true);
    if (this.items) this.items.dispose();
    this.items = this.itemMode ? new ItemSystem(this.scene, this.track, this, mulberry32(Date.now() & 0xffff)) : null;
    this.hud.setItemMode(this.itemMode);
    this.hud.show(true);
    $('touch').classList.toggle('hidden', !IS_TOUCH);
    this.fx.skids.clear();
    this.state = 'countdown';
    this.cdT = 0;
    this.cdShown = -1;
    this.raceTime = 0;
    this.firstFinish = -1;
    this.startBoostReady = false;
    this.startTried = false;
    this.resultShown = false;
    this.camYaw = this.player.h;
    this.snapCamera();
    this.audio.setSong(this.settings.song ?? this.map.bgm);
    this.audio.startMusic();
    this.gate?.set(0);
    this.last = performance.now();
    $('keys').classList.remove('hidden');
    clearTimeout(this.keysT);
    this.keysT = setTimeout(() => $('keys').classList.add('hidden'), 18000);
  }

  // ---------- 在线对战 ----------
  showLobby() {
    ['menu', 'pause', 'result'].forEach((i) => $(i).classList.add('hidden'));
    $('lobby').classList.remove('hidden');
    $('touch').classList.add('hidden');
    $('keys').classList.add('hidden');
    $('lobby-browse').classList.remove('hidden');
    $('room').classList.add('hidden');
    this.hud.show(false);
    this.refreshRooms();
    clearInterval(this.roomsT);
    this.roomsT = setInterval(() => {
      if (!$('lobby').classList.contains('hidden') && !this.net) this.refreshRooms();
    }, 4000);
    if (!this.net) this.startDemo();
  }

  hideLobbyBrowser() {
    clearInterval(this.roomsT);
    $('lobby-browse').classList.add('hidden');
  }

  async refreshRooms() {
    try {
      const res = await fetch('/rooms', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      this.renderRooms((await res.json()).rooms || []);
    } catch {
      $('roomlist').innerHTML = '<div class="tip">房间列表暂时打不开，输入房间码仍然可以进入。</div>';
    }
  }

  renderRooms(list) {
    const el = $('roomlist');
    if (!list.length) {
      el.innerHTML = '<div class="tip">还没有人开房间。选好转速赛还是道具赛，点“创建房间”当第一个车主。</div>';
      return;
    }
    const label = (r) => (r.phase !== 0 ? '比赛中' : r.players >= r.cap ? '已满' : '');
    el.innerHTML = list.map((r) => {
      const joinable = r.listed;
      return `<div class="rm${joinable ? '' : ' busy'}"><b>${r.code}</b>` +
        `<span class="meta">${r.mapName} · ${r.laps} 圈 · ${r.mode === 1 ? '道具赛' : '竞速赛'}</span>` +
        `<span class="num">${r.players}/${r.cap}</span>` +
        (joinable ? `<button data-code="${r.code}" data-map="${r.map}" data-laps="${r.laps}" data-mode="${r.mode}">加入</button>` : `<span class="meta">${label(r)}</span>`) +
        '</div>';
    }).join('');
    for (const b of el.querySelectorAll('button[data-code]')) {
      b.addEventListener('click', () => {
        // 列表加入要对齐房主的设置，否则服务器会以"设置不符"拒绝
        const S = this.settings;
        S.map = b.dataset.map;
        S.laps = Number(b.dataset.laps);
        S.mode = b.dataset.mode === '1' ? 'item' : 'speed';
        this.save();
        $('cmap').value = S.map;
        $('claps').value = String(S.laps);
        $('cmode').value = S.mode;
        this.joinOnline(b.dataset.code);
      });
    }
  }

  async joinOnline(code, opts = {}) {
    if (this.loading) return;
    const S = this.settings;
    const nick = (($('pname') && $('pname').value) || '').trim().slice(0, 10) || `车手${100 + Math.floor(Math.random() * 899)}`;
    S.nick = nick;
    this.save();
    $('neterr').textContent = '';
    await this.loadMap(S.map);
    this.clearRacers();
    if (this.items) { this.items.dispose(); this.items = null; }
    this.itemMode = S.mode === 'item';
    const model = buildCar(CAR_SKINS[S.skin], { isPlayer: true });
    const car = new PlayerCar(this.track, model, nick);
    placeOnGrid(car, 0);
    this.scene.add(model);
    this.player = car;
    this.racers = [car];
    this.standings = [car];
    this.state = 'menu';
    this.netStatsT = 0;
    this.netLapStart = 0;
    this.hideLobbyBrowser();
    this.net = new NetClient({
      name: nick, skin: S.skin, map: S.map, laps: S.laps, mode: this.itemMode ? 1 : 0, diff: S.diff, itemMode: this.itemMode,
      code: (code || '').trim(), track: this.track, ownCar: car, scene: this.scene,
      create: !!opts.create, token: opts.create ? '' : (S.tokens || {})[(code || '').toUpperCase()] || '',
      onWelcome: (info) => this.onNetWelcome(info),
      onRoster: (list) => this.renderRoster(list),
      onPhase: (p) => this.onNetPhase(p),
      onEvent: (ev) => this.onNetEvent(ev),
      onResult: (rows) => this.showOnlineResults(rows),
      onError: (msg) => this.onNetError(msg),
      onReconnect: (n) => { $('neterr').textContent = `连接中断，正在自动回线（第 ${n} 次）…`; },
    });
    $('room').classList.add('hidden');
    this.hud.show(false);
    this.hud.setItemMode(this.itemMode);
    if (this.itemMode && !this.netItems) this.netItems = new NetItemView(this.scene, this.track);
    $('loading').classList.add('hidden');
  }

  onNetWelcome(info) {
    if (info.token) {
      const t = this.settings.tokens || (this.settings.tokens = {});
      t[info.code] = info.token;
      this.save();
    }
    $('neterr').textContent = info.rejoined ? '已重新接入房间，继续原来的车位。' : '';
    $('roomcode').textContent = info.code;
    const map = MAPS.find((m) => m.id === info.mapId);
    $('roommap').textContent = map ? map.name : info.mapId;
    $('roomlaps').textContent = `${info.laps} 圈 · ${info.mode === 1 ? '道具赛' : '竞速赛'}`;
    this.netReady = false;
    $('readybtn').textContent = '准备';
    if (info.phase === PHASE.countdown || info.phase === PHASE.race) {
      // 比赛中回线：不进大厅，直接接回赛况，位置由第一帧快照对齐
      ['lobby', 'result'].forEach((i) => $(i).classList.add('hidden'));
      this.hud.show(true);
      this.state = info.phase === PHASE.race ? 'race' : 'countdown';
      return;
    }
    $('room').classList.remove('hidden');
  }

  onNetError(msg) {
    $('neterr').textContent = msg || '连接异常';
    const n = this.net;
    // 还没收到任何赛况就被拒（满员/设置不符/版本不符）：退回列表，不把人卡在空房间里
    if (n && !n.snapCount && n.phase < PHASE.countdown) {
      n.dispose();
      this.net = null;
      if (this.netItems) { this.netItems.dispose(); this.netItems = null; }
      $('room').classList.add('hidden');
      $('lobby-browse').classList.remove('hidden');
      this.refreshRooms();
    }
  }

  renderRoster(list) {
    const el = $('players');
    el.innerHTML = list.map((p) => {
      const color = p.skin >= 0 && CAR_SKINS[p.skin] ? '#' + CAR_SKINS[p.skin].body.toString(16).padStart(6, '0') : '#8aa0c0';
      const st = p.bot ? '电脑' : p.ready ? '已准备' : p.online ? '等待' : '掉线';
      return `<div class="pl ${p.carId === this.net?.myCarId ? 'me' : ''}"><i class="dot" style="background:${color}"></i>${p.name}${p.bot ? '' : ''}<span class="st ${p.ready ? 'rdy' : ''}">${st}</span></div>`;
    }).join('');
    this.netRoster = list;
  }

  onNetPhase(p) {
    if (p === PHASE.lobby) {
      this.state = 'menu';
      this.hud.show(false);
      $('result').classList.add('hidden');
      $('lobby').classList.remove('hidden');
      this.placeOnGridLocal();
      return;
    }
    if (p === PHASE.countdown) {
      ['lobby', 'result'].forEach((i) => $(i).classList.add('hidden'));
      this.hud.show(true);
      this.hud.setItemMode(this.itemMode);
      $('touch').classList.toggle('hidden', !IS_TOUCH);
      this.fx.skids.clear();
      this.state = 'countdown';
      this.placeOnGridLocal();
      this.camYaw = this.player.h;
      this.snapCamera();
      this.audio.startMusic();
      return;
    }
    if (p === PHASE.race) {
      this.state = 'race';
      this.hud.countdown('');
    }
  }

  placeOnGridLocal() {
    const net = this.net;
    const me = net && net.rosterFor(net.myCarId);
    if (!me) return;
    placeOnGrid(this.player, me.slot);
    this.player.lapVis = 0;
    this.player.events.length = 0;
    this.netLapStart = 0;
    this.raceTime = 0;
    this.resultShown = false;
    net.tick = 0; // 服务器开赛时把世界 tick 归零，两端同时起算
    net.hist.fill(null);
    net.pending.length = 0;
  }

  onNetEvent(ev) {
    const net = this.net;
    if (!net) return;
    const mine = ev.carId === net.myCarId;
    const car = mine ? this.player : net.remote.get(ev.carId);
    switch (ev.type) {
      case 'cd': this.hud.countdown(ev.n === 0 ? 'GO!' : String(ev.n)); this.audio.play(ev.n === 0 ? 'go' : 'count'); this.gate?.set(ev.n === 0 ? 4 : 3 - ev.n); break;
      case 'go': this.hud.countdown(''); break;
      case 'bump': {
        const d = Math.hypot(ev.x - this.player.x, ev.z - this.player.z);
        if (d < 120) { this.audio.play('crash', Math.min(1, 0.4 + ev.p / 20)); this.fx.sparks(ev.x, ev.y + 0.6, ev.z, 10); if (d < 22) this.shake = Math.max(this.shake, 0.3); }
        break;
      }
      case 'firstFinish': this.hud.message('有人冲线了！剩余 10 秒', '#ff5fa8'); break;
      case 'bumpHit': {
        // 被撞的一方：震屏幅度按冲量给，但刻意压低（剧烈晃屏会让人头晕）
        const k = Math.min(0.3, (ev.p || 0) * 0.02);
        this.shake = Math.max(this.shake, k);
        this.audio.play('crash', Math.min(1, 0.35 + (ev.p || 0) / 24));
        this.fx.sparks(ev.x, ev.y, ev.z, Math.min(14, 4 + Math.round((ev.p || 0) * 1.2)));
        break;
      }
      case 'itemGet': {
        const bx = this.netItems && this.netItems.boxPos(ev.box);
        const near = bx ? Math.hypot(this.player.x - bx.x, this.player.z - bx.z) : 1e9;
        this.audio.play('item');
        if (bx && near < 160) this.fx.burst(bx.x, bx.y, bx.z, 0x55c8ff);
        break;
      }
      case 'itemUse': {
        const who = car && !mine ? car : null;
        if (ev.kind === 'missile' && who) this.fx.trail(who.x, who.y + 1.5, who.z);
        break;
      }
      case 'missileLock':
        if (ev.who === net.myCarId) { this.missileWarn = 1.6; this.audio.play('wrong'); }
        break;
      case 'missiled':
        if (mine) {
          this.hud.message('被导弹击中!', '#ff4b4b'); this.hud.flash();
          this.shake = Math.max(this.shake, 0.3); this.audio.play('boom');
          net.selfHit('missile'); // 冲击只存在于服务器，本端不补就会永远跑在前面
        } else if (car) this.fx.explode(car.x, car.y + 1, car.z);
        break;
      case 'banana':
        if (mine) {
          this.hud.message('踩到香蕉皮!', '#ff4b4b');
          this.shake = Math.max(this.shake, 0.26); this.audio.play('banana');
          net.selfHit('banana');
        }
        break;
      case 'shieldHit':
        if (mine) this.hud.message('天使护体!', '#ffe28a', true);
        break;
      case 'finish': if (car && !mine) this.hud.message(`${car.name || net.rosterFor(ev.carId)?.name} 完成比赛`, '#ffd23a', true); break;
      default: break;
    }
  }

  showOnlineResults(rows) {
    this.state = 'finish';
    this.resultShown = true;
    this.hud.show(false);
    this.hud.finalCount('');
    $('touch').classList.add('hidden');
    const byId = new Map(rows.map((r) => [r.carId, r]));
    const me = byId.get(this.net.myCarId);
    const place = this.net.lastSnap ? this.net.lastSnap.racers.findIndex((x) => x.carId === this.net.myCarId) + 1 : 0;
    const finished = me && me.finished;
    $('resTitle').textContent = !finished ? '未完成比赛' : place === 1 ? '冠军！' : `第 ${place} 名`;
    $('resTitle').classList.toggle('win', finished && place === 1);
    const st = (me && me.stats) || {};
    $('resStats').innerHTML = [
      ['漂移', st.drift], ['小喷', st.small], ['完美小喷', st.perfect], ['双喷', st.double], ['氮气', st.nitro],
      ['最高时速', Math.round(st.top || 0) + ''], ['碰撞', st.crash], ['延迟', Math.round(this.net.rtt) + 'ms'],
    ].map(([k, v]) => `<div class="stat"><b>${v}</b>${k}</div>`).join('');
    $('resBody').innerHTML = rows.map((r, i) => {
      const info = this.net.rosterFor(r.carId);
      const total = r.finished ? formatTime(r.time) : `未完成 (${Math.floor(Math.max(0, Math.min(99, (r.laps / this.net.laps) * 100)))}%)`;
      return `<tr class="${r.carId === this.net.myCarId ? 'me' : ''}"><td class="pos">${i + 1}</td><td>${info ? info.name : '车手'}</td><td>${total}</td><td>${formatTime(r.best)}</td></tr>`;
    }).join('');
    setTimeout(() => $('result').classList.remove('hidden'), 400);
  }

  leaveOnline() {
    const net = this.net;
    if (net) {
      const code = (net.code || '').toUpperCase();
      net.leave(); // 主动退房：把席位还回去，不占用别人的车位
      net.dispose();
      if (code && this.settings.tokens) { delete this.settings.tokens[code]; this.save(); }
      this.net = null;
    }
    if (this.netItems) { this.netItems.dispose(); this.netItems = null; }
    this.itemMode = this.settings.mode === 'item';
    this.netRoster = null;
    $('lobby').classList.add('hidden');
    $('room').classList.add('hidden');
    clearInterval(this.roomsT);
    $('result').classList.add('hidden');
    $('menu').classList.remove('hidden');
    this.state = 'menu';
    this.startDemo();
  }

  stepOnline(dt, inp) {
    const net = this.net;
    const P = net.me;
    const phase = net.phase;
    const racing = phase === PHASE.countdown || phase === PHASE.race;
    let pin = inp;
    if (IS_TOUCH && phase === PHASE.race) this.input.touch.up = true;
    if (IS_TOUCH && phase !== PHASE.race) this.input.touch.up = false;
    if (P.finished) pin = this.autopilot(P);

    net.step(dt * 1000, pin, racing && !P.finished);
    // 表现层用较小的 dt，避免低帧率时相机与特效一次跳太远
    const vdt = Math.min(0.05, dt);
    net.syncOwn(vdt);

    const snap = net.lastSnap;
    if (snap) {
      if (net.resync) {
        // 回线/被权威冲击后本地预测作废：摆回权威位置，差值由视觉偏移滑形吸收
        const rec = snap.racers.find((x) => x.carId === net.myCarId);
        if (rec) { net.restoreAuthoritative(rec); net.resync = false; net.syncPose(vdt); }
      }
      if (net.hardSnap) {
        // 本端整段时间没过帧（切后台/挂起/弱机 1fps）：位姿偏差是几十米量级，
        // 滑行会让镜头以几十米每秒横扫赛道，那才是最直接的 3D 眩晕诱因。
        // 这里一次性把车与相机同时摆到位——一次干净的剪辑，好过一段横扫。
        net.hardSnap = false;
        this.camYaw = this.player.rh ?? this.player.h;
        this.snapCamera();
      }
      this.raceTime = net.raceTime;
      const rec = snap.racers.find((x) => x.carId === net.myCarId);
      if (rec) {
        // 本地按圈（服务器的 lap 计数变化）
        if (rec.lap > P.lapVis) {
          P.lapVis = rec.lap;
          const t = this.raceTime - this.netLapStart;
          this.netLapStart = this.raceTime;
          if (t > 1) P.lapTimes.push(t);
          if (rec.lap <= net.laps) { this.audio.play('lap'); this.hud.message(`第 ${rec.lap} 圈 ${formatTime(t)}`, '#6dff9e', true); }
        }
        P.finished = rec.finished;
        P.finishTime = rec.finished ? this.raceTime : 0;
      }
    }

    if (this.player) this.handleEvents(this.player);
    this.standingsNet = snap
      ? [...snap.racers].sort((a, b) => a.place - b.place).map((r) => ({ ...r, name: (net.rosterFor(r.carId) || {}).name || '车手' }))
      : [];
    if (racing || phase === PHASE.result) this.updateRaceHUDNet(vdt);
    this.fx.smoke.update(vdt);
    this.fx.glow.update(vdt);
    this.fx.skids.update();
    for (const u of this.updaters) u(vdt, this.time, this.camera.position);
    for (const w of this.waters) w.material.uniforms.uTime.value = this.time;
    if (this.track.boostPads) for (const bp of this.track.boostPads) bp.mat.map.offset.y = -this.time * 1.2;
    if (P && phase !== PHASE.lobby) {
      this.audio.setEngine(Math.min(1.2, Math.abs(P.s) / TUNE.vmaxNitro), P.throttle, P.boosting, P.drifting && !P.airborne, true);
    } else this.audio.silence();
    net.syncRemote(vdt, this.camera.position);
    this.emitEffectsRemote(vdt);
    if (this.netItems) this.netItems.update(vdt, net.lastSnap && net.lastSnap.items);
    this.netStatsT = (this.netStatsT || 0) + dt;
    if (this.netStatsT > 0.5) {
      this.netStatsT = 0;
      const s = net.stats();
      $('netinfo').textContent = this.state === 'menu' ? '' : `延迟 ${s.rtt}ms · 下行 ${s.kbDown}KB · 上行 ${s.kbUp}KB · 回滚 ${s.rolls}`;
    }
  }

  emitEffectsRemote(dt) {
    if (!this.net) return;
    const R = Math.random;
    for (const view of this.net.models.values()) {
      const m = view.model;
      if (!m.visible) continue;
      if (!(view.flags & 1) || Math.abs(view.s || 0) < 10) continue;
      const h = m.rotation.y;
      const fxv = Math.sin(h), fzv = Math.cos(h);
      const lx = Math.cos(h), lz = -Math.sin(h);
      for (let w = 0; w < 2; w++) {
        const sx = w ? 0.93 : -0.93;
        const wx = m.position.x + lx * sx - fxv * 1.38, wz = m.position.z + lz * sx - fzv * 1.38;
        const key = 'r' + view.carId + '-' + w;
        this.fx.skids.add(key, wx, m.position.y, wz, lx, lz, 0.2, 0.6);
        if (R() < 14 * dt) {
          this.fx.smoke.emit(wx + (R() - 0.5) * 0.6, m.position.y + 0.25, wz + (R() - 0.5) * 0.6, (R() - 0.5) * 2, 0.8 + R(), (R() - 0.5) * 2, 0.9, 1.3, 5, 0.95, 0.95, 0.97, 0.3, -0.6, 1.2);
        }
      }
    }
  }

  updateRaceHUDNet(dt) {
    const P = this.player, net = this.net;
    const snap = net.lastSnap;
    const rec = snap && snap.racers.find((x) => x.carId === net.myCarId);
    if (!rec) return;
    const standings = (this.standingsNet || []).map((r) => {
      const info = net.rosterFor(r.carId) || {};
      const skin = info.skin >= 0 ? CAR_SKINS[info.skin] : null;
      return {
        name: r.name, me: r.carId === net.myCarId, fin: !!(r.flags & 64),
        color: skin ? '#' + skin.body.toString(16).padStart(6, '0') : '#8aa0c0',
      };
    });
    this.hud.update({
      lap: `${Math.min(rec.lap, net.laps)}/${net.laps}`,
      time: rec.finished ? P.finishTime : this.raceTime,
      best: P.lapTimes.length ? Math.min(...P.lapTimes) : 0,
      kmh: P.speedKmh,
      rank: rec.place,
      total: snap.racers.length,
      gauge: P.gauge,
      nitro: P.nitroCount,
      standings,
      items: this.itemMode ? (rec.items || []) : null,
      nitroOn: P.nitroTime > 0,
      smallOn: P.smallBoost > 0 || P.startBoost > 0 || P.padTime > 0,
    });
    this.hud.drawSpeedo(P.speedKmh, P.nitroTime > 0);
    this.hud.drawMinimap([P, ...net.models.values()], P);
    let warn = null;
    if (P.wrongWay > 1.2 && net.phase === PHASE.race) warn = '⚠ 方向错误！';
    this.hud.warn(warn);
  }

  // ---------- 主循环 ----------
  loop() {
    requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const raw = (now - this.last) / 1000;
    // 联机要跟上服务器的真实时间（允许一帧补跑更多物理步），单机仍按旧上限
    const dt = Math.min(this.net ? 0.2 : 0.05, raw);
    this.last = now;
    this.time += Math.min(0.05, raw);
    const inp = this.input.frame();
    if (this.state !== 'paused') this.step(dt, inp);
    this.render(Math.min(0.05, raw));
  }

  step(dt, inp) {
    if (this.net) return this.stepOnline(dt, inp);
    const st = this.state;
    const racing = st === 'race';
    if (st === 'countdown') {
      this.cdT += dt;
      const n = Math.floor(this.cdT);
      if (n !== this.cdShown && n <= 3) {
        this.cdShown = n;
        this.hud.countdown(n < 3 ? String(3 - n) : 'GO!');
        this.gate?.set(n < 3 ? n + 1 : 4);
        this.audio.play(n < 3 ? 'count' : 'go');
      }
      if (inp.upPressed && !this.startTried) {
        this.startTried = true;
        if (this.cdT > 2.72) this.startBoostReady = true;
      }
      if (this.cdT >= 3) {
        this.state = 'race';
        this.raceTime = 0;
        for (const r of this.racers) if (r.isPlayer) r.lapStart = 0; else r.lapStart = 0;
        if (this.startBoostReady) this.applyStartBoost();
        setTimeout(() => this.hud.countdown(''), 700);
      }
    }
    if (st === 'finish') this.raceTime += dt;
    if (st === 'race') {
      this.raceTime += dt;
      if (inp.upPressed && !this.startTried && this.raceTime < 0.28) { this.startTried = true; this.applyStartBoost(); }
      if (inp.upPressed) this.startTried = true;
    }
    if (st === 'menu') this.raceTime += dt;

    const P = this.player;
    // 玩家输入：完赛后自动驾驶
    let pin = inp;
    if (P) {
      if (P.finished || this.resultShown) pin = this.autopilot(P);
      else if (IS_TOUCH && racing) { this.input.touch.up = true; }
      if (IS_TOUCH && !racing) this.input.touch.up = false;
      if (inp.resetPressed && racing && !P.finished) this.resetPlayer();
      if (this.itemMode && racing && !P.finished) {
        if (inp.nitroPressed) this.items.use(P);
        if (inp.swapPressed) this.items.swap(P);
      }
    }
    const active = st === 'race' || st === 'finish';
    const aiActive = st === 'race' || st === 'menu' || st === 'finish';
    // 固定步长
    this.acc += dt;
    let first = true;
    const noEdge = { ...pin, upPressed: false, wPressed: false, nitroPressed: false };
    while (this.acc >= DT) {
      this.acc -= DT;
      if (P) P.update(DT, first ? pin : noEdge, active, this.itemMode);
      first = false;
      for (const r of this.racers) if (!r.isPlayer) r.update(DT, aiActive, this.raceTime, this.rubber(r));
      this.collide();
    }
    for (const r of this.racers) {
      r.syncModel(dt);
      this.updateProgress(r);
    }
    this.standings = [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    if (this.items && (racing || st === 'finish')) {
      this.items.update(dt, this.racers, this.standings);
      for (const r of this.racers) if (!r.isPlayer && !r.finished) this.items.aiThink(r, dt, this.standings);
    }
    if (P) this.handleEvents(P);
    this.emitEffects(dt);
    this.fx.smoke.update(dt);
    this.fx.glow.update(dt);
    this.fx.skids.update();
    for (const u of this.updaters) u(dt, this.time, this.camera.position);
    for (const w of this.waters) w.material.uniforms.uTime.value = this.time;
    if (this.track.boostPads) for (const bp of this.track.boostPads) bp.mat.map.offset.y = -this.time * 1.2;

    if (P && (racing || st === 'finish' || st === 'countdown')) this.updateRaceHUD(dt);
    if (st === 'race' || st === 'finish') this.checkRaceEnd(dt);

    // 声音
    if (P && st !== 'menu') {
      this.audio.setEngine(Math.min(1.2, Math.abs(P.s) / TUNE.vmaxNitro), st === 'countdown' ? (this.input.has('ArrowUp') ? 1 : 0) : P.throttle, P.boosting, P.drifting && !P.airborne, true);
    } else this.audio.silence();
  }

  rubber(r) {
    if (!this.player || this.state === 'menu') return 1;
    const diff = DIFFS[this.settings.diff];
    const gap = r.progress - this.player.progress;
    if (gap > 0) return Math.max(diff.rubber[0], 1 - gap * 0.00045);
    return Math.min(diff.rubber[1], 1 - gap * 0.0004);
  }

  applyStartBoost() {
    const P = this.player;
    P.startBoost = 1.4;
    P.s = Math.max(P.s, 16);
    this.hud.message('起步加速!', '#ffd23a');
    this.audio.play('small');
  }

  resetPlayer() {
    const P = this.player;
    const s = this.track.sample(P.d, {});
    const keepLap = { lapsDone: P.lapsDone, owed: P.owed, half: P.half, lastD: P.d, gauge: P.gauge, nitroCount: P.nitroCount };
    P.reset(P.d, clamp(P.lat, -4, 4));
    Object.assign(P, keepLap);
    P.h = P.m = s.hd;
    P.s = 12;
    this.hud.message('复位', '#ffffff', true);
  }

  autopilot(r) {
    const s = this.track.sample(r.d + 18, {});
    const want = Math.atan2(s.x - r.x, s.z - r.z);
    const e = wrapAngle(want - r.h);
    return { ...NO_INPUT, up: Math.abs(r.s) < 38, left: e > 0.04, right: e < -0.04 };
  }

  // ---------- 进度 / 圈数 ----------
  updateProgress(r, init = false) {
    const L = this.track.length;
    if (r.isPlayer) {
      const d = r.d;
      if (!init) {
        if (r.lastD > 0.75 * L && d < 0.25 * L) {
          if (r.owed) { r.lapsDone++; r.owed = false; }
          else if (r.half) { r.lapsDone++; r.half = false; this.onLap(r); }
        } else if (r.lastD < 0.25 * L && d > 0.75 * L) {
          r.lapsDone--;
          r.owed = true;
        }
        if (d > 0.4 * L && d < 0.6 * L) r.half = true;
      }
      r.lastD = d;
      r.progress = r.lapsDone * L + d;
    } else {
      const laps = Math.floor(r.dist / L);
      if (!init && r.lapsDone !== undefined && laps > r.lapsDone && laps >= 1) { r.lapsDone = laps; this.onLap(r); }
      r.lapsDone = laps;
      r.progress = r.dist;
    }
  }

  onLap(r) {
    if (this.state !== 'race' && this.state !== 'finish') return;
    const t = this.raceTime - (r.lapStart || 0);
    r.lapStart = this.raceTime;
    r.lapTimes.push(t);
    const laps = this.settings.laps;
    if (r.lapsDone >= laps && !r.finished) {
      r.finished = true;
      r.finishTime = this.raceTime;
      if (this.firstFinish < 0) this.firstFinish = this.raceTime;
      if (r.isPlayer) {
        this.hud.message('完成比赛!', '#ffd23a');
        this.audio.play('finish');
        this.state = 'finish';
        this.finishT = 0;
      }
      return;
    }
    if (r.isPlayer) {
      const best = Math.min(...r.lapTimes);
      this.audio.play('lap');
      this.hud.message(`第 ${r.lapsDone} 圈 ${formatTime(t)}${t <= best && r.lapTimes.length > 1 ? ' 最佳!' : ''}`, '#6dff9e', true);
      if (r.lapsDone === laps - 1) setTimeout(() => this.hud.message('最后一圈!', '#ff5fa8'), 900);
    }
  }

  checkRaceEnd(dt) {
    const P = this.player;
    if (this.resultShown) return;
    if (this.state === 'finish') {
      this.finishT += dt;
      const allDone = this.racers.every((r) => r.finished);
      if (this.finishT > 4 && (allDone || this.raceTime - this.firstFinish > 10 || this.finishT > 12)) this.showResults();
      return;
    }
    if (this.firstFinish >= 0 && !P.finished) {
      const left = 10 - (this.raceTime - this.firstFinish);
      this.hud.finalCount(`有车手已冲线！剩余 ${Math.max(0, Math.ceil(left))} 秒`);
      if (left <= 0) this.showResults();
    }
  }

  showResults() {
    this.resultShown = true;
    this.state = 'finish';
    this.hud.finalCount('');
    const L = this.track.length;
    const order = [...this.standings];
    const P = this.player;
    const place = order.indexOf(P) + 1;
    const title = !P.finished ? '未完成比赛' : place === 1 ? '冠军！' : `第 ${place} 名`;
    $('resTitle').textContent = title;
    $('resTitle').classList.toggle('win', P.finished && place === 1);
    const st = P.stats;
    $('resStats').innerHTML = [
      ['漂移', st.drift], ['小喷', st.small], ['完美小喷', st.perfect], ['双喷', st.double], ['氮气', st.nitro], ['最高时速', Math.round(st.top) + ''], ['碰撞', st.crash],
    ].map(([k, v]) => `<div class="stat"><b>${v}</b>${k}</div>`).join('');
    $('resBody').innerHTML = order.map((r, i) => {
      const best = r.lapTimes.length ? Math.min(...r.lapTimes) : 0;
      const total = r.finished ? formatTime(r.finishTime) : `未完成 (${Math.floor(Math.max(0, Math.min(99, (r.progress / L) * 100 / this.settings.laps)))}%)`;
      return `<tr class="${r.isPlayer ? 'me' : ''}"><td class="pos">${i + 1}</td><td>${r.name}</td><td>${total}</td><td>${formatTime(best)}</td></tr>`;
    }).join('');
    setTimeout(() => {
      $('result').classList.remove('hidden');
      $('touch').classList.add('hidden');
    }, 400);
  }

  racerAhead(r) {
    const i = this.standings.indexOf(r);
    return i > 0 ? this.standings[i - 1] : null;
  }

  // ---------- 碰撞 ----------
  collide() {
    const rs = this.racers;
    const R = 3.1;
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j];
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R || Math.abs(a.y - b.y) > 2.5) continue;
        const d = Math.sqrt(d2) || 0.01;
        const nx = dx / d, nz = dz / d;
        const over = R - d;
        this.pushRacer(a, -nx * over * 0.5, -nz * over * 0.5);
        this.pushRacer(b, nx * over * 0.5, nz * over * 0.5);
        // 速度交换（简化）
        const va = this.vel(a), vb = this.vel(b);
        const rel = (vb[0] - va[0]) * nx + (vb[1] - va[1]) * nz;
        if (rel < 0) {
          const imp = -rel * 0.5;
          this.kick(a, -nx * imp, -nz * imp);
          this.kick(b, nx * imp, nz * imp);
          if ((a.isPlayer || b.isPlayer) && imp > 3) {
            this.audio.play('crash', imp);
            this.shake = Math.max(this.shake, 0.3);
            this.fx.sparks((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.6, (a.z + b.z) / 2, 10);
          }
        }
      }
  }

  vel(r) {
    if (r.isPlayer) return [Math.sin(r.m) * r.s, Math.cos(r.m) * r.s];
    const s = this.track.sample(r.dist, {});
    return [s.tx * r.s + s.rx * r.latV, s.tz * r.s + s.rz * r.latV];
  }

  pushRacer(r, px, pz) {
    if (r.isPlayer) { r.x += px; r.z += pz; return; }
    const s = this.track.sample(r.dist, {});
    r.lat += px * s.rx + pz * s.rz;
    r.pushD += px * s.tx + pz * s.tz;
  }

  kick(r, vx, vz) {
    if (r.isPlayer) {
      const cx = Math.sin(r.m) * r.s + vx, cz = Math.cos(r.m) * r.s + vz;
      const ns = Math.hypot(cx, cz);
      if (r.s >= 0 && ns > 0.5) { r.s = ns; r.m = Math.atan2(cx, cz); }
      return;
    }
    const s = this.track.sample(r.dist, {});
    r.s = Math.max(0, r.s + vx * s.tx + vz * s.tz);
    r.latV += vx * s.rx + vz * s.rz;
  }

  hitRacer(r, kind) {
    const absorbed = applyHit(r, kind) === 'shield'; // 与服务器/联机端共用同一份冲击结算
    if (absorbed) {
      this.sfx('shield', r);
      if (r.isPlayer) this.hud.message('天使护体!', '#ffe28a', true);
      return;
    }
    if (r.isPlayer) {
      this.hud.message(kind === 'missile' ? '被导弹击中!' : '踩到香蕉皮!', '#ff4b4b');
      this.hud.flash();
      this.shake = 0.8;
    }
    this.sfx(kind === 'missile' ? 'boom' : 'banana', r);
  }

  sfx(name, r) {
    const P = this.player;
    if (!P) return;
    const d = Math.hypot(r.x - P.x, r.z - P.z);
    if (d < 120) this.audio.play(name);
  }

  onItemGet(it) {
    this.audio.play('item');
  }

  onMissileLock() {
    this.missileWarn = 1.6;
    this.audio.play('wrong');
  }

  // ---------- 玩家事件 → 提示/音效/特效 ----------
  handleEvents(P) {
    const st = P.stats;
    st.top = Math.max(st.top, P.speedKmh);
    for (const e of P.events) {
      switch (e.type) {
        case 'driftStart': st.drift++; break;
        case 'smallBoost':
          st.small++;
          if (e.data.perfect) st.perfect++;
          this.hud.message(e.data.perfect ? '完美小喷!' : '小喷!', '#ff9a1f');
          this.audio.play('small');
          this.fx.boostBurst(P, 0xffa040);
          break;
        case 'landBoost':
          st.small++;
          this.hud.message('落地喷!', '#ff9a1f');
          this.audio.play('small');
          this.fx.boostBurst(P, 0xffa040);
          break;
        case 'double':
          st.double++;
          setTimeout(() => this.hud.message('双喷!!', '#ff5fa8'), 120);
          this.audio.play('double');
          break;
        case 'nitro':
          st.nitro++;
          this.hud.message('氮气加速!', '#27c7ff');
          this.audio.play('nitro');
          this.fx.boostBurst(P, 0x39a8ff);
          this.shake = Math.max(this.shake, 0.25);
          break;
        case 'gaugeFull':
          this.hud.message('集气完成 +1 N₂O', '#7af0ff', true);
          this.audio.play('gauge');
          break;
        case 'crash':
          st.crash++;
          this.audio.play('crash', e.data.power);
          this.shake = Math.max(this.shake, Math.min(0.9, e.data.power * 0.05));
          this.fx.sparks(e.data.x, P.y + 0.6, e.data.z, 18);
          break;
        case 'scrape':
          if (Math.random() < 0.3) this.fx.sparks(e.data.x, P.y + 0.5, e.data.z, 2);
          if (Math.random() < 0.08) this.audio.play('scrape');
          break;
        case 'land':
          if (e.data.air > 0.25) {
            this.audio.play('land');
            this.shake = Math.max(this.shake, 0.3);
            this.fx.dust(P.x, P.y, P.z);
          }
          break;
        case 'pad':
          this.hud.message('加速带!', '#27c7ff', true);
          this.audio.play('pad');
          break;
      }
    }
    P.events.length = 0;
  }

  updateRaceHUD(dt) {
    const P = this.player;
    const laps = this.settings.laps;
    const standings = this.standings.map((r) => ({
      name: r.name,
      me: r.isPlayer,
      fin: r.finished,
      color: '#' + r.model.userData.skin.body.toString(16).padStart(6, '0'),
    }));
    const lapNow = clamp(P.lapsDone + 1, 1, laps);
    this.hud.update({
      lap: `${lapNow}/${laps}`,
      time: P.finished ? P.finishTime : this.state === 'countdown' ? 0 : this.raceTime,
      best: P.lapTimes.length ? Math.min(...P.lapTimes) : 0,
      kmh: P.speedKmh,
      rank: this.standings.indexOf(P) + 1,
      total: this.racers.length,
      gauge: P.gauge,
      nitro: P.nitroCount,
      standings,
      items: this.itemMode ? P.items : null,
      nitroOn: P.nitroTime > 0,
      smallOn: P.smallBoost > 0 || P.startBoost > 0 || P.padTime > 0,
    });
    this.hud.drawSpeedo(P.speedKmh, P.nitroTime > 0);
    this.hud.drawMinimap(this.racers, P);
    let warn = null;
    if (P.wrongWay > 1.2 && this.state === 'race') warn = '⚠ 方向错误！';
    if (this.missileWarn > 0) { this.missileWarn -= dt; warn = '⚠ 导弹锁定！'; }
    this.hud.warn(warn);
  }

  // ---------- 特效 ----------
  makeFx() {
    const smoke = new Particles(IS_TOUCH ? 900 : 1800, false);
    const glow = new Particles(IS_TOUCH ? 900 : 1800, true);
    const skids = new SkidMarks(2600);
    const R = Math.random;
    return {
      smoke, glow, skids,
      sparks(x, y, z, n) {
        for (let i = 0; i < n; i++) glow.emit(x, y, z, (R() - 0.5) * 16, R() * 7, (R() - 0.5) * 16, 0.4 + R() * 0.4, 0.5, 0.1, 1, 0.75 + R() * 0.25, 0.3, 1, 18, 1);
      },
      dust(x, y, z) {
        for (let i = 0; i < 24; i++) smoke.emit(x + (R() - 0.5) * 3, y + 0.3, z + (R() - 0.5) * 3, (R() - 0.5) * 8, R() * 2, (R() - 0.5) * 8, 1 + R(), 2, 6, 0.85, 0.8, 0.72, 0.5, -0.5, 1.5);
      },
      burst(x, y, z, color) {
        const c = new THREE.Color(color);
        for (let i = 0; i < 26; i++) glow.emit(x, y, z, (R() - 0.5) * 14, (R() - 0.2) * 10, (R() - 0.5) * 14, 0.5 + R() * 0.3, 1.2, 0.2, c.r, c.g, c.b, 1, 6, 2);
      },
      explode(x, y, z) {
        for (let i = 0; i < 40; i++) glow.emit(x, y, z, (R() - 0.5) * 22, R() * 14, (R() - 0.5) * 22, 0.5 + R() * 0.5, 3, 0.5, 1, 0.5 + R() * 0.4, 0.15, 1, 10, 2);
        for (let i = 0; i < 20; i++) smoke.emit(x, y, z, (R() - 0.5) * 8, R() * 6, (R() - 0.5) * 8, 1.2 + R(), 3, 9, 0.3, 0.3, 0.32, 0.6, -1, 1.5);
      },
      trail(x, y, z) {
        glow.emit(x, y, z, (R() - 0.5), (R() - 0.5), (R() - 0.5), 0.25, 1.2, 0.2, 1, 0.6, 0.2, 1);
        smoke.emit(x, y, z, (R() - 0.5), R(), (R() - 0.5), 0.8, 0.8, 3, 0.85, 0.85, 0.88, 0.4);
      },
      boostBurst(r, color) {
        const c = new THREE.Color(color);
        const bx = r.x - Math.sin(r.h) * 2.5, bz = r.z - Math.cos(r.h) * 2.5;
        for (let i = 0; i < 30; i++) glow.emit(bx, r.y + 0.6, bz, (R() - 0.5) * 10 - Math.sin(r.h) * 10, R() * 4, (R() - 0.5) * 10 - Math.cos(r.h) * 10, 0.35 + R() * 0.3, 1.6, 0.2, c.r, c.g, c.b, 1, 0, 3);
      },
    };
  }

  emitEffects(dt) {
    const fx = this.fx;
    const R = Math.random;
    const cam = this.camera.position;
    for (const r of this.racers) {
      const far = (r.x - cam.x) ** 2 + (r.z - cam.z) ** 2 > 250 * 250;
      const h = r.h;
      const fxv = Math.sin(h), fzv = Math.cos(h);
      const lx = Math.cos(h), lz = -Math.sin(h);
      const sp = Math.abs(r.s);
      const drifting = r.drifting && !r.airborne && sp > 10;
      for (let w = 0; w < 2; w++) {
        const sx = w ? 0.93 : -0.93;
        const wx = r.x + lx * sx - fxv * 1.38, wz = r.z + lz * sx - fzv * 1.38;
        const key = (r.isPlayer ? 'p' : r.slot) + '-' + w;
        if (drifting) {
          fx.skids.add(key, wx, r.y, wz, lx, lz, 0.2, r.isPlayer ? 1 : 0.7);
          if (!far) {
            const rate = (r.isPlayer ? 55 : 22) * dt;
            for (let k = 0; k < rate + (R() < rate % 1 ? 1 : 0); k++)
              fx.smoke.emit(wx + (R() - 0.5) * 0.6, r.y + 0.25, wz + (R() - 0.5) * 0.6, (R() - 0.5) * 2 - fxv * sp * 0.08, 0.8 + R() * 1.2, (R() - 0.5) * 2 - fzv * sp * 0.08, 0.8 + R() * 0.7, 1.3, 5 + R() * 2, 0.95, 0.95, 0.97, r.isPlayer ? 0.42 : 0.3, -0.6, 1.2);
            if (r.isPlayer && R() < 0.5) {
              const c = r.gauge >= 1 || r.nitroCount >= 2 ? [1, 0.85, 0.3] : [0.5, 0.85, 1];
              fx.glow.emit(wx, r.y + 0.2, wz, (R() - 0.5) * 3, R() * 3, (R() - 0.5) * 3, 0.25, 0.5, 0.1, c[0], c[1], c[2], 1, 8, 1);
            }
          }
        } else fx.skids.cut(key);
      }
      const nitro = r.nitroTime > 0;
      const small = r.isPlayer && (r.smallBoost > 0 || r.padTime > 0 || r.startBoost > 0);
      if ((nitro || small) && !far) {
        for (const sx of [-0.42, 0.42]) {
          const ex = r.x + lx * sx - fxv * 2.6, ez = r.z + lz * sx - fzv * 2.6;
          const n = nitro ? 2 : 1;
          for (let k = 0; k < n; k++) {
            const c = nitro ? (R() < 0.5 ? [0.3, 0.7, 1] : [0.85, 0.95, 1]) : [1, 0.6, 0.2];
            fx.glow.emit(ex, r.y + 0.45, ez, -fxv * 6 + (R() - 0.5) * 2, R() * 1.5, -fzv * 6 + (R() - 0.5) * 2, 0.18 + R() * 0.1, nitro ? 1.3 : 0.9, 0.2, c[0], c[1], c[2], 1);
          }
        }
      }
      if (r.isPlayer && r.magnet > 0 && r.magnetTarget && !far) {
        const t = r.magnetTarget;
        for (let k = 0; k < 3; k++) {
          const f = R();
          fx.glow.emit(lerp(r.x, t.x, f), lerp(r.y, t.y, f) + 1, lerp(r.z, t.z, f), 0, 0, 0, 0.12, 0.8, 0.3, 0.8, 0.4, 1, 1);
        }
      }
    }
  }

  // ---------- 相机 ----------
  snapCamera() {
    const P = this.player;
    const x = P.rx ?? P.x, z = P.rz ?? P.z, h = P.rh ?? P.h;
    this.camYaw = h;
    this.camPos.set(x - Math.sin(h) * 9, P.y + 3.4, z - Math.cos(h) * 9);
    this.camLook.set(x, P.y + 1, z);
  }

  updateCamera(dt) {
    const cam = this.camera;
    if (cam.userData.fixed) return;
    const st = this.state;
    let target = this.player;
    if (st === 'menu') {
      this.demoT += dt;
      if (this.demoT > 9) { this.demoT = 0; this.demoTarget = (this.demoTarget + 1) % this.racers.length; this.demoCut = true; }
      target = this.racers[this.demoTarget];
    }
    if (!target) return;
    const tx = target.x, ty = target.y, tz = target.z;
    if (st === 'menu' || (st === 'finish' && this.resultShown)) {
      const a = this.time * 0.25 + this.demoTarget;
      const want = new THREE.Vector3(tx + Math.sin(a) * 11, ty + 3.2 + Math.sin(this.time * 0.4) * 1.2, tz + Math.cos(a) * 11);
      if (this.demoCut) { this.camPos.copy(want); this.demoCut = false; }
      this.camPos.lerp(want, 1 - Math.exp(-3 * dt));
      this.camLook.set(tx, ty + 1, tz);
      cam.position.copy(this.camPos);
      cam.lookAt(this.camLook);
      cam.fov = damp(cam.fov, 55, 3, dt);
      cam.updateProjectionMatrix();
      return;
    }
    const P = target;
    // 跟随"渲染位姿"而不是裸物理位姿：联机对账修正已被偏移滑形吸收，相机不能再去吃原始跳变
    const px = P.rx ?? P.x, pz = P.rz ?? P.z, ph = P.rh ?? P.h;
    const modes = [
      { dist: 8.2, h: 3.0, look: 5, lookH: 1.3 },
      { dist: 12.5, h: 4.6, look: 6, lookH: 1.5 },
      { dist: 5.2, h: 1.9, look: 8, lookH: 1.1 },
    ];
    const m = modes[this.camMode];
    // 漂移时相机跟随速度方向，能看到车身侧滑。用 NetCore 衰减过的 rm 而不是裸 m：
    // m 每份快照都会被权威值整份覆盖，直接吃它就会在纠偏那一刻甩头
    const md = P.rm ?? P.m;
    const yawT = P.s >= 0 ? md + wrapAngle(ph - md) * 0.35 : ph;
    this.camYaw = dampAngle(this.camYaw, yawT, P.drifting ? 4.5 : 7, dt);
    const boostPull = P.nitroTime > 0 ? 1.6 : P.smallBoost > 0 ? 0.8 : 0;
    const dist = m.dist + Math.abs(P.s) * 0.018 + boostPull;
    const want = new THREE.Vector3(px - Math.sin(this.camYaw) * dist, P.y + m.h, pz - Math.cos(this.camYaw) * dist);
    // 相机不钻地
    const gy = this.groundAt(want.x, want.z) + 1.0;
    if (want.y < gy) want.y = gy;
    if (P.airborne) want.y = Math.max(want.y, P.y + m.h);
    this.camPos.lerp(want, 1 - Math.exp(-14 * dt));
    this.camPos.y = damp(this.camPos.y, want.y, 8, dt);
    const look = new THREE.Vector3(px + Math.sin(this.camYaw) * m.look, P.y + m.lookH, pz + Math.cos(this.camYaw) * m.look);
    this.camLook.lerp(look, 1 - Math.exp(-18 * dt));
    cam.position.copy(this.camPos);
    // 晃动用连续低频摆动，不用逐帧白噪声：同幅度的随机抖是最容易引发起晕与恶心的形式
    const w1 = Math.sin(this.time * 31) * 1.0, w2 = Math.sin(this.time * 23 + 1.7), w3 = Math.sin(this.time * 37 + 3.1);
    if (this.shake > 0) {
      const k = this.shake * this.shake;
      cam.position.x += w1 * k * 0.85;
      cam.position.y += w2 * k * 0.6;
      cam.position.z += w3 * k * 0.85;
      this.shake = Math.max(0, this.shake - dt * 1.8);
    }
    if (P.nitroTime > 0) {
      cam.position.x += w2 * 0.045;
      cam.position.y += w1 * 0.035;
    }
    cam.lookAt(this.camLook);
    const fovT = 66 + Math.abs(P.s) * 0.12 + (P.nitroTime > 0 ? 9 : 0) + (P.smallBoost > 0 ? 4 : 0);
    cam.fov = damp(cam.fov, fovT, 4, dt);
    cam.updateProjectionMatrix();
  }

  render(dt) {
    if (!this.track) return;
    this.updateCamera(dt);
    const cp = this.camera.position;
    if (this.skyMesh) this.skyMesh.position.copy(cp);
    if (this.sun) {
      const f = this.player && this.state !== 'menu' ? this.player : this.racers[this.demoTarget] || { x: cp.x, y: cp.y, z: cp.z };
      // 阴影相机跟随，按纹素对齐减少抖动
      const snap = 150 / this.sun.shadow.mapSize.x;
      const fx = Math.round(f.x / snap) * snap, fz = Math.round(f.z / snap) * snap;
      this.sun.target.position.set(fx, f.y, fz);
      this.sun.position.set(fx + this.sunDir.x * 220, f.y + this.sunDir.y * 220, fz + this.sunDir.z * 220);
    }
    const P = this.player;
    if (P && (this.state === 'race' || this.state === 'finish')) {
      const k = clamp((Math.abs(P.s) - 42) / 30, 0, 1) * 0.6 + (P.nitroTime > 0 ? 0.6 : 0) + (P.smallBoost > 0 ? 0.25 : 0);
      this.hud.speedLines(dt, k, P.nitroTime > 0 ? '#bfe9ff' : '#ffffff');
    } else if (this.hud.lines.length) this.hud.clearFx();
    if (this.bloom) this.bloom.strength = (this.settings.quality === 'high' ? 0.75 : 0.6) + (P && P.nitroTime > 0 ? 0.3 : 0);
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  try {
    window.game = new Game();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;color:#fff;font-family:sans-serif">无法初始化 WebGL：${e.message}</div>`;
    throw e;
  }
});
