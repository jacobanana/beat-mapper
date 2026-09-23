/** In-place radix-2 FFT of size N (a power of two). Returns a function transforming (re, im). */
export function makeFFT(N: number): (re: Float64Array, im: Float64Array) => void {
  const bits = Math.log2(N) | 0;
  const rev = new Uint32Array(N);
  const cs = new Float64Array(N / 2);
  const sn = new Float64Array(N / 2);
  for (let i = 0; i < N; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  for (let i = 0; i < N / 2; i++) {
    cs[i] = Math.cos((2 * Math.PI * i) / N);
    sn[i] = Math.sin((2 * Math.PI * i) / N);
  }
  return (re, im) => {
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half, xr = re[b], xi = im[b];
          const tr = xr * cs[k] + xi * sn[k], ti = xi * cs[k] - xr * sn[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}
