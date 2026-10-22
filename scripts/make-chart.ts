// Writes the app's fallback image. Run: npm run chart
import { makeTestChart } from "./test-chart.ts";
import { writeImage } from "./image-io.ts";

writeImage(makeTestChart(1280, 720), "public/test-chart.png");
console.log("Wrote public/test-chart.png (1280x720)");
