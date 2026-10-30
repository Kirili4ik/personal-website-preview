(function (root) {
  'use strict';

  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const smooth = (low, high, value) => {
    const t = clamp((value - low) / (high - low));
    return t * t * (3 - 2 * t);
  };

  function parseGlb(buffer) {
    const view = new DataView(buffer);
    if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) {
      throw new Error('Expected an embedded-texture GLB version 2.');
    }
    let gltf;
    let binary;
    for (let offset = 12; offset + 8 <= buffer.byteLength;) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (start + length > buffer.byteLength) throw new Error('Truncated GLB chunk.');
      if (type === 0x4e4f534a) gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)));
      if (type === 0x004e4942) binary = start;
      offset = start + length;
    }
    const variants = gltf?.extensions?.KHR_materials_variants?.variants || [];
    const foilVariant = variants.findIndex(variant => variant.name === 'Rainbow foil');
    for (const mesh of gltf?.meshes || []) {
      for (const primitive of mesh.primitives) {
        const mapping = primitive.extensions?.KHR_materials_variants?.mappings?.find(entry => entry.variants.includes(foilVariant));
        const original = gltf.materials[primitive.material];
        const texture = original?.pbrMetallicRoughness?.baseColorTexture;
        if (!mapping || !texture || mapping.material === primitive.material) continue;
        const image = gltf.images[gltf.textures[texture.index].source];
        const imageView = gltf.bufferViews[image.bufferView];
        if (binary == null || !imageView) throw new Error('The GLB print image must be embedded.');
        const start = binary + (imageView.byteOffset || 0);
        if (start + imageView.byteLength > buffer.byteLength) throw new Error('Truncated GLB print image.');
        return {image: new Blob([new Uint8Array(buffer, start, imageView.byteLength)], {type: image.mimeType}),
          originalMaterialIndex: primitive.material, foilMaterialIndex: mapping.material,
          foilMaterialName: gltf.materials[mapping.material].name,
          foilIridescenceFactor: gltf.materials[mapping.material].extensions?.KHR_materials_iridescence?.iridescenceFactor || 0};
      }
    }
    throw new Error('No printed front with a separate Rainbow foil variant was found in the GLB.');
  }

  function createPrintRenderer(image, createCanvas, appearance = {}) {
    const width = image.width;
    const height = image.height;
    const colorCoverage = clamp(Number(appearance.colorCoverage) || 0);
    let seed = Number.isInteger(appearance.seed) ? appearance.seed >>> 0 : 932071;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const orientation = random() * Math.PI * 2;
    const frequency = 1.4 + random() * 1.1;
    const bandU = Math.cos(orientation) * frequency;
    const bandV = Math.sin(orientation) * frequency;
    const bandOffset = random();
    const rippleFrequency = 8 + random() * 10;
    const rippleOffset = random() * Math.PI * 2;
    const ridgeFrequency = 0.7 + random() * 0.8;
    const ridgeOffset = random() * Math.PI * 2;
    const glareU = 0.36 + random() * 0.26;
    const glareV = 0.34 + random() * 0.24;
    const source = createCanvas(width, height);
    source.getContext('2d').drawImage(image, 0, 0);
    const scale = Math.min(1, 416 / Math.max(width, height));
    const effect = createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const effectContext = effect.getContext('2d');
    effectContext.drawImage(source, 0, 0, effect.width, effect.height);
    const sample = effectContext.getImageData(0, 0, effect.width, effect.height);
    const mask = new Float32Array(effect.width * effect.height);
    const luminance = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      const p = i * 4;
      const r = sample.data[p] / 255;
      const g = sample.data[p + 1] / 255;
      const b = sample.data[p + 2] / 255;
      const light = luminance[i] = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      const warmInk = smooth(0.03, 0.25, r - b) * smooth(0, 0.12, g - b);
      mask[i] = smooth(0.16, 0.65, light) * (1 - saturation * 0.78) * (1 - warmInk * 0.65) * (sample.data[p + 3] / 255);
      mask[i] += (smooth(0.12, 0.48, Math.max(r, g, b)) * (sample.data[p + 3] / 255) - mask[i]) * colorCoverage;
    }
    for (let y = 0; y < effect.height; y++) {
      for (let x = 0; x < effect.width; x++) {
        const i = y * effect.width + x;
        const detail = Math.max(Math.abs(luminance[i] - luminance[y * effect.width + Math.max(0, x - 1)]),
          Math.abs(luminance[i] - luminance[Math.max(0, y - 1) * effect.width + x]));
        mask[i] *= 1 - smooth(0.035, 0.23, detail) * 0.88;
      }
    }
    const light = effectContext.createImageData(effect.width, effect.height);
    const bandPosition = new Float32Array(mask.length);
    const rippleSin = new Float32Array(mask.length);
    const rippleCos = new Float32Array(mask.length);
    const ridgeSin = new Float32Array(mask.length);
    const ridgeCos = new Float32Array(mask.length);
    for (let y = 0; y < effect.height; y++) {
      for (let x = 0; x < effect.width; x++) {
        const i = y * effect.width + x;
        const u = x / effect.width;
        const v = y / effect.height;
        const across = u * bandU + v * bandV;
        const along = -u * bandV + v * bandU;
        bandPosition[i] = across + bandOffset;
        rippleSin[i] = Math.sin(along * rippleFrequency + rippleOffset);
        rippleCos[i] = Math.cos(along * rippleFrequency + rippleOffset);
        ridgeSin[i] = Math.sin(along * ridgeFrequency * Math.PI * 2 + ridgeOffset);
        ridgeCos[i] = Math.cos(along * ridgeFrequency * Math.PI * 2 + ridgeOffset);
      }
    }
    const palette = new Float32Array(1024 * 3);
    for (let i = 0; i < 1024; i++) {
      for (let channel = 0; channel < 3; channel++) {
        palette[i * 3 + channel] = 0.5 + 0.5 * Math.cos((i / 1024 + [0, -1 / 3, 1 / 3][channel]) * Math.PI * 2);
      }
    }
    const glareX = new Float32Array(effect.width);
    const spotX = new Float32Array(effect.width);
    const flakes = Array.from({length: Math.round(width * height / 850 * (0.7 + random() * 0.6))}, () =>
      ({u: random(), v: random(), phase: random() * Math.PI * 2, size: 0.5 + random(), hue: random()}));
    const stars = Array.from({length: Math.round(58 + random() * 54)}, () =>
      ({u: random(), v: random(), phase: random() * Math.PI * 2, size: 1.5 + random() * 3}));
    const maskAt = (u, v) => mask[Math.min(effect.height - 1, Math.floor(v * effect.height)) * effect.width + Math.min(effect.width - 1, Math.floor(u * effect.width))];

    function render(canvas, orbit, finish, strength, flipY = false) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.save();
      if (flipY) {
        // CanvasTexture defaults to flipY=true, unlike the embedded glTF textures.
        ctx.translate(0, height);
        ctx.scale(1, -1);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(source, 0, 0);
      strength = clamp(Number(strength) || 0);
      if (finish === 'Original print' || strength === 0) { ctx.restore(); return canvas; }
      const theta = Number.isFinite(orbit.theta) ? orbit.theta : 0;
      const tilt = (Number.isFinite(orbit.phi) ? orbit.phi : Math.PI / 2) - Math.PI / 2;
      const horizontal = Math.sin(theta);
      const vertical = Math.sin(tilt);
      const spotU = glareU + horizontal * 0.55;
      const spotV = glareV + vertical * 0.55;
      const phase = horizontal * 1.45 - vertical * 1.2;
      const cosmos = finish === 'Cosmos foil';
      const phaseSin = Math.sin(phase * 3);
      const phaseCos = Math.cos(phase * 3);
      const ridgePhaseSin = Math.sin(phase * 0.68 * Math.PI * 2);
      const ridgePhaseCos = Math.cos(phase * 0.68 * Math.PI * 2);
      for (let x = 0; x < effect.width; x++) {
        const distance = (x / effect.width - spotU) ** 2;
        glareX[x] = Math.exp(-distance * 22);
        spotX[x] = Math.exp(-distance * 5.5);
      }
      for (let y = 0; y < effect.height; y++) {
        const v = y / effect.height;
        const distanceY = (v - spotV) * (v - spotV);
        const glareY = Math.exp(-distanceY * 22) * 0.42;
        const spotY = Math.exp(-distanceY * 5.5);
        for (let x = 0; x < effect.width; x++) {
          const i = y * effect.width + x;
          const p = i * 4;
          const spotlight = spotX[x] * spotY;
          const band = bandPosition[i] + phase + (rippleSin[i] * phaseCos + rippleCos[i] * phaseSin) * 0.045;
          const hue = Math.floor((band - Math.floor(band)) * 1024) * 3;
          const glare = glareX[x] * glareY;
          const ridgeBase = 0.5 + 0.5 * (ridgeCos[i] * ridgePhaseCos - ridgeSin[i] * ridgePhaseSin);
          const ridgeSquare = ridgeBase * ridgeBase;
          const ridgeFourth = ridgeSquare * ridgeSquare;
          const ridge = ridgeFourth * ridgeFourth * ridgeFourth;
          const tint = cosmos ? 0.3 : 0.53;
          light.data[p] = 255 * clamp(0.3 + palette[hue] * tint + glare + ridge * 0.18);
          light.data[p + 1] = 255 * clamp(0.3 + palette[hue + 1] * tint + glare + ridge * 0.18);
          light.data[p + 2] = 255 * clamp((cosmos ? 0.53 : 0.3) + palette[hue + 2] * tint + glare + ridge * 0.18);
          light.data[p + 3] = 255 * mask[i] * strength * (0.26 + spotlight * 0.28 + ridge * 0.1) * (cosmos ? 0.62 : 1);
        }
      }
      effectContext.putImageData(light, 0, 0);
      // source-atop keeps the original alpha, including antialiased cut edges and holes.
      ctx.globalCompositeOperation = 'source-atop';
      ctx.drawImage(effect, 0, 0, width, height);
      const angle = horizontal * 7.4 + vertical * 5.3;
      for (const flake of flakes) {
        const alignment = Math.pow(Math.max(0, Math.cos(angle + flake.phase)), 18);
        const distance = Math.hypot(flake.u - spotU, flake.v - spotV);
        const opacity = maskAt(flake.u, flake.v) * alignment * strength * (0.13 + Math.exp(-distance * distance * 9) * 0.87);
        if (opacity < 0.08) continue;
        ctx.globalAlpha = opacity;
        ctx.fillStyle = `hsl(${Math.round((flake.hue + phase) * 360)}, 80%, 88%)`;
        ctx.fillRect(flake.u * width, flake.v * height, flake.size, flake.size * 1.7);
      }
      if (cosmos) {
        for (const star of stars) {
          const brightness = 0.2 + Math.pow(Math.max(0, Math.cos(angle * 0.5 + star.phase)), 10) * 0.8;
          ctx.globalAlpha = maskAt(star.u, star.v) * strength * brightness;
          ctx.fillStyle = '#f7fcff';
          const x = star.u * width;
          const y = star.v * height;
          const size = star.size * Math.max(width, height) / 1000;
          ctx.beginPath();
          ctx.moveTo(x, y - size * 2);
          ctx.lineTo(x + size * 0.24, y - size * 0.24);
          ctx.lineTo(x + size, y);
          ctx.lineTo(x + size * 0.24, y + size * 0.24);
          ctx.lineTo(x, y + size * 2);
          ctx.lineTo(x - size * 0.24, y + size * 0.24);
          ctx.lineTo(x - size, y);
          ctx.lineTo(x - size * 0.24, y - size * 0.24);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.restore();
      return canvas;
    }
    return {width, height, render};
  }

  function createController(runtime) {
    let active = null;
    let revision = 0;
    let finish = 'Original print';
    let strength = 0.8;

    function applyVariant() {
      if (!active) return;
      active.viewer.variantName = finish === 'Original print' || strength === 0 ? 'Original print' : 'Rainbow foil';
      active.material?.setIridescenceFactor(active.iridescence * strength);
    }

    function dispose() {
      revision++;
      if (!active) return;
      active.abort.abort();
      runtime.clearTimeout(active.timer);
      active.viewer.removeEventListener('camera-change', active.schedule);
      runtime.document.removeEventListener('visibilitychange', active.schedule);
      active.observer?.disconnect();
      active.rotationObserver?.disconnect();
      active = null;
    }

    async function attach(viewer, item) {
      dispose();
      const generation = revision;
      const state = active = {viewer, abort: new runtime.AbortController(), visible: true, timer: null, lastFrame: -Infinity};
      const current = () => active === state && generation === revision;
      const visible = () => !runtime.document.hidden && state.visible && viewer.isConnected !== false && viewer.getClientRects().length > 0;
      const orbit = () => {
        const camera = viewer.getCameraOrbit();
        return {theta: camera.theta - (Number(viewer.turntableRotation) || 0), phi: camera.phi};
      };
      state.schedule = () => {
        if (!current() || !state.renderer || finish === 'Original print' || strength === 0 || !visible() || state.timer != null) return;
        state.timer = runtime.setTimeout(() => {
          state.timer = null;
          if (!current() || finish === 'Original print' || strength === 0 || !visible()) return;
          state.renderer.render(state.texture.source.element, orbit(), finish, strength, true);
          state.texture.source.update();
          state.lastFrame = runtime.performance.now();
          if (viewer.autoRotate) state.schedule();
        }, Math.max(0, 50 - (runtime.performance.now() - state.lastFrame)));
      };
      try {
        const response = await runtime.fetch(viewer.src || item.glb, {signal: state.abort.signal});
        if (!response.ok) throw new Error(`Could not load foil print (${response.status}).`);
        const parsed = parseGlb(await response.arrayBuffer());
        if (!current()) return false;
        const material = viewer.model.materials.find(candidate => candidate.name === parsed.foilMaterialName);
        if (!material) throw new Error('The loaded viewer does not contain the GLB foil material.');
        await material.ensureLoaded();
        if (!current()) return false;
        state.material = material;
        state.iridescence = parsed.foilIridescenceFactor;
        const bitmap = await runtime.createImageBitmap(parsed.image);
        if (!current()) { bitmap.close?.(); return false; }
        state.renderer = createPrintRenderer(bitmap, (width, height) => {
          const canvas = runtime.document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          return canvas;
        }, item.appearance);
        bitmap.close?.();
        state.texture = viewer.createCanvasTexture();
        state.renderer.render(state.texture.source.element, orbit(), finish, strength, true);
        state.texture.source.update();
        material.pbrMetallicRoughness.baseColorTexture.setTexture(state.texture);
        applyVariant();
        state.lastFrame = runtime.performance.now();
        viewer.addEventListener('camera-change', state.schedule);
        runtime.document.addEventListener('visibilitychange', state.schedule);
        if (runtime.IntersectionObserver) {
          state.observer = new runtime.IntersectionObserver(entries => {
            state.visible = entries[0].isIntersecting;
            if (state.visible) state.schedule();
          });
          state.observer.observe(viewer);
        }
        if (runtime.MutationObserver) {
          state.rotationObserver = new runtime.MutationObserver(state.schedule);
          state.rotationObserver.observe(viewer, {attributes: true, attributeFilter: ['auto-rotate']});
        }
        if (viewer.autoRotate) state.schedule();
        return true;
      } catch (error) {
        if (!current() || error.name === 'AbortError') return false;
        dispose();
        throw error;
      }
    }

    function setFinish(value) {
      if (!['Original print', 'Rainbow foil', 'Cosmos foil'].includes(value)) throw new Error(`Unknown foil finish: ${value}`);
      finish = value;
      if (!active) return;
      applyVariant();
      if (finish === 'Original print' || strength === 0) {
        runtime.clearTimeout(active.timer);
        active.timer = null;
      } else active.schedule();
    }

    function setStrength(value) {
      strength = clamp(Number(value) || 0);
      applyVariant();
      if (active && strength === 0) {
        runtime.clearTimeout(active.timer);
        active.timer = null;
      } else active?.schedule();
    }

    return {attach, setFinish, setStrength, dispose};
  }

  root.createStickerFoilController = createController;
  root.StickerFoil = createController(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = {parseGlb, createPrintRenderer, createController};
})(typeof window === 'undefined' ? globalThis : window);
