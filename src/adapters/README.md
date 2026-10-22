# Add an adapter for any app

An adapter is one file that says "this app's sliders mean these GradeParams". Nothing else in grade-bridge changes.

1. Copy `generic.ts` to `src/adapters/myapp.ts` and rename the export (`export const myapp: Adapter = { id: "myapp", ... }`).
2. List the app's controls exactly as the app names them: `key` (stable id), `label` (what the user sees), `group` (the app's panel/section), `min`, `max`, `step`, `default`. The default must be the app's neutral value.
3. Write `toParams(values)`. Start from `makeParams({...})` and set only what the app controls. Useful conversions:
   - A -100..100 slider: `pct(v)` gives -1..1.
   - Exposure in stops goes straight into `exposure`.
   - Lift / gamma / gain wheels: `liftGammaGainToCdl(lift, gamma, gain)` gives the exact CDL `slope/offset/power`.
   - A curve with fixed points: `parametricCurve(xs, nudges, maxShift)`.
4. Register it in `src/adapters/index.ts` (add it to `ADAPTERS`). The UI picker, CLI `--adapter` and share links pick it up automatically.
5. Run `npm test`. The suite already checks every adapter: unique keys, sane ranges, and that all defaults give an identity LUT.
6. Optional: add a `presets/<look>.json` with `"adapter": "myapp"` and run `npm run verify` to see it pass through ffmpeg.

Rules of thumb:
- Match the app's numbers, not ours. If the app's Contrast +100 is gentle, scale it down in `toParams`.
- Only map per-pixel color controls. Blur, grain, sharpen, glow, vignette-by-position and keying cannot live in a LUT, so leave them out and say so.
- Write a mapping test like `tests/flick.test.ts`: move one control, assert which params changed.
