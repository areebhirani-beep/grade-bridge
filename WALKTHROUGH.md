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
| `lut.ts` | `buildLut` runs `applyGrade` on a 33x33x33 grid of colors and stores the answers. `sampleLut` looks a color up in that grid. `mixWithIdentity` blends a LUT toward "no change" for Intensity. | The grid is the LUT. Editors only ever see the grid, never our math. |
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
| `src/web/main.ts` | The app's wiring: the upload screen, slider moves, LUT rebuilds, video playback, the look strip, compare modes, exports. |
| `src/web/renderer.ts` | WebGL2 preview. It uploads the LUT as a 3D texture and the GPU looks each pixel up in it, then mixes by Intensity. Also renders the full-resolution still. |
| `src/web/frame.ts` | Grabs a small copy of the current frame and grades it on the CPU through a LUT. The look thumbnails and the scopes both use it. |
| `src/web/scopes.ts` | The scope math (waveform, parade, vectorscope binning), with no drawing, so it can be tested. |
| `src/web/scopeview.ts` | Draws the scopes and their scales on a canvas. |
| `src/web/panel.ts` | Draws the sliders from whatever adapter is selected, including the drag-to-scrub number fields. It has no app-specific code. |
| `src/web/share.ts` | Puts the grade in the URL so a look can be shared as a link. |
| `src/cli.ts` | `grade-bridge export preset.json -o look.cube`. |
| `presets/*.json` | Six looks written as slider values. |
| `scripts/verify-ffmpeg.ts` | The proof: ffmpeg applies our `.cube` and we compare against our own math. |
| `scripts/test-chart.ts` | The test pattern used by the app and by verify. |
| `tests/` | 78 automated checks (`npm test`). `web.test.ts` covers Intensity and the scopes. |

## The color math, simply

**sRGB vs linear.** Pixel values in a file are not proportional to light. A pixel value of 0.5 is only about 21% of the light of 1.0, because files are encoded to match how eyes see. That encoding is sRGB. "Linear" means the numbers are converted back to actual amounts of light. One stop of exposure means twice the light, so exposure has to happen in linear, where doubling the number really doubles the light. That's why the pipeline converts to linear for exposure and white balance and then converts back.

**Why order matters.** Do contrast and then saturation, and you get a different picture than doing saturation and then contrast, because each step changes what the next one sees. The order here follows what colorists do: fix the light first (exposure, white balance), then the tone (contrast, highlights, shadows), then the color (saturation, tints), then the finishing curves. The order is fixed in `pipeline.ts` so the same slider values always give the same LUT.

**What a LUT actually is.** It is a lookup table. The program asks "for every possible input color, what's the output?" It can't store all 16 million colors, so it stores a 33x33x33 grid (35,937 colors), and the editor blends the 8 nearest grid points for anything in between. The blending adds a tiny error, and storing the result as 8-bit adds about half a level of rounding. That's why the ffmpeg results are off by about half a level: it's rounding, not a bug.

**The honest limit to say out loud.** A LUT only knows "this color in, that color out." It doesn't know where a pixel is or what's next to it. So it can carry exposure, contrast, curves, saturation and tints. It cannot carry blur, glow, grain, sharpening, vignettes, chroma key or transitions, because each of those depends on neighbouring pixels or on time. In Flick's terms: most of the Color group (Color & Light, Split Tone) can travel; Chroma Key and everything in Blur & Glow, Stylize and Distort cannot.

## Intensity, in plain words

Intensity is how much of the look you keep. At 100% you get the full grade, at 0% the original, and at 60% each pixel lands 60% of the way from the original color to the graded color.

The preview does that blend on the GPU for every pixel. The export has to give the same answer inside Resolve or Premiere, which only know how to read a LUT. So the export blends the LUT itself: every stored output color moves 60% of the way from its own input color (the "do nothing" answer) toward the graded answer. An editor blends the 8 nearest stored colors for each pixel, and blending is a straight-line operation, so blending first and looking up second gives exactly the same result as looking up first and blending second. `tests/web.test.ts` checks this on 4,000 random colors at 0, 25, 60 and 100%, and checks that it survives being written to a `.cube` and read back. In the browser, the shader blend and the pre-blended LUT agree within 1 level out of 255. The file's title says "Mixed at 60% intensity" so nobody loads it and wonders why it looks weaker than the preset.

## The scopes, in plain words

Colorists don't trust their eyes alone, because eyes adapt and monitors lie. Scopes are graphs of the actual pixel values. All three here are drawn from the graded frame, not the original.

- **Waveform.** Left to right is the picture, left to right. Up and down is brightness: 0 at the bottom is pure black, 100 at the top is pure white. A bright sky makes a band near the top, a dark foreground a band near the bottom. If the trace is squashed flat against 100, the highlights are clipped and that detail is gone. Brightness here is "luma", which weights green most and blue least (Rec.709), because that matches how bright each color looks.
- **Parade.** The same graph three times, once each for red, green and blue. A neutral grey or white has all three at the same height. If the blue one sits lower everywhere, the image has a warm cast. This is how you check that a "teal and orange" grade really pushed the shadows toward teal.
- **Vectorscope.** A color wheel. The center is no color (greys), and the further a dot is from the center, the more saturated that pixel is. The angle is the hue. The boxes mark where pure red, magenta, blue, cyan, green and yellow at 75% land. The dashed line is the skin-tone line: skin of every complexion falls near it, so if faces drift off it after a grade, the skin looks sick.

How they are built: the app takes a 640x360 copy of the frame, grades it on the CPU through the same LUT as the preview, and counts pixels into bins. The waveform uses 128 brightness bins (about 0.8 of a unit each). The counting is unit tested: a grey ramp has to draw a diagonal line from 0 to 100, pure green has to read at 71.5% and pure blue at 7.2%, greys have to sit at the center of the vectorscope, the color-bar targets have to land in the standard order, and the test chart's skin swatches have to fall within 15 degrees of the skin-tone line.

## Why the interface is grey

The app's chrome is neutral grey with no color tint, because a tinted interface shifts how you judge the color of the picture next to it. That is why most grading and compositing tools use grey interfaces. One amber accent marks what is active (the selected look, a changed value, the playhead) and nothing else.

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
You don't have to. The core is about 500 lines with 78 tests and a reproducible ffmpeg check that anyone can run with `npm run verify`. It's MIT licensed, so you can read all of it, change it, or just take the idea.

**9. "Your users pick a look at partial strength. Does the export keep that?"**
Yes. Intensity is baked into the `.cube`, so a look at 60% in the app is the same look at 60% in Premiere, and the file's title says so. The math is a blend of the LUT toward "no change", which gives the same result as blending the pictures (tested, and measured within 1 level in the browser). If Flick has its own strength slider, it maps onto this directly.

**10. "Are the scopes real, or decoration?"**
They are real counts of the graded pixels, on a 640x360 copy of the frame. The waveform runs 0 to 100 for code values 0 to 255, the vectorscope has the 75% color-bar boxes and the skin-tone line, and the binning is unit tested against known inputs. The limit to say out loud: they read a downscaled copy, so a single bright pixel can be missed, and they are not a replacement for scopes on a calibrated full-resolution signal.
