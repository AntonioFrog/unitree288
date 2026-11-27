// 宇树 J288/S288 数字舵机协议（主机侧）。
//
// 数据来源与交叉核对见 doc/协议说明.md：
//   - 官方仓库 unitreerobotics/digital_servo（specs/protocol.md、python、stm32）
//   - 《无刷数字舵机 J288/S288 使用手册》
// 本文件只做纯函数与流解析，不接触串口，可在 Node 与浏览器中共用。
import { crc32 } from './crc32.mjs';

export const BAUD_RATE = 6000000; // 固定 6 Mbps，8N1，不可配置
export const RATIO = 70070.0 / 243.0; // 减速比 288.35:1
const TWO_PI = Math.PI * 2;

export const BROADCAST_ID = 15;
export const MAX_ID = 14;
export const CONTROL_SIZE = 20;
export const FEEDBACK_SIZE = 26;
const CONTROL_HEAD = [0xfe, 0xee];
const FEEDBACK_HEAD = [0xfc, 0xee];

export const MODE = Object.freeze({ LOCK: 0, FOC: 1 });

// 官方饱和上限：输出端物理量（rad / rad·s⁻¹ / N·m）。
export const LIMITS = Object.freeze({
  tor: 36.9093,
  spd: 278.90143,
  pos: 1428.018898,
  kp: 2128.523254,
  kd: 21.285233,
});

export const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

const clampOr = (value, min, max, fallback) =>
  Number.isFinite(value) ? clamp(value, min, max) : fallback;

// 输出端 → 转子端定点换算（与官方 C 实现同式）。
const toFixed = {
  tor: (tor) => (tor / RATIO) * 256000,
  spd: (spd) => (spd * RATIO * 2.56) / Math.PI / 2,
  pos: (pos) => (pos * RATIO * 32768) / Math.PI / 2,
  kp: (kp) => (kp / (RATIO * RATIO)) * 1280000,
  kd: (kd) => (kd / (RATIO * RATIO)) * 128000000,
};

// 转子端定点 → 输出端。
const toOutput = {
  tor: (raw) => (raw / 256000) * RATIO,
  spd: (raw) => ((raw / 2.56) * Math.PI * 2) / RATIO,
  pos: (raw) => ((Math.PI * 2 * raw) / 32768) / RATIO,
  kp: (raw) => (raw / 1280000) * RATIO * RATIO,
  kd: (raw) => (raw / 128000000) * RATIO * RATIO,
  vol: (raw) => raw / 2,
  exPos: (outPos) => (Math.PI * 2 * outPos) / 8192,
};

const int16 = (value) => clamp(Math.round(value), -32768, 32767);
const int32 = (value) => Math.max(-2147483648, Math.min(2147483647, Math.round(value)));

/**
 * 构造 20 字节控制帧。
 * 所有位置/速度/力矩参数均为"输出端"物理量；内部按官方公式换算为转子端定点。
 */
export function buildControl(input) {
  const {
    id,
    mode = MODE.FOC,
    timeout = 1,
    tor = 0,
    spd = 0,
    pos = 0,
    kp = 0,
    kd = 0,
  } = input ?? {};

  if (!Number.isInteger(id) || id < 0 || id > BROADCAST_ID) throw Error('ID 必须为 0..15 的整数');

  const packet = new Uint8Array(CONTROL_SIZE);
  const view = new DataView(packet.buffer);

  packet[0] = CONTROL_HEAD[0];
  packet[1] = CONTROL_HEAD[1];
  packet[2] =
    ((id & 0x0f) | ((clamp(mode, 0, 7) & 0x07) << 4) | ((timeout ? 1 : 0) << 7)) & 0xff;
  packet[3] = 0x00; // 保留位

  view.setInt16(4, int16(toFixed.tor(clampOr(tor, -LIMITS.tor, LIMITS.tor, 0))), true);
  view.setInt16(6, int16(toFixed.spd(clampOr(spd, -LIMITS.spd, LIMITS.spd, 0))), true);
  view.setInt32(8, int32(toFixed.pos(clampOr(pos, -LIMITS.pos, LIMITS.pos, 0))), true);
  view.setInt16(12, int16(toFixed.kp(clampOr(kp, 0, LIMITS.kp, 0))), true);
  view.setInt16(14, int16(toFixed.kd(clampOr(kd, 0, LIMITS.kd, 0))), true);

  view.setUint32(16, crc32(packet, 0, 16), true);
  return packet;
}

