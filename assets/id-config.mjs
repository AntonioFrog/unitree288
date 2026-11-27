// J288/S288 改号流程，依据 2026-11-24 在 COM28 记录的宇树助手收发。
import { crc32 } from './crc32.mjs';
import { Framer, MAX_ID, buildControl } from './protocol.mjs';
import { sleep } from './bus.mjs';

const RESTART_FOR_CONFIGURATION = 7;
const SAVE_CONFIRMED = new TextEncoder().encode('SaveOK ');

export const isDeviceId = (id) => Number.isInteger(id) && id >= 0 && id <= MAX_ID;

function configFrame(id, group, command, offset, data) {
  const frame = new Uint8Array(data.length + 12);
  const view = new DataView(frame.buffer);
  frame.set([0xfe, 0xee, 0xf0 | id, 0, 0xf0 | id, (group << 4) | command]);
  view.setUint16(6, offset, true);
  frame.set(data, 8);
  view.setUint32(frame.length - 4, crc32(frame, 0, frame.length - 4), true);
  return frame;
}

const matches = (bytes, expected, offset = 0) =>
  expected.every((byte, index) => bytes[offset + index] === byte);

// 服务反馈比常规控制反馈多出一类 34 字节回包。独占期间单独分帧，
// 同时允许适配器回显和任意分块，避免服务反馈流入常规控制解析器。
async function exchange(transport, request, responseSize, timeout, step) {
  const previous = transport.onData;
  let buffer = new Uint8Array(0);
  let timer;
  const reply = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error(`${step}未收到有效应答`)), timeout);
    transport.onData = (chunk) => {
      const bytes = new Uint8Array(buffer.length + chunk.length);
      bytes.set(buffer);
      bytes.set(chunk, buffer.length);
      buffer = bytes;
      while (buffer.length >= 2) {
        if (buffer[0] === 0xfe && buffer[1] === 0xee) {
          if (buffer.length < request.length) return;
          if (matches(buffer, request)) {
            buffer = buffer.subarray(request.length);
            continue;
          }
        }
        if (buffer[0] === 0xfc && buffer[1] === 0xee) {
          if (buffer.length < responseSize) return;
          const frame = buffer.slice(0, responseSize);
          const checksum = new DataView(frame.buffer).getUint32(responseSize - 4, true);
          if (checksum === crc32(frame, 2, responseSize - 4)
            && matches(frame, request.subarray(4, 8), 2)) {
            resolve(frame.subarray(6, responseSize - 4));
            return;
          }
        }
        buffer = buffer.subarray(1);
      }
    };
  });
  try {
    // Keep the port reserved until the write has settled even if the reply times out.
    const written = transport.write(request);
    try {
      const [, data] = await Promise.all([written, reply]);
      return data;
    } catch (error) {
      await written.catch(() => {});
      throw error;
    }
  } finally {
    clearTimeout(timer);
    transport.onData = previous;
  }
}

// 调用方已通过普通总线确认源地址对最后一帧 Stop 的唯一、健康应答。
export async function writeStoppedDeviceId(transport, from, to, onAddressWrite = () => {}) {
  if (!isDeviceId(from) || !isDeviceId(to) || from === to) throw Error('设备 ID 无效');
  // 重启可无应答。有额外的普通反馈（包括更晚到达的 Stop）时，先交回总线并中止配置。
  const receive = transport.onData;
  const reboot = new Framer();
  let acknowledged = false;
  let unexpected = false;
  transport.onData = (chunk) => {
    for (const frame of reboot.push(chunk)) {
      if (!acknowledged && frame.id === from && frame.mode === RESTART_FOR_CONFIGURATION) {
        acknowledged = true;
      } else {
        unexpected = true;
        receive(frame.raw);
      }
    }
  };
  try {
    await transport.write(buildControl({ id: from, mode: RESTART_FOR_CONFIGURATION, timeout: 0 }));
    await sleep(80);
    if (unexpected || reboot.stats.crcErrors) throw Error('重启期间出现额外应答或 CRC 错误，已中止配置');
  } finally {
    transport.onData = receive;
  }

  const challenge = new Uint8Array(16).fill(0xaa);
  const key = (await exchange(transport, configFrame(from, 8, 0, 0x20, challenge), 34, 100, '读取写入凭据')).subarray(0, 16);
  const unlocked = await exchange(transport, configFrame(from, 8, 1, 0x10, key), 34, 100, '解锁配置');
  if (!matches(unlocked, key)) throw Error('解锁配置回读不匹配');

  const address = new Uint8Array(8);
  address[0] = to;
  onAddressWrite();
  const written = await exchange(transport, configFrame(from, 0, 1, 4, address), 26, 100, '写入设备 ID');
  if (written[0] !== to) throw Error('设备 ID 回读不匹配');

  const commit = new Uint8Array(8);
  const view = new DataView(commit.buffer);
  // 保存载荷沿用 V1.3.1 的固定标记和主机 Unix 秒。
  view.setInt32(0, -103, true);
  view.setInt32(4, Math.floor(Date.now() / 1000), true);
  const saved = await exchange(transport, configFrame(to, 0, 2, 0, commit), 26, 3000, '保存设备 ID');
  if (!matches(saved, SAVE_CONFIRMED)) throw Error('设备未确认保存 ID');
}
