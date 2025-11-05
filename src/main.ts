// src/main.ts
import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";

// expose PIXI globally (per plugin docs)
;(window as any).PIXI = PIXI;

const canvas = document.getElementById("stage") as HTMLCanvasElement;

const app = new PIXI.Application({
  view: canvas,
  resizeTo: window,
  backgroundAlpha: 0,
  antialias: true,
});

let model: any = null;

// --- helpers --------------------------------------------------------------

const nextFrame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

function screen() {
  return { w: app.renderer.screen.width, h: app.renderer.screen.height };
}

/**
 * Clamp the model until its visual size fits inside the screen (with margin)
 */
async function clampFit({
  margin = 0.75,          // smaller = more padding (try 0.7–0.8)
  maxIters = 40,
  shrinkFactor = 0.8,     // shrink 20% per iteration
  minScale = 0.05,
  bottomPadPx = 32,
} = {}) {
  if (!model) return;

  model.anchor.set(0.5, 0.5);
  model.scale.set(1);

  const { w: sw, h: sh } = screen();

  model.position.set(sw / 2, sh / 2);
  await nextFrame();

  // shrink until contained
  let s = model.scale.x;
  for (let i = 0; i < maxIters; i++) {
    await nextFrame();
    const mw = model.width;
    const mh = model.height;

    const fits = mw <= sw * margin && mh <= sh * margin;
    if (fits) break;

    s = Math.max(minScale, s * shrinkFactor);
    model.scale.set(s);
  }

  // bottom-center placement
  await nextFrame();
  const mw2 = model.width;
  const mh2 = model.height;

  const x = sw / 2;
  const y = sh - mh2 / 2 - bottomPadPx;
  model.position.set(x, Math.max(mh2 / 2 + bottomPadPx, y));
}

// --- main ---------------------------------------------------------------

(async () => {
  // make sure index.html loads live2dcubismcore.min.js first
  model = await Live2DModel.from("/models/MO.v2.6.2/MO.model3.json");

  app.stage.addChild(model);

  // fit to screen
  await clampFit({ margin: 0.72, maxIters: 50, shrinkFactor: 0.85, bottomPadPx: 32 });

  // gentle idle sway
  app.ticker.add(() => {
    if (!model) return;
    const t = performance.now() * 0.001;
    model.internalModel.coreModel.setParameterValueById(
      "ParamAngleZ",
      Math.sin(t) * 5
    );
  });

  // resize responsiveness
  addEventListener("resize", () => {
    clampFit({ margin: 0.72, maxIters: 50, shrinkFactor: 0.85, bottomPadPx: 32 });
  });
})();

// handy debug helpers
;(window as any).clampFit = clampFit;
;(window as any).setScale = (s: number) => model && model.scale.set(s);
;(window as any).setPos = (x: number, y: number) => model && model.position.set(x, y);

