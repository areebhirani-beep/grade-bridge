// The preview looks each pixel up in a 3D texture made from the same Float32Array
// that Export writes, so the preview and the .cube cannot drift apart.
// Intensity is mix(original, graded, k) here; Export bakes the identical mix into
// the file with mixWithIdentity (see src/core/lut.ts and tests/web.test.ts).

const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uImage;
uniform sampler3D uLut;
uniform float uLutSize;
uniform vec3 uDomainMin;
uniform vec3 uDomainMax;
uniform float uIntensity;
uniform int uMode;       // 0 graded, 1 original, 2 wipe, 3 side by side
uniform float uSplit;    // wipe position, 0..1
uniform float uGap;      // side by side gap, in device pixels
uniform vec3 uGapColor;
uniform float uWidth;    // viewport width, in device pixels
in vec2 vUv;
out vec4 outColor;

vec3 grade(vec3 src) {
  // Map 0..1 onto texel centers so grid point i lands exactly on stored entry i.
  vec3 t = clamp((src - uDomainMin) / (uDomainMax - uDomainMin), 0.0, 1.0);
  vec3 coord = t * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
  return mix(src, texture(uLut, coord).rgb, uIntensity);
}

void main() {
  if (uMode == 3) {
    float half_ = (uWidth - uGap) * 0.5;
    float px = vUv.x * uWidth;
    if (px < half_) {
      outColor = vec4(texture(uImage, vec2(px / half_, vUv.y)).rgb, 1.0);
    } else if (px > half_ + uGap) {
      outColor = vec4(grade(texture(uImage, vec2((px - half_ - uGap) / half_, vUv.y)).rgb), 1.0);
    } else {
      outColor = vec4(uGapColor, 1.0);
    }
    return;
  }
  vec3 src = texture(uImage, vUv).rgb;
  bool original = uMode == 1 || (uMode == 2 && vUv.x < uSplit);
  outColor = vec4(original ? src : grade(src), 1.0);
}`;

export type CompareMode = "off" | "wipe" | "side";

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  private program: WebGLProgram;
  private imageTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private sourceSize = { width: 0, height: 0 };

  split = 0.5;
  compare: CompareMode = "wipe";
  /** True while the "show original" key is held. */
  holdOriginal = false;
  intensity = 1;
  gapPx = 8;
  gapColor: [number, number, number] = [0.1, 0.1, 0.1];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.program = this.link(VERTEX, FRAGMENT);
    gl.useProgram(this.program);
    for (const name of ["uImage", "uLut", "uLutSize", "uDomainMin", "uDomainMax", "uIntensity", "uMode", "uSplit", "uGap", "uGapColor", "uWidth"]) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.imageTex = this.makeTexture(gl.TEXTURE_2D);
    this.lutTex = this.makeTexture(gl.TEXTURE_3D);
    gl.uniform1i(this.u.uImage, 0);
    gl.uniform1i(this.u.uLut, 1);
  }

  // RGB16F because 32-bit float 3D textures are not filterable in WebGL2 without an extension.
  setLut(data: Float32Array, size: number, domainMin: ArrayLike<number> = [0, 0, 0], domainMax: ArrayLike<number> = [1, 1, 1]): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    gl.useProgram(this.program);
    gl.uniform1f(this.u.uLutSize, size);
    gl.uniform3fv(this.u.uDomainMin, Array.from(domainMin));
    gl.uniform3fv(this.u.uDomainMax, Array.from(domainMax));
  }

  setSource(source: TexImageSource, width: number, height: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // Mipmaps so a 4K frame shown at 900 px wide is filtered, not aliased.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.sourceSize = { width, height };
  }

  private modeIndex(): number {
    if (this.holdOriginal) return 1;
    return this.compare === "wipe" ? 2 : this.compare === "side" ? 3 : 0;
  }

  draw(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.drawWith(this.modeIndex(), this.canvas.width);
  }

  private drawWith(mode: number, width: number): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.u.uWidth, width);
    gl.uniform1f(this.u.uIntensity, this.intensity);
    gl.uniform1i(this.u.uMode, mode);
    gl.uniform1f(this.u.uSplit, this.split);
    gl.uniform1f(this.u.uGap, this.gapPx);
    gl.uniform3fv(this.u.uGapColor, this.gapColor);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Renders the graded frame at the source's full resolution, off screen, and
   * returns top-down RGBA rows. Used by "Export still".
   */
  renderFullRes(): ImageData {
    const gl = this.gl;
    const { width, height } = this.sourceSize;
    const max = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
    if (width > max || height > max) throw new Error(`Frame is ${width}x${height}; this GPU renders at most ${max} px per side.`);
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, width, height);
    this.drawWith(0, width);
    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    // GL rows are bottom-up; images are top-down.
    const out = new ImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) out.data.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    this.draw();
    return out;
  }

  private makeTexture(target: GLenum): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(target, tex);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: GLenum, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
    return p;
  }
}
