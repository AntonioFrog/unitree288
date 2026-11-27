// J288/S288 控制帧与反馈帧的 CRC-32。
//
// 官方实现（upstream/stm32/firmware/App/crc_ccitt.h 与 python/servo_demo.py）
// 并不是"按字节顺序"的 CRC：它把报文按小端 uint32 字切分，每个字从最高位
// （即该字的第 4 个字节）开始逐位送入，并且忽略不足 4 字节的尾部。
// 直接用常见的 zlib/按字节 CRC32 会导致舵机 CRC 校验失败并丢弃整帧。
//
// 这里用多项式在加载时生成同一张表，避免手工抄写 256 个常量。
const POLY = 0x04c11db7;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = (i << 24) >>> 0;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80000000) ? (((crc << 1) >>> 0) ^ POLY) >>> 0 : (crc << 1) >>> 0;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export { CRC_TABLE };

/**
 * 计算 J288/S288 报文 CRC。
 * @param {Uint8Array} bytes 缓冲区
 * @param {number} start 起始偏移（含）
 * @param {number} end 结束偏移（不含）
 * @returns {number} 无符号 32 位 CRC
 */
export function crc32(bytes, start = 0, end = bytes.length) {
  const words = Math.floor((end - start) / 4);
  let crc = 0xffffffff;
  for (let i = 0; i < words; i++) {
    const base = start + i * 4;
    // 小端字的 4 个字节，从高字节到低字节送入：3,2,1,0
    for (let k = 3; k >= 0; k--) {
      crc = (CRC_TABLE[((crc >>> 24) ^ bytes[base + k]) & 0xff] ^ ((crc << 8) >>> 0)) >>> 0;
    }
  }
  return crc >>> 0;
}