/** 模拟总线和测试使用的控制帧解包。 */
export function parseControl(packet) {
  if (packet?.length !== CONTROL_SIZE) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const modeByte = packet[2];
  return {
    id: modeByte & 0x0f,
    mode: (modeByte >> 4) & 0x07,
    timeout: (modeByte >> 7) & 1,
    tor: toOutput.tor(view.getInt16(4, true)),
    spd: toOutput.spd(view.getInt16(6, true)),
    pos: toOutput.pos(view.getInt32(8, true)),
    kp: toOutput.kp(view.getInt16(12, true)),
    kd: toOutput.kd(view.getInt16(14, true)),
  };
}

/**
 * 解析 26 字节反馈帧。校验帧头与 CRC，失败返回 null。
 */
export function parseFeedback(frame) {
  if (!frame || frame.length !== FEEDBACK_SIZE) return null;
  if (frame[0] !== FEEDBACK_HEAD[0] || frame[1] !== FEEDBACK_HEAD[1]) return null;

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const expected = view.getUint32(22, true);
  if (crc32(frame, 2, 22) !== expected) return null;

  const modeByte = frame[2];
  const id = modeByte & 0x0f;
  const mode = (modeByte >> 4) & 0x07;
  const timeout = (modeByte >> 7) & 0x01;

  const temp = view.getInt8(3);
  const sensor = view.getUint8(4);
  const volRaw = view.getUint8(5);
  const torRaw = view.getInt16(6, true);
  const spdRaw = view.getInt16(8, true);
  const posRaw = view.getInt32(10, true);
  const error = view.getUint32(14, true);
  const pack = view.getUint16(18, true);
  const outPos = pack & 0x1fff;
  const warn = (pack >> 13) & 0x07;
  const exSensor2 = frame[20];
  const exCom = frame[21];

  return {
    id,
    mode,
    timeout,
    temp, // 壳体温度 ℃
    sensor, // 绕组温度 ℃
    vol: toOutput.vol(volRaw), // V
    tor: toOutput.tor(torRaw), // N·m（输出端）
    spd: toOutput.spd(spdRaw), // rad/s（输出端）
    pos: toOutput.pos(posRaw), // rad（输出端，上电后累计）
    posRaw,
    error,
    warn,
    exPos: toOutput.exPos(outPos), // 0..2π 单圈绝对位置
    exSensor2,
    exCom,
    raw: frame,
  };
}

/**
 * 构造 26 字节反馈帧。仅用于模拟设备与离线测试夹具；
 * 实机反馈由舵机自身产生，网页不发送反馈帧。
 */
export function encodeFeedback(state) {
  const {
    id = 0,
    mode = MODE.FOC,
    timeout = 0,
    temp = 30,
    sensor = 40,
    vol = 24,
    tor = 0,
    spd = 0,
    pos = 0,
    error = 0,
    exPos = 0,
    warn = 0,
    exSensor2 = 0,
    exCom = 0,
  } = state ?? {};

  const frame = new Uint8Array(FEEDBACK_SIZE);
  const view = new DataView(frame.buffer);
  frame[0] = FEEDBACK_HEAD[0];
  frame[1] = FEEDBACK_HEAD[1];
  frame[2] = ((id & 0x0f) | ((mode & 0x07) << 4) | ((timeout ? 1 : 0) << 7)) & 0xff;
  view.setInt8(3, clamp(Math.round(temp), -128, 127));
  view.setUint8(4, clamp(Math.round(sensor), 0, 255));
  view.setUint8(5, clamp(Math.round(vol * 2), 0, 255));
  view.setInt16(6, int16(toFixed.tor(clamp(tor, -LIMITS.tor, LIMITS.tor))), true);
  view.setInt16(8, int16(toFixed.spd(clamp(spd, -LIMITS.spd, LIMITS.spd))), true);
  view.setInt32(10, int32(toFixed.pos(clamp(pos, -LIMITS.pos, LIMITS.pos))), true);
  view.setUint32(14, error >>> 0, true);
  const outPos = Math.round(((exPos % TWO_PI) / TWO_PI) * 8192) & 0x1fff;
  view.setUint16(18, (outPos | ((warn & 0x07) << 13)) & 0xffff, true);
  frame[20] = exSensor2 & 0xff;
  frame[21] = exCom & 0xff;
  view.setUint32(22, crc32(frame, 2, 22), true);
  return frame;
}

