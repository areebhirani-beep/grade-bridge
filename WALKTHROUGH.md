# Walkthrough

This is the version of the project you can explain on a call. It covers what each file does, the color math in plain terms, how to add an app, and the questions you are likely to get.

## The problem in one breath

Flick's export docs say: "Effects and grades cannot travel in these project files." The XML that Premiere and Resolve import has no standard place for a color grade. A 3D LUT is the one color format every editor reads, so grade-bridge turns the grade into a LUT.

## What each file does

### `src/core/`: the engine (no UI, no app names)

| File | What it does | Why it exists |
| --- | --- | --- |
| `params.ts` | Defines `GradeParams`, the list of numbers that describes a grade (exposure, contrast, curves...), plus the "do nothing" defaults. | Every app's sliders get translated into this one shape, so the math only has to be written once. |
| `pipeline.ts` | `applyGrade(color, params)` takes one color in and returns the graded color. | This is the actual color math. It is a pure function: same input, same output. |
| `curve.ts` | Monotone cubic spline for curves. | A normal smooth curve can bulge past your points and reverse tones. This kind cannot. |
| `lut.ts` | `buildLut` runs `applyGrade` on a 33x33x33 grid of colors and stores the answers. `sampleLut` looks a color up in that grid. | The grid is the LUT. Editors only ever see the grid, never our math. |
| `cube.ts` | Writes and reads the `.cube` text format. | This is the file you hand to Resolve or Premiere. |

### `src/adapters/`: one file per app

| File | What it does |
| --- | --- |
| `types.ts` | The `Adapter` shape: an id, a name, a list of controls (label, section, min, max, default) and `toParams()`. |
| `flick.ts` | Flick-style controls. The section names (Light, Color, Curves, Split Tone) come from Flick's docs. The slider names inside each section are guesses because the docs don't list them. |
| `generic.ts` | Lightroom-style names (Temp, Tint, Exposure, Whites, Blacks...). |
| `primaries.ts` | Lift/gamma/gain, the way colorists work. Proves the same engine fits a very different set of controls. |
| `helpers.ts` | Three small conversions the adapters share. |
| `index.ts` | The list of adapters, and the code that turns a preset JSON into params. |

### Everything else

| Path | What it does |
| --- | --- |
| `src/web/main.ts` | The app's wiring: slider moves, LUT rebuilds, preview redraws, Export downloads the same LUT. |
| `src/web/renderer.ts` | WebGL2 preview. It uploads the LUT as a 3D texture and the GPU looks each pixel up in it. |
| `src/web/panel.ts` | Draws the sliders from whatever adapter is selected. It has no app-specific code. |
| `src/web/share.ts` | Puts the grade in the URL so a look can be shared as a link. |
| `src/cli.ts` | `grade-bridge export preset.json -o look.cube`. |
| `presets/*.json` | Six looks written as slider values. |
| `scripts/verify-ffmpeg.ts` | The proof: ffmpeg applies our `.cube` and we compare against our own math. |
| `scripts/test-chart.ts` | The test pattern used by the app and by verify. |
| `tests/` | 61 automated checks (`npm test`). |

## The color math, simply

**sRGB vs linear.** Pixel values in a file are not proportional to light. A pixel value of 0.5 is only about 21% of the light of 1.0, because files are encoded to match how eyes see. That encoding is sRGB. "Linear" means the numbers are converted back to actual amounts of light. One stop of exposure means twice the light, so exposure has to happen in linear, where doubling the number really doubles the light. That's why the pipeline converts to linear for exposure and white balance and then converts back.

**Why order matters.** Do contrast and then saturation, and you get a different picture than doing saturation and then contrast, because each step changes what the next one sees. The order here follows what colorists do: fix the light first (exposure, white balance), then the tone (contrast, highlights, shadows), then the color (saturation, tints), then the finishing curves. The order is fixed in `pipeline.ts` so the same slider values always give the same LUT.

