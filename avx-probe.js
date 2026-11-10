// avx-probe.js — CPU platform probe.
//
// Defines cpuProbe(), which reports what navigator claims and then measures the
// real CPU through WebAssembly relaxed SIMD, whose results depend on native instructions.
//
// Usable in four scopes:
//   - window:           <script src="avx-probe.js"></script>, then call cpuProbe()
//   - dedicated worker: new Worker("avx-probe.js"), post "probe", receive the result
//   - shared worker:    new SharedWorker("avx-probe.js"), post "probe" on the port
//   - service worker:   sw.js loads this file with importScripts() and wires its own handler

const PROBE_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00,
  // type section: (f64, f64, f64) -> f64 and (f32) -> i32
  0x01, 0x0D, 0x02, 0x60, 0x03, 0x7C, 0x7C, 0x7C, 0x01, 0x7C, 0x60, 0x01, 0x7D, 0x01, 0x7F,
  // function section
  0x03, 0x03, 0x02, 0x00, 0x01,
  // export section: "madd", "trunc"
  0x07, 0x10, 0x02, 0x04, 0x6D, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x05, 0x74, 0x72, 0x75, 0x6E, 0x63, 0x00, 0x01,
  // code section
  0x0A, 0x23, 0x02,
  // madd(a, b, c): f64x2.relaxed_madd(splat a, splat b, splat c), lane 0
  0x14, 0x00, 0x20, 0x00, 0xFD, 0x14, 0x20, 0x01, 0xFD, 0x14, 0x20, 0x02, 0xFD, 0x14,
  0xFD, 0x87, 0x02, 0xFD, 0x21, 0x00, 0x0B,
  // trunc(x): i32x4.relaxed_trunc_f32x4_s(splat x), lane 0
  0x0C, 0x00, 0x20, 0x00, 0xFD, 0x13, 0xFD, 0x81, 0x02, 0xFD, 0x1B, 0x00, 0x0B,
]);

function probeScopeName() {
  if (typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope) return "service worker";
  if (typeof SharedWorkerGlobalScope !== "undefined" && self instanceof SharedWorkerGlobalScope) return "shared worker";
  if (typeof DedicatedWorkerGlobalScope !== "undefined" && self instanceof DedicatedWorkerGlobalScope) return "dedicated worker";
  return "window";
}

async function cpuProbe() {
  const out = {
    scope: probeScopeName(),
    userAgent: navigator.userAgent ?? null,
    platform: navigator.platform ?? null,
    cores: navigator.hardwareConcurrency ?? null,
    chPlatform: null,
    chPlatformVersion: null,
    chArchitecture: null,
    chBitness: null,
    relaxedSimd: false,
    fusedMadd: null,
    isa: null,
    inferred: null,
    error: null,
  };

  // User-Agent Client Hints (Chromium only).
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      const h = await navigator.userAgentData.getHighEntropyValues(
        ["architecture", "bitness", "platform", "platformVersion"]
      );
      out.chPlatform = h.platform ?? null;
      out.chPlatformVersion = h.platformVersion ?? null;
      out.chArchitecture = h.architecture ?? null;
      out.chBitness = h.bitness ?? null;
    }
  } catch (e) {
    out.error = "Client Hints: " + e;
  }

  // Hardware measurement through relaxed SIMD.
  try {
    if (!WebAssembly.validate(PROBE_WASM)) {
      out.inferred = "relaxed SIMD unsupported in this engine";
      return out;
    }
    out.relaxedSimd = true;
    const { instance } = await WebAssembly.instantiate(PROBE_WASM);
    const { madd, trunc } = instance.exports;

    // A fused multiply-add keeps the rounding error of a*b, so the result is non-zero.
    // An unfused multiply then add cancels exactly to 0.
    const a = 0.1, b = 0.1;
    out.fusedMadd = madd(a, b, -(a * b)) !== 0;

    // x86 cvttps2dq returns 0x80000000 for NaN and overflow.
    // ARM fcvtzs returns 0 for NaN and saturates overflow to INT32_MAX.
    const tNaN = trunc(NaN);
    const tBig = trunc(3e9);
    if (tNaN === -2147483648 && tBig === -2147483648) out.isa = "x86";
    else if (tNaN === 0 && tBig === 2147483647) out.isa = "arm";
    else out.isa = "unknown (" + tNaN + ", " + tBig + ")";

    if (out.isa === "x86") {
      out.inferred = out.fusedMadd
        ? "x86-64 with FMA3 (Haswell / Piledriver or newer)"
        : "x86-64 without FMA3, or FMA disabled in the engine";
    } else if (out.isa === "arm") {
      out.inferred = "ARM (AArch64)";
    } else {
      out.inferred = "unrecognised instruction behaviour";
    }
  } catch (e) {
    out.error = (out.error ? out.error + "; " : "") + "Wasm: " + e;
  }

  return out;
}

// Wiring for dedicated and shared workers. The window needs no wiring,
// and sw.js wires the service worker itself.
(() => {
  const scope = probeScopeName();

  if (scope === "shared worker") {
    self.addEventListener("connect", (event) => {
      const port = event.ports[0];
      port.onmessage = (msg) => {
        if (msg.data === "probe") cpuProbe().then((result) => port.postMessage(result));
      };
    });
  } else if (scope === "dedicated worker") {
    self.addEventListener("message", (event) => {
      if (event.data === "probe") cpuProbe().then((result) => self.postMessage(result));
    });
  }
})();