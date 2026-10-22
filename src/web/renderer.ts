// The preview looks each pixel up in a 3D texture made from the same Float32Array
// that Export writes, so the preview and the .cube cannot drift apart.

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
uniform float uSplit;   // 0..1: left of this is "before"; -1 disables the split
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 src = texture(uImage, vUv).rgb;
  // Map 0..1 onto texel centers so grid point i lands exactly on stored entry i.
  vec3 t = clamp((src - uDomainMin) / (uDomainMax - uDomainMin), 0.0, 1.0);
  vec3 coord = t * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
  vec3 graded = texture(uLut, coord).rgb;
  outColor = vec4(vUv.x < uSplit ? src : graded, 1.0);
}`;

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private imageTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private lutSize = 2;
  split = 0.5;
  compare = true;

  readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.program = this.link(VERTEX, FRAGMENT);
    gl.useProgram(this.program);
    for (const name of ["uImage", "uLut", "uLutSize", "uDomainMin", "uDomainMax", "uSplit"]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }

    // One triangle pair covering the screen.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.imageTex = this.makeTexture(gl.TEXTURE_2D);
    this.lutTex = this.makeTexture(gl.TEXTURE_3D);
    gl.uniform1i(this.uniforms.uImage, 0);
    gl.uniform1i(this.uniforms.uLut, 1);
  }

  // RGB16F because 32-bit float 3D textures are not filterable in WebGL2 without an extension.
  setLut(data: Float32Array, size: number, domainMin = [0, 0, 0], domainMax = [1, 1, 1]): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    this.lutSize = size;
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.uLutSize, size);
    gl.uniform3fv(this.uniforms.uDomainMin, domainMin);
    gl.uniform3fv(this.uniforms.uDomainMax, domainMax);
  }

  setSource(source: TexImageSource): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  draw(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.uSplit, this.compare ? this.split : -1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  get currentLutSize(): number {
    return this.lutSize;
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