const ERRORS = [
  [1 << 0, '过流'],
  [1 << 1, '瞬态过压'],
  [1 << 2, '持续过压'],
  [1 << 3, '欠压'],
  [1 << 4, '芯片过热'],
  [1 << 5, 'MOS 过热/过冷'],
  [1 << 6, 'MOS 温度异常'],
  [1 << 7, '壳体过热/过冷'],
  [1 << 8, '壳体温度异常'],
  [1 << 9, '绕组过热'],
  [1 << 10, '转子编码器 1 错误'],
  [1 << 11, '转子编码器 2 错误'],
  [1 << 12, '输出编码器错误'],
  [1 << 13, '储存数据错误'],
  [1 << 14, '异常复位'],
  [1 << 15, '等待解锁'],
  [1 << 16, '驱动验证错误'],
  [1 << 17, '标定模式'],
  [1 << 18, '通信校验错误'],
  [1 << 19, '驱动版本过低'],
  [1 << 20, '固件型号错误'],
  [1 << 21, '编码器角度异常'],
];

const WARNINGS = [
  [1, '低压电源异常'],
];

function describeFlags(mask, definitions, emptyLabel) {
  let unknown = mask >>> 0;
  const flags = [];
  for (const [bit, label] of definitions) {
    if (unknown & bit) {
      flags.push(label);
      unknown = (unknown & ~bit) >>> 0;
    }
  }
  if (unknown) flags.push(`未知标志 0x${unknown.toString(16).toUpperCase()}`);
  return flags.length ? flags.join('、') : emptyLabel;
}

export function describeError(mask) {
  return describeFlags(mask, ERRORS, '正常');
}

export function describeWarn(mask) {
  return describeFlags(mask, WARNINGS, '无');
}

/**
 * 流式分帧。总线上可能混有：反馈帧（FC EE，26B）、
 * 适配器回显的控制帧（FE EE，20B，半双工常见）以及噪声字节。
 */
export class Framer {
  constructor() {
    this.buffer = new Uint8Array(0);
    this.stats = { feedback: 0, echo: 0, noise: 0, crcErrors: 0, overflow: 0 };
  }

  reset() {
    this.buffer = new Uint8Array(0);
  }

  push(chunk) {
    if (!chunk || !chunk.length) return [];
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const frames = [];
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) break;

      let start = -1;
      let kind = null;
      for (let i = 0; i + 1 < buf.length; i++) {
        const b0 = buf[i];
        const b1 = buf[i + 1];
        if (b0 === 0xfc && b1 === 0xee) {
          start = i;
          kind = 'feedback';
          break;
        }
        if (b0 === 0xfe && b1 === 0xee) {
          start = i;
          kind = 'echo';
          break;
        }
      }
      if (start < 0) {
        // 保留最后一个字节，它可能是帧头的上半部分。
        const keep = buf[buf.length - 1] === 0xfc || buf[buf.length - 1] === 0xfe ? 1 : 0;
        this.stats.noise += buf.length - keep;
        this.buffer = buf.slice(buf.length - keep);
        break;
      }
      if (start > 0) {
        this.stats.noise += start;
        this.buffer = buf.slice(start);
        continue;
      }

      const size = kind === 'feedback' ? FEEDBACK_SIZE : CONTROL_SIZE;
      if (buf.length < size) break;

      const candidate = buf.slice(0, size);
      const crcOk = crc32(candidate, kind === 'feedback' ? 2 : 0, size - 4) ===
        new DataView(candidate.buffer).getUint32(size - 4, true);
      if (!crcOk) {
        this.stats.crcErrors++;
        this.buffer = buf.slice(1);
        continue;
      }

      this.buffer = buf.slice(size);
      if (kind === 'feedback') {
        this.stats.feedback++;
        const parsed = parseFeedback(candidate);
        if (parsed) frames.push(parsed);
      } else {
        this.stats.echo++;
      }
    }

    if (this.buffer.length > 4096) {
      this.stats.overflow++;
      this.buffer = this.buffer.slice(this.buffer.length - 64);
    }
    return frames;
  }
}
