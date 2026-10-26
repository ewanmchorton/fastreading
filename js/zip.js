// Minimal ZIP reader (EPUB, .fb2.zip). Uses the browser's built-in
// DecompressionStream, so no third-party library is needed.

export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // End of central directory record: search backwards from the end.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Файл повреждён или это не архив');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const utf8 = new TextDecoder('utf-8');

  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }

  async function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    const lNameLen = view.getUint16(e.local + 26, true);
    const lExtraLen = view.getUint16(e.local + 28, true);
    const start = e.local + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + e.compSize);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error('Неподдерживаемое сжатие в архиве');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    async text(name) {
      const data = await read(name);
      return data ? utf8.decode(data) : null;
    },
  };
}
