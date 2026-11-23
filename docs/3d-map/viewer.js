/* AERONEX 3D reconstruction viewer.
 * Plain WebGL 1, no third-party code. Draws the downsampled RTAB-Map point cloud (data/map_points.bin) and the recorded
 * trajectories (data/trajectories.json) exactly where they are in the RTAB-Map map frame. Nothing is generated.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $('status');
  function status(msg, err) { statusEl.textContent = msg; statusEl.className = err ? 'err' : ''; }
  function hideStatus() { statusEl.className = 'hide'; }

  if (location.protocol === 'file:') {
    status('This viewer loads its data over HTTP. Open it through a web server (for example GitHub Pages, or `python3 -m http.server` in the docs folder), not as a local file.', true);
    return;
  }

  var canvas = $('gl');
  var gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true });
  if (!gl) { status('WebGL is not available in this browser, so the 3D map cannot be shown.', true); return; }

  // ------------------------------------------------------------------ small matrix helpers (column-major)
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function lookAt(eye, tgt, up) {
    var z = norm(sub(eye, tgt)), x = norm(cross(up, z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }
  function mul(a, b) {
    var o = new Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      var s = 0; for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
    }
    return o;
  }

  // ------------------------------------------------------------------ shaders
  var MAP_VS = [
    'attribute vec3 aQ; attribute vec3 aN;',
    'uniform mat4 uMVP; uniform vec3 uEye; uniform vec3 uOrigin; uniform float uQuant;',
    'uniform float uSize; uniform float uProj; uniform float uCut; uniform float uFloor; uniform float uTop; uniform float uFog;',
    'varying vec3 vC;',
    'void main(){',
    '  vec3 p = uOrigin + aQ * uQuant;',
    '  if (p.z > uCut) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }',
    '  vec4 c = uMVP * vec4(p, 1.0); gl_Position = c;',
    '  gl_PointSize = clamp(uSize * uProj / max(c.w, 0.05), 1.0, 28.0);',
    '  float t = clamp((p.z - uFloor) / (uTop - uFloor), 0.0, 1.0);',
    // palette ramp #2E343B -> #B8BDC7 -> #F5F7FA
    '  vec3 a = vec3(0.180,0.204,0.231), b = vec3(0.722,0.741,0.780), w = vec3(0.961,0.969,0.980);',
    '  vec3 col = t < 0.6 ? mix(a, b, t / 0.6) : mix(b, w, (t - 0.6) / 0.4);',
    '  if (p.z < uFloor + 0.18) col = vec3(0.235,0.259,0.286);',
    '  vec3 n = aN / 127.0; vec3 L = normalize(vec3(0.35, 0.55, 0.76));',
    '  float sh = 0.58 + 0.42 * abs(dot(normalize(n + 1e-5), L));',
    '  float fog = clamp((length(p - uEye) - uFog) / (uFog * 2.2), 0.0, 0.55);',
    '  vC = mix(col * sh, vec3(0.063,0.067,0.075), fog);',
    '}'].join('\n');
  var MAP_FS = 'precision mediump float; varying vec3 vC; void main(){ gl_FragColor = vec4(vC, 1.0); }';

  var PATH_VS = [
    'attribute vec3 aP; attribute float aS;',
    'uniform mat4 uMVP; uniform float uPx; uniform float uDash; uniform float uCut;',
    'void main(){',
    '  if (uDash > 0.0 && fract(aS / uDash) > 0.62) { gl_Position = vec4(2.0,2.0,2.0,1.0); gl_PointSize = 0.0; return; }',
    '  vec4 c = uMVP * vec4(aP, 1.0); c.z -= 0.0015 * c.w; gl_Position = c; gl_PointSize = uPx;',
    '}'].join('\n');
  var PATH_FS = 'precision mediump float; uniform vec3 uCol; void main(){ vec2 d = gl_PointCoord - 0.5; if (dot(d,d) > 0.25) discard; gl_FragColor = vec4(uCol, 1.0); }';

  function program(vs, fs) {
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) { var nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); }
    return { p: p, u: u };
  }
  var mapProg = program(MAP_VS, MAP_FS), pathProg = program(PATH_VS, PATH_FS);

  // ------------------------------------------------------------------ state
  var meta, N = 0, bufQ, bufN, paths = {};
  var PATH_STYLE = {
    optimised: { el: 'l-opt', col: [0.914, 0.498, 0.133], px: 4.5, dash: 0 },
    odometry: { el: 'l-odo', col: [0.961, 0.969, 0.980], px: 3.2, dash: 0.9 },
    gt: { el: 'l-gt', col: [0.722, 0.741, 0.780], px: 2.6, dash: 0 }
  };
  var FOV = 50 * Math.PI / 180;
  var cam = { tgt: [0, 0, 0], yaw: 0, pitch: 0, dist: 50 };
  var home = null, dirty = true, interacting = 0, turntable = false, lastT = 0, frameMs = 0;
  var stats = { frames: 0, lastDrawn: 0 };

  function eye() {
    var cp = Math.cos(cam.pitch);
    return [cam.tgt[0] + cam.dist * cp * Math.cos(cam.yaw), cam.tgt[1] + cam.dist * cp * Math.sin(cam.yaw), cam.tgt[2] + cam.dist * Math.sin(cam.pitch)];
  }
  function basis() {
    var e = eye(), f = norm(sub(cam.tgt, e)), r = norm(cross(f, [0, 0, 1])), u = cross(r, f);
    return { e: e, f: f, r: r, u: u };
  }
  function setView(v) { cam.tgt = v.tgt.slice(); cam.yaw = v.yaw; cam.pitch = v.pitch; cam.dist = v.dist; dirty = true; }

  // ------------------------------------------------------------------ loading
  function fetchBin(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
      var total = +r.headers.get('Content-Length') || meta.encoding.bytes;
      if (!r.body || !r.body.getReader) return r.arrayBuffer();
      var rd = r.body.getReader(), got = 0, parts = [];
      function pump() {
        return rd.read().then(function (x) {
          if (x.done) {
            var out = new Uint8Array(got), o = 0;
            parts.forEach(function (p) { out.set(p, o); o += p.length; });
            return out.buffer;
          }
          parts.push(x.value); got += x.value.length;
          status('Loading reconstructed map… ' + Math.round(100 * got / total) + ' % of ' + (total / 1e6).toFixed(1) + ' MB');
          return pump();
        });
      }
      return pump();
    });
  }
  function getJSON(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ': HTTP ' + r.status); return r.json(); }); }

  getJSON('data/meta.json').then(function (m) {
    meta = m;
    return Promise.all([fetchBin('data/map_points.bin'), getJSON('data/trajectories.json')]);
  }).then(function (res) {
    var buf = res[0], tr = res[1];
    N = meta.encoding.count;
    if (buf.byteLength !== N * 9) throw new Error('map_points.bin has ' + buf.byteLength + ' bytes, expected ' + N * 9);
    bufQ = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufQ); gl.bufferData(gl.ARRAY_BUFFER, new Int16Array(buf, 0, N * 3), gl.STATIC_DRAW);
    bufN = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufN); gl.bufferData(gl.ARRAY_BUFFER, new Int8Array(buf, N * 6, N * 3), gl.STATIC_DRAW);
    Object.keys(PATH_STYLE).forEach(function (k) {
      var xyz = tr[k].xyz, pts = [], s = 0;
      // dense dots along the recorded polyline (display only: straight segments between recorded poses)
      for (var i = 0; i + 1 < xyz.length; i++) {
        var a = xyz[i], b = xyz[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), n = Math.max(1, Math.ceil(L / 0.035));
        for (var j = 0; j < n; j++) { var t = j / n; pts.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, s + L * t); }
        s += L;
      }
      var last = xyz[xyz.length - 1]; pts.push(last[0], last[1], last[2], s);
      var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
      paths[k] = { buf: b, n: pts.length / 4, poses: xyz.length, length_m: s };
    });
    var bmin = meta.bounds.min, bmax = meta.bounds.max, fl = meta.bounds.floor_z_p5;
    cutSlider.min = Math.round((fl + 0.5) * 10); cutSlider.max = Math.ceil(bmax[2] * 10); cutSlider.value = Math.round((fl + 5.6) * 10);
    // home view: whole map, seen from the south-east, slightly above the racks
    var c = [(bmin[0] + bmax[0]) / 2, (bmin[1] + bmax[1]) / 2, fl + 1.0];
    home = { tgt: c, yaw: -0.92, pitch: 0.62, dist: 0.95 * Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1]) };
    if (window.matchMedia('(max-width: 700px)').matches) setPanel(false);
    reset();
    $('npts').textContent = N.toLocaleString('en') + ' pts';
    $('m-pts').textContent = N.toLocaleString('en');
    updateLabels();
    hideStatus();
    requestAnimationFrame(frame);
  }).catch(function (e) { status('Could not load the map data: ' + e.message, true); console.error(e); });

  // ------------------------------------------------------------------ drawing
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
  }
  function draw() {
    resize();
    var W = canvas.width, H = canvas.height, e = eye();
    var proj = perspective(FOV, W / H, Math.max(0.05, cam.dist * 0.01), cam.dist * 6 + 250);
    var mvp = mul(proj, lookAt(e, cam.tgt, Math.abs(cam.pitch) > 1.5 ? [Math.cos(cam.yaw + Math.PI), Math.sin(cam.yaw + Math.PI), 0] : [0, 0, 1]));
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.063, 0.067, 0.075, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    var cut = cutSlider.value / 10, fl = meta.bounds.floor_z_p5;
    var count = 0;
    if ($('l-map').checked) {
      // while the view is moving on a slow device, draw a uniform prefix (points are stored shuffled)
      count = (interacting && frameMs > 34) ? Math.max(Math.floor(N * 0.35), 150000) : N;
      count = Math.min(count, N);
      gl.useProgram(mapProg.p); var u = mapProg.u;
      gl.uniformMatrix4fv(u.uMVP, false, mvp); gl.uniform3fv(u.uEye, e);
      gl.uniform3fv(u.uOrigin, meta.encoding.origin); gl.uniform1f(u.uQuant, meta.encoding.quant_m);
      gl.uniform1f(u.uSize, meta.downsampling.voxel_m * sizeSlider.value / 100 * 0.85);
      gl.uniform1f(u.uProj, H / (2 * Math.tan(FOV / 2)));
      gl.uniform1f(u.uCut, cut); gl.uniform1f(u.uFloor, fl); gl.uniform1f(u.uTop, fl + 7.5); gl.uniform1f(u.uFog, cam.dist);
      var aQ = gl.getAttribLocation(mapProg.p, 'aQ'), aN = gl.getAttribLocation(mapProg.p, 'aN');
      gl.bindBuffer(gl.ARRAY_BUFFER, bufQ); gl.enableVertexAttribArray(aQ); gl.vertexAttribPointer(aQ, 3, gl.SHORT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufN); gl.enableVertexAttribArray(aN); gl.vertexAttribPointer(aN, 3, gl.BYTE, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disableVertexAttribArray(aQ); gl.disableVertexAttribArray(aN);
    }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    ['gt', 'odometry', 'optimised'].forEach(function (k) {
      var st = PATH_STYLE[k], p = paths[k];
      if (!p || !$(st.el).checked) return;
      gl.useProgram(pathProg.p); var u = pathProg.u;
      gl.uniformMatrix4fv(u.uMVP, false, mvp); gl.uniform1f(u.uPx, st.px * dpr); gl.uniform1f(u.uDash, st.dash); gl.uniform3fv(u.uCol, st.col);
      var aP = gl.getAttribLocation(pathProg.p, 'aP'), aS = gl.getAttribLocation(pathProg.p, 'aS');
      gl.bindBuffer(gl.ARRAY_BUFFER, p.buf);
      gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(aS); gl.vertexAttribPointer(aS, 1, gl.FLOAT, false, 16, 12);
      gl.drawArrays(gl.POINTS, 0, p.n);
      gl.disableVertexAttribArray(aP); gl.disableVertexAttribArray(aS);
    });
    stats.lastDrawn = count; stats.frames++;
    updateScale(H / dpr);
  }
  function frame(t) {
    var dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0; lastT = t;
    if (turntable) { cam.yaw += 0.12 * dt; dirty = true; }
    if (dirty) {
      var t0 = performance.now(); draw(); gl.finish && interacting && gl.finish();
      frameMs = 0.8 * frameMs + 0.2 * (performance.now() - t0); dirty = false;
    }
    requestAnimationFrame(frame);
  }
  var scaleEl = $('scale');
  function updateScale(cssH) {
    var f = cssH / (2 * Math.tan(FOV / 2)), mpp = cam.dist / f, nice = [0.5, 1, 2, 5, 10, 20, 50], len = nice[0];
    for (var i = 0; i < nice.length; i++) if (nice[i] / mpp <= 170) len = nice[i];
    scaleEl.firstChild.style.width = Math.round(len / mpp) + 'px';
    scaleEl.lastChild.textContent = len + ' m at the view centre';
  }

  // ------------------------------------------------------------------ controls
  var cutSlider = $('clip'), sizeSlider = $('size');
  function updateLabels() {
    if (!meta) return;
    $('o-clip').textContent = 'z ≤ ' + (cutSlider.value / 10).toFixed(1) + ' m (' + (cutSlider.value / 10 - meta.bounds.floor_z_p5).toFixed(1) + ' m above floor)';
    $('o-size').textContent = (sizeSlider.value / 100).toFixed(2) + '×';
  }
  [cutSlider, sizeSlider].forEach(function (s) { s.addEventListener('input', function () { updateLabels(); dirty = true; }); });
  ['l-map', 'l-opt', 'l-odo', 'l-gt'].forEach(function (id) { $(id).addEventListener('change', function () { dirty = true; }); });
  function fitDist(d) {  // keep the whole map in frame on narrow (portrait) screens
    var asp = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    return d * Math.max(1, Math.pow(1.6 / Math.max(asp, 0.3), 0.85));
  }
  function reset() { if (home) setView({ tgt: home.tgt, yaw: home.yaw, pitch: home.pitch, dist: fitDist(home.dist) }); }
  function setPanel(open) {
    $('panel').classList.toggle('collapsed', !open);
    $('b-panel').setAttribute('aria-expanded', open ? 'true' : 'false'); $('b-panel').textContent = open ? 'Hide' : 'Show';
  }
  $('b-panel').onclick = function () { setPanel($('panel').classList.contains('collapsed')); };
  function top() { if (home) setView({ tgt: home.tgt, yaw: -Math.PI / 2, pitch: 1.5707, dist: fitDist(home.dist * 1.05) }); }
  function setTurntable(on) { turntable = on; $('b-orbit').setAttribute('aria-pressed', on ? 'true' : 'false'); }
  $('b-reset').onclick = reset; $('b-top').onclick = top; $('b-orbit').onclick = function () { setTurntable(!turntable); };

  function rotate(dx, dy) {
    cam.yaw -= dx * 0.0055; cam.pitch = Math.max(-0.15, Math.min(1.5707, cam.pitch + dy * 0.0055)); dirty = true;
  }
  function pan(dx, dy) {
    var b = basis(), s = cam.dist * 2 * Math.tan(FOV / 2) / canvas.clientHeight;
    for (var i = 0; i < 3; i++) cam.tgt[i] += (-dx * b.r[i] + dy * b.u[i]) * s;
    dirty = true;
  }
  function zoom(factor, cx, cy) {
    var nd = Math.max(1.5, Math.min(400, cam.dist * factor));
    if (cx !== undefined) {
      // keep the point under the cursor (on the plane through the target) roughly fixed
      var b = basis(), h = Math.tan(FOV / 2), asp = canvas.clientWidth / canvas.clientHeight;
      var nx = (cx / canvas.clientWidth) * 2 - 1, ny = 1 - (cy / canvas.clientHeight) * 2;
      var off = cam.dist * (1 - nd / cam.dist);
      for (var i = 0; i < 3; i++) cam.tgt[i] += (b.r[i] * nx * h * asp + b.u[i] * ny * h) * off;
    }
    cam.dist = nd; dirty = true;
  }

  var ptrs = new Map(), mode = null, pinch0 = 0, mid0 = null;
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture(e.pointerId); canvas.focus();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setTurntable(false); interacting = 1; canvas.classList.add('drag');
    if (ptrs.size === 2) {
      var p = Array.from(ptrs.values()); pinch0 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); mid0 = [(p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2]; mode = 'pinch';
    } else mode = (e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey) ? 'pan' : 'rotate';
  });
  canvas.addEventListener('pointermove', function (e) {
    var q = ptrs.get(e.pointerId); if (!q) return;
    var dx = e.clientX - q.x, dy = e.clientY - q.y; q.x = e.clientX; q.y = e.clientY;
    if (mode === 'pinch' && ptrs.size === 2) {
      var p = Array.from(ptrs.values()), d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), m = [(p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2];
      if (pinch0 > 0 && d > 0) zoom(pinch0 / d); pinch0 = d;
      pan(m[0] - mid0[0], m[1] - mid0[1]); mid0 = m;
    } else if (mode === 'pan') pan(dx, dy);
    else if (mode === 'rotate') rotate(dx, dy);
  });
  function up(e) {
    ptrs.delete(e.pointerId);
    if (ptrs.size === 0) { mode = null; interacting = 0; canvas.classList.remove('drag'); dirty = true; }
    else if (ptrs.size === 1) mode = 'rotate';
  }
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault(); setTurntable(false);
    var dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    var r = canvas.getBoundingClientRect();
    zoom(Math.exp(Math.max(-200, Math.min(200, dy)) * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  window.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'SUMMARY')) return;
    var k = e.key, used = true;
    if (k === 'ArrowLeft') rotate(-25, 0); else if (k === 'ArrowRight') rotate(25, 0);
    else if (k === 'ArrowUp') rotate(0, 18); else if (k === 'ArrowDown') rotate(0, -18);
    else if (k === '+' || k === '=') zoom(0.85); else if (k === '-' || k === '_') zoom(1 / 0.85);
    else if (k === 'r' || k === 'R') reset(); else if (k === 't' || k === 'T') top();
    else if (k === 'o' || k === 'O') setTurntable(!turntable);
    else used = false;
    if (used) { e.preventDefault(); setTurntable(k === 'o' || k === 'O' ? turntable : false); }
  });
  window.addEventListener('resize', function () { dirty = true; });
  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); status('The graphics context was lost. Reload the page to continue.', true); });

  // read-only hooks for automated checks
  window.AERONEX_VIEWER = {
    camera: function () { return { tgt: cam.tgt.slice(), yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist }; },
    stats: function () { return { points: N, drawn: stats.lastDrawn, frames: stats.frames, frameMs: frameMs, paths: Object.keys(paths).map(function (k) { return { id: k, poses: paths[k].poses, length_m: paths[k].length_m }; }) }; },
    ready: function () { return !!home; }
  };
})();
