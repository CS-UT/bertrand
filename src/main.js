import { render } from 'katex';
import './styles.css';

window.addEventListener("DOMContentLoaded", () => {
      // =========================
      // Config
      // =========================
      const R = 1;
      const rSmall = R / 2;

      // Threshold in units of radius (works for both big circle and (Lin/r) normalization)
      const THRESH = Math.sqrt(3);

      const NUM_BINS = 60;

      // Performance: draw only a subset if N is huge
      const MAX_DRAW_CHORDS = 1000;

      // Canvas CSS sizes (px)
      const CIRCLE_CANVAS_SIZE = 280;
      const HIST_CANVAS_W = 280;
      const HIST_CANVAS_H = 150;

      const TWO_PI = Math.PI * 2;

      // Inner circle center (shifted to the right)
      // 0.5*R => tangent to big circle on the right
      const INNER_CIRCLE_OFFSET = 0.5 * R;
      const innerCx = INNER_CIRCLE_OFFSET;
      const innerCy = 0;

      let cached = null;

      // =========================
      // KaTeX render
      // =========================
      function renderTex(root = document) {
        if (!render) return;
        root.querySelectorAll(".tex").forEach(el => {
          if (el.dataset.rendered === "1") return;
          const tex = el.getAttribute("data-tex") || el.textContent || "";
          try{
            render(tex, el, { throwOnError: false, displayMode: false });
            el.dataset.rendered = "1";
          }catch {
            // keep fallback text
          }
        });
      }

      // =========================
      // Helpers
      // =========================
      function randAngle(){ return Math.random() * TWO_PI; }
      function hypot(dx, dy){ return Math.sqrt(dx*dx + dy*dy); }

      function setupHiDPICanvas(canvas, cssW, cssH){
        const dpr = window.devicePixelRatio || 1;
        canvas.style.width = cssW + "px";
        canvas.style.height = cssH + "px";
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return ctx;
      }

      function mapToCanvas(x, y, cx, cy, scale){
        return { X: cx + x * scale, Y: cy - y * scale };
      }

      function fmt(num, digits=4){ return Number(num).toFixed(digits); }

      function colors(){
        const cs = getComputedStyle(document.documentElement);
        const g = (name) => cs.getPropertyValue(name).trim();
        return {
          canvasBg: g("--canvas-bg"),
          canvasStroke: g("--canvas-stroke"),
          chordShort: g("--chord-short"),
          chordLong: g("--chord-long"),
          danger: g("--danger"),
          histBar: g("--hist-bar"),
          histFrame: g("--hist-frame"),
          tick: g("--tick"),
        };
      }

      // Fix bidi on canvas tick labels
      const LRI = "\u2066";
      const PDI = "\u2069";
      const ltrIso = (s) => LRI + s + PDI;

      // =========================
      // Geometry: segment length inside a circle
      // =========================
      function segmentLengthInsideCircle(x1,y1,x2,y2, cx,cy, r){
        const dx = x2 - x1;
        const dy = y2 - y1;

        const fx = x1 - cx;
        const fy = y1 - cy;

        const a = dx*dx + dy*dy;
        if (a === 0) return 0;

        const b = 2 * (fx*dx + fy*dy);
        const c = (fx*fx + fy*fy) - r*r;

        const disc = b*b - 4*a*c;

        // No intersection with infinite line
        if (disc < 0){
          const inside1 = (fx*fx + fy*fy) <= r*r;
          const inside2 = ((x2-cx)*(x2-cx) + (y2-cy)*(y2-cy)) <= r*r;
          return (inside1 && inside2) ? Math.sqrt(a) : 0;
        }

        const s = Math.sqrt(disc);
        let t1 = (-b - s) / (2*a);
        let t2 = (-b + s) / (2*a);
        if (t1 > t2){ const tmp = t1; t1 = t2; t2 = tmp; }

        const tStart = Math.max(t1, 0);
        const tEnd   = Math.min(t2, 1);

        const len = (tEnd - tStart) * Math.sqrt(a);
        return Math.max(0, len);
      }

      // =========================
      // Chord generators
      // =========================
      function chordMethod1(){
        const a = randAngle(), b = randAngle();
        const x1 = Math.cos(a), y1 = Math.sin(a);
        const x2 = Math.cos(b), y2 = Math.sin(b);
        const length = hypot(x1 - x2, y1 - y2);
        return { x1, y1, x2, y2, length };
      }

      function chordMethod2(){
        const u = Math.random();
        const r = Math.sqrt(u) * R;
        const t = randAngle();
        const mx = r * Math.cos(t);
        const my = r * Math.sin(t);

        const px = -Math.sin(t), py = Math.cos(t);
        const half = Math.sqrt(R*R - r*r);

        const x1 = mx + px * half, y1 = my + py * half;
        const x2 = mx - px * half, y2 = my - py * half;
        const length = 2 * half;

        return { x1, y1, x2, y2, length };
      }

      function chordMethod3(){
        const t = randAngle();
        const d = (Math.random()*2 - 1) * R;

        const mx = d * Math.cos(t);
        const my = d * Math.sin(t);

        const px = -Math.sin(t), py = Math.cos(t);
        const half = Math.sqrt(R*R - d*d);

        const x1 = mx + px * half, y1 = my + py * half;
        const x2 = mx - px * half, y2 = my - py * half;
        const length = 2 * half;

        return { x1, y1, x2, y2, length };
      }

      // =========================
      // Simulation (two histograms, + inner stats)
      // =========================
      function simulate(methodFn, N){
        const binsMain = new Array(NUM_BINS).fill(0);   // chord length in big circle (0..2R)
        const binsInner = new Array(NUM_BINS).fill(0);  // (Lin/rSmall) for HIT chords only (0..2)

        let aboveMain = 0;

        let hitInner = 0;        // number of chords with Lin>0
        let aboveInner = 0;      // number of hit chords with (Lin/rSmall) > sqrt(3)

        const drawN = Math.min(N, MAX_DRAW_CHORDS);
        const chordsToDraw = [];

        const EPS = 1e-12;

        for (let i = 0; i < N; i++){
          const chord = methodFn();
          const L = chord.length;

          // main probability/hist
          if (L > THRESH) aboveMain++;
          const idxMain = Math.min(NUM_BINS - 1, Math.floor((L / (2*R)) * NUM_BINS));
          binsMain[idxMain]++;

          // inner segment length
          const Lin = segmentLengthInsideCircle(
            chord.x1, chord.y1, chord.x2, chord.y2,
            innerCx, innerCy, rSmall
          );

          // ✅ Only count HIT chords (avoid fake spike at 0)
          if (Lin > EPS){
            hitInner++;

            const norm = Lin / rSmall; // 0..2
            if (norm > THRESH) aboveInner++;

            const normClamped = Math.max(0, Math.min(2, norm));
            const idxInner = Math.min(NUM_BINS - 1, Math.floor((normClamped / 2) * NUM_BINS));
            binsInner[idxInner]++;
          }

          // for drawing
          if (i < drawN){
            chordsToDraw.push({ ...chord, isLong: (L > THRESH) });
          }
        }

        return { binsMain, binsInner, aboveMain, hitInner, aboveInner, chordsToDraw, drawN };
      }

      // =========================
      // Drawing
      // =========================
      function drawCircleAndChords(canvas, chords){
        const ctx = setupHiDPICanvas(canvas, CIRCLE_CANVAS_SIZE, CIRCLE_CANVAS_SIZE);
        const w = CIRCLE_CANVAS_SIZE, h = CIRCLE_CANVAS_SIZE;
        const col = colors();

        const cx = w/2, cy = h/2;
        const scale = Math.min(w, h) * 0.45;

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = col.canvasBg;
        ctx.fillRect(0, 0, w, h);

        ctx.lineWidth = 1;
        for (const ch of chords){
          ctx.strokeStyle = ch.isLong ? col.chordLong : col.chordShort;
          const p1 = mapToCanvas(ch.x1, ch.y1, cx, cy, scale);
          const p2 = mapToCanvas(ch.x2, ch.y2, cx, cy, scale);
          ctx.beginPath();
          ctx.moveTo(p1.X, p1.Y);
          ctx.lineTo(p2.X, p2.Y);
          ctx.stroke();
        }

        // outer circle
        ctx.strokeStyle = col.canvasStroke;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, scale * R, 0, TWO_PI);
        ctx.stroke();

        // inner circle (shifted right)
        ctx.strokeStyle = col.danger;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx + scale * innerCx, cy - scale * innerCy, scale * rSmall, 0, TWO_PI);
        ctx.stroke();
      }

      function drawHistogram(canvas, bins){
        const ctx = setupHiDPICanvas(canvas, HIST_CANVAS_W, HIST_CANVAS_H);
        const w = HIST_CANVAS_W, h = HIST_CANVAS_H;
        const col = colors();

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = col.canvasBg;
        ctx.fillRect(0, 0, w, h);

        const marginL = 18, marginR = 10, marginT = 10, marginB = 28;
        const plotW = w - marginL - marginR;
        const plotH = h - marginT - marginB;

        ctx.strokeStyle = col.histFrame;
        ctx.lineWidth = 1;
        ctx.strokeRect(marginL, marginT, plotW, plotH);

        const maxCount = Math.max(...bins, 1);
        const barW = plotW / bins.length;

        ctx.fillStyle = col.histBar;
        for (let i = 0; i < bins.length; i++){
          const c = bins[i];
          const barH = (c / maxCount) * plotH;
          const x = marginL + i * barW;
          const y = marginT + (plotH - barH);
          ctx.fillRect(x, y, barW, barH);
        }

        // threshold line at √3 (axis always 0..2)
        const xThr = marginL + (THRESH / 2) * plotW;
        ctx.strokeStyle = col.danger;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(xThr, marginT);
        ctx.lineTo(xThr, marginT + plotH);
        ctx.stroke();

        // LTR labels on canvas
        if ("direction" in ctx) ctx.direction = "ltr";

        ctx.font = '12px KaTeX_Main, "Cambria Math", "STIX Two Math", "BYekan", Tahoma, Arial, sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";

        function tick(val, label, color){
          const x = marginL + (val / 2) * plotW;
          const y0 = marginT + plotH;

          ctx.strokeStyle = col.tick;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y0);
          ctx.lineTo(x, y0 + 5);
          ctx.stroke();

          ctx.fillStyle = color;
          ctx.fillText(label, x, h - 10);
        }

        tick(0,       ltrIso("0"),   col.canvasStroke);
        tick(1,       ltrIso("1"),   col.canvasStroke);
        tick(THRESH,  ltrIso("√3"),  col.danger);
        tick(2,       ltrIso("2"),   col.canvasStroke);
      }

      // =========================
      // UI + render
      // =========================
      const nInput = document.getElementById("nInput");
      const goBtn = document.getElementById("goBtn");

      const canv = {
        c1: document.getElementById("c1"),
        c2: document.getElementById("c2"),
        c3: document.getElementById("c3"),
        h1: document.getElementById("h1"),
        h2: document.getElementById("h2"),
        h3: document.getElementById("h3"),
        h1i: document.getElementById("h1i"),
        h2i: document.getElementById("h2i"),
        h3i: document.getElementById("h3i"),
      };

      const stats = {
        s1: document.getElementById("s1"),
        s2: document.getElementById("s2"),
        s3: document.getElementById("s3"),
      };

      function computeAll(N){
        const r1 = simulate(chordMethod1, N);
        const r2 = simulate(chordMethod2, N);
        const r3 = simulate(chordMethod3, N);
        return { N, r1, r2, r3 };
      }

      function setStats(el, N, theoFracTex, pMain, hitInner, aboveInner){
        const pInner = (hitInner > 0) ? (aboveInner / hitInner) : NaN;

        const hitFa = hitInner.toLocaleString("fa-IR");
        const aboveFa = aboveInner.toLocaleString("fa-IR");
        const NFa = N.toLocaleString("fa-IR");

        el.innerHTML = `
          <div class="statsRow">
            <span class="statItem">
              <span class="statLabel">احتمال تئوری:</span>
              <bdi dir="ltr" class="math" style="color:inherit;font-weight:700">
                <span class="tex" data-tex="${theoFracTex}">theory</span>
              </bdi>
            </span>
            <span class="statItem">
              <span class="statLabel">احتمال تجربی (دایره اصلی):</span>
              <bdi dir="ltr" class="math" style="color:inherit;font-weight:700">
                <span class="tex" data-tex="P(L > \\sqrt{3}R) \\approx ${fmt(pMain,4)}">P(L &gt; √3R) ≈ ${fmt(pMain,4)}</span>
              </bdi>
            </span>
          </div>

          <div class="statsRow statsRowInner">
            <span class="statItem">
              <span class="statLabel">برخورد با دایره داخلی:</span>
              <span class="ltr">${hitFa} از ${NFa}</span>
            </span>

            <span class="statItem">
              <span class="statLabel">بیشتر از</span>
              <bdi dir="ltr" class="math" style="color:inherit;font-weight:700">
                <span class="tex" data-tex="\\sqrt{3}">√3</span>
              </bdi>
              <span class="statLabel">:</span>
              <span class="ltr">${aboveFa}</span>
            </span>

            <span class="statItem">
              <span class="statLabel">احتمال تجربی (دایره داخلی):</span>
              <bdi dir="ltr" class="math" style="color:inherit;font-weight:700">
                <span class="tex" data-tex="${
                  (hitInner>0)
                    ? `P\\left(\\frac{L_{in}}{r} > \\sqrt{3}\\right) \\approx ${fmt(pInner,4)}`
                    : `P\\left(\\frac{L_{in}}{r} > \\sqrt{3}\\right) \\approx \\text{undefined}`
                }">P(Lin/r &gt; √3) ≈ ${hitInner>0 ? fmt(pInner,4) : "—"}</span>
              </bdi>
            </span>
          </div>
        `;

        renderTex(el);
      }

      function drawAll(res){
        const { N, r1, r2, r3 } = res;

        drawCircleAndChords(canv.c1, r1.chordsToDraw);
        drawHistogram(canv.h1, r1.binsMain);
        drawHistogram(canv.h1i, r1.binsInner);

        drawCircleAndChords(canv.c2, r2.chordsToDraw);
        drawHistogram(canv.h2, r2.binsMain);
        drawHistogram(canv.h2i, r2.binsInner);

        drawCircleAndChords(canv.c3, r3.chordsToDraw);
        drawHistogram(canv.h3, r3.binsMain);
        drawHistogram(canv.h3i, r3.binsInner);

        const p1 = r1.aboveMain / N;
        const p2 = r2.aboveMain / N;
        const p3 = r3.aboveMain / N;

        setStats(stats.s1, N, "\\frac{1}{3}", p1, r1.hitInner, r1.aboveInner);
        setStats(stats.s2, N, "\\frac{1}{4}", p2, r2.hitInner, r2.aboveInner);
        setStats(stats.s3, N, "\\frac{1}{2}", p3, r3.hitInner, r3.aboveInner);
      }

      function renderAll(){
        const N = parseInt(nInput.value, 10);
        if (!Number.isFinite(N) || N < 1){
          alert("لطفاً یک عدد صحیحِ معتبر (N ≥ 1) وارد کن.");
          return;
        }
        cached = computeAll(N);
        drawAll(cached);
      }

      goBtn.addEventListener("click", renderAll);
      nInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") renderAll();
      });

      // Init
      renderAll();

      // If fonts load late, redraw WITHOUT resimulating
      if (document.fonts && document.fonts.ready){
        document.fonts.ready.then(() => {
          if (cached) drawAll(cached);
        });
      }
    });
