import { readFileSync } from "node:fs";

/** Reads the positions and triangle indices of a GLB's first primitive (uncompressed, no Draco). */
export function readGlb(path) {
  const file = readFileSync(path);
  const jsonLength = file.readUInt32LE(12);
  const gltf = JSON.parse(file.subarray(20, 20 + jsonLength).toString());
  const binStart = 20 + jsonLength + 8;
  const view = new DataView(file.buffer, file.byteOffset);
  const readers = {
    5121: [1, (o) => view.getUint8(o)],
    5123: [2, (o) => view.getUint16(o, true)],
    5125: [4, (o) => view.getUint32(o, true)],
    5126: [4, (o) => view.getFloat32(o, true)],
  };
  const accessor = (i) => {
    const a = gltf.accessors[i];
    const bufferView = gltf.bufferViews[a.bufferView];
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const [size, read] = readers[a.componentType];
    const stride = bufferView.byteStride || width * size;
    const start = binStart + (bufferView.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = new Float64Array(a.count * width);
    for (let k = 0; k < a.count; k++) {
      for (let c = 0; c < width; c++) out[k * width + c] = read(start + k * stride + c * size);
    }
    return out;
  };
  const primitive = gltf.meshes[0].primitives[0];
  return {
    positions: accessor(primitive.attributes.POSITION),
    indices: accessor(primitive.indices),
  };
}