**What a LUT actually is.** It is a lookup table. The program asks "for every possible input color, what's the output?" It can't store all 16 million colors, so it stores a 33x33x33 grid (35,937 colors), and the editor blends the 8 nearest grid points for anything in between. The blending adds a tiny error, and storing the result as 8-bit adds about half a level of rounding. That's why the ffmpeg results are off by about half a level: it's rounding, not a bug.

**The honest limit to say out loud.** A LUT only knows "this color in, that color out." It doesn't know where a pixel is or what's next to it. So it can carry exposure, contrast, curves, saturation and tints. It cannot carry blur, glow, grain, sharpening, vignettes, chroma key or transitions, because each of those depends on neighbouring pixels or on time. In Flick's terms: most of the Color group (Color & Light, Split Tone) can travel; Chroma Key and everything in Blur & Glow, Stylize and Distort cannot.

## Add an adapter for a new startup in 15 minutes

1. **(3 min)** Open the startup's color panel or docs. Write down each slider, its section, its range and its neutral value.
2. **(5 min)** Copy `src/adapters/generic.ts` to `src/adapters/theirapp.ts`. Change the `id`, the `name` and the `controls` list to match what you wrote down.
3. **(5 min)** Fill in `toParams()`. Most sliders are one line, for example `contrast: 0.6 * pct(v.contrast)`. If they have color wheels, use `liftGammaGainToCdl`.
4. **(1 min)** Add it to `ADAPTERS` in `src/adapters/index.ts`.
5. **(1 min)** Run `npm test`. It checks the new adapter's defaults and ranges. Run `npm run dev` and it appears in the Controls menu.

What you can't do in 15 minutes is match their exact math. For that they either share the formula for each slider, or they skip adapters and pass their own grade function to `buildLut`.

## Questions you might get

**1. "Why not just put the grade in the XML?"**
There is no grade format that Premiere, Final Cut and Resolve all read from a project file, which is why Flick's docs say the grade is left out. Each editor stores grades its own way. A `.cube` LUT is the one color format they all load.

**2. "Will it look exactly like it does in Flick?"**
No. The adapter uses Flick's section names, not Flick's math, so it's close but not identical. Flick could make it exact by running its own color function over the LUT grid. That's about ten lines (shown in the README) and needs nothing from me except this repo.

**3. "How do you know the file is right?"**
`npm run verify` has ffmpeg, a separate program we didn't write, apply the `.cube`. Then it compares against our math. The mean error is about 0.5 out of 255, which is rounding. It also writes a deliberately broken file and confirms the check catches it (35 levels off). I haven't opened the files in Resolve or Premiere yet, and I should say that if asked.

**4. "What about effects like grain or blur?"**
They can't go in a LUT, by definition, because a LUT only sees one pixel's color at a time. Those would need to be rebuilt in the editor, or exported in each editor's own effect format. That's a much bigger, editor-by-editor job.

**5. "What about log or HDR footage?"**
This version assumes normal display footage (sRGB / Rec.709), which is what an AI video app outputs. Log or HDR would need an extra input conversion step. That's a known extension, but it isn't built yet.

**6. "Is 33 points enough? Why not 65?"**
33 is the standard size that most editors and LUT packs use, and here it's within about half a level of the exact math. 65 is supported (`--size 65`) and is finer, but the file is about 8 times bigger (274,625 rows vs 35,937).

**7. "How fast is it? Could it run in our export flow?"**
A 33³ build takes about 3 ms in the browser once warmed up, and 6 to 25 ms on a cold first run. The core has no dependencies and runs in the browser or in Node, so it could run right in their export dialog: "Download .zip" would add a `.cube` next to `timeline.xml`.

**8. "Why should we trust a high school student's code?"**
You don't have to. The core is about 500 lines with 61 tests and a reproducible ffmpeg check that anyone can run with `npm run verify`. It's MIT licensed, so you can read all of it, change it, or just take the idea.
