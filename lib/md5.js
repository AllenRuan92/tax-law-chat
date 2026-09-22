// MD5 is required by Bailian's upload lease protocol, not used for security.
const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
export function md5Base64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const block = new Uint8Array(64), words = new DataView(block.buffer);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < length; offset += 64) {
    block.fill(0);
    block.set(bytes.subarray(offset, Math.min(offset + 64, bytes.length)));
    if (offset <= bytes.length && bytes.length < offset + 64) block[bytes.length - offset] = 0x80;
    if (offset + 64 === length) {
      words.setUint32(56, (bytes.length * 8) >>> 0, true);
      words.setUint32(60, Math.floor(bytes.length / 0x20000000), true);
    }
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c)
        : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const index = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const sum = (a + f + constants[i] + words.getInt32(index * 4, true)) | 0;
      const shift = shifts[round * 4 + i % 4];
      const next = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      [a, b, c, d] = [d, next, b, c];
    }
    [a, b, c, d].forEach((value, i) => { state[i] = (state[i] + value) | 0; });
  }
  const result = new DataView(new ArrayBuffer(16));
  state.forEach((value, i) => result.setInt32(i * 4, value, true));
  return btoa(String.fromCharCode(...new Uint8Array(result.buffer)));
}
