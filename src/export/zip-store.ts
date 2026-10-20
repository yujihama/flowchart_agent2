/** OPCパッケージ(xlsx / vsdx)共通の無圧縮ZIPライター */
export function zipStore(files: Map<string, string | Uint8Array>) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;

  files.forEach((content, path) => {
    const nameBytes = encoder.encode(path);
    const dataBytes = typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(dataBytes);
    const localHeader = concatBytes([
      uint32le(0x04034b50),
      uint16le(20),
      uint16le(0x0800),
      uint16le(0),
      uint16le(0),
      uint16le(0),
      uint32le(crc),
      uint32le(dataBytes.length),
      uint32le(dataBytes.length),
      uint16le(nameBytes.length),
      uint16le(0),
      nameBytes,
    ]);
    chunks.push(localHeader, dataBytes);

    centralDirectory.push(
      concatBytes([
        uint32le(0x02014b50),
        uint16le(20),
        uint16le(20),
        uint16le(0x0800),
        uint16le(0),
        uint16le(0),
        uint16le(0),
        uint32le(crc),
        uint32le(dataBytes.length),
        uint32le(dataBytes.length),
        uint16le(nameBytes.length),
        uint16le(0),
        uint16le(0),
        uint16le(0),
        uint16le(0),
        uint32le(0),
        uint32le(offset),
        nameBytes,
      ]),
    );
    offset += localHeader.length + dataBytes.length;
  });

  const centralDirectoryOffset = offset;
  const centralDirectoryBytes = concatBytes(centralDirectory);
  const end = concatBytes([
    uint32le(0x06054b50),
    uint16le(0),
    uint16le(0),
    uint16le(files.size),
    uint16le(files.size),
    uint32le(centralDirectoryBytes.length),
    uint32le(centralDirectoryOffset),
    uint16le(0),
  ]);

  return concatBytes([...chunks, centralDirectoryBytes, end]);
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  bytes.forEach((byte) => {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  });
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16le(value: number) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32le(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concatBytes(parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
}
