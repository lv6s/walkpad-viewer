/* hyparquet 适配层：把解压器固定进来，调用点就不必每次传 compressors。
   测量包与旧 bundle 的帧表都是 ZSTD 页，hyparquet 本身只认 UNCOMPRESSED / SNAPPY。 */

import {decompress} from 'fzstd';
import {parquetMetadata, parquetReadObjects} from 'hyparquet';

/** ZSTD 页解压。fzstd 直接给完整输出，长度与页头声明不符时截断以免下游越界 */
const zstd = (bytes: Uint8Array, size: number): Uint8Array => {
  const out = decompress(bytes);
  return out.length === size ? out : out.subarray(0, size);
};

export const compressors = {ZSTD: zstd};

export const ParquetHQ = {
  parquetMetadata,
  parquetReadObjects: (o: Record<string, unknown>) => parquetReadObjects({compressors, ...o} as never),
  compressors,
};
