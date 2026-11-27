// 传输层：Web Serial 适配器，以及用于离线开发的模拟舵机总线。
import { BAUD_RATE, BROADCAST_ID, MODE, encodeFeedback, parseControl } from './protocol.mjs';
import { sleep } from './bus.mjs';

function withDeadline(operation, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), ms);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

export function samePortInfo(a, b) {
  return a.usbVendorId === b.usbVendorId
    && a.usbProductId === b.usbProductId
    && a.bluetoothServiceClassId === b.bluetoothServiceClassId;
}

/** 真实串口（Web Serial）。6 Mbps 固定，8N1，无流控。 */
export class SerialTransport {
  #port;
  #reader = null;
  #writer = null;
  #readTask = null;
  #closeTask = null;
  #ownsPort = false;
  #closing = false;
  #failed = false;

  constructor(port, { baudRate = BAUD_RATE, bufferSize = 8192, writeTimeout = 250, closeTimeout = 1500 } = {}) {
    this.#port = port;
    this.baudRate = baudRate;
    this.bufferSize = bufferSize;
    this.writeTimeout = writeTimeout;
    this.closeTimeout = closeTimeout;
    this.onData = () => {};
    this.onError = () => {};
  }

  async open() {
    if (this.#ownsPort) throw Error('上一次串口尚未释放');
    this.#closing = false;
    this.#failed = false;
    this.#closeTask = null;
    try {
      await this.#port.open({
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: this.bufferSize,
      });
    } catch (error) {
      // 驱动不支持 6 Mbps 时，各浏览器报错文本不一致，统一转成可操作提示。
      throw Error(
        `打开串口失败（${this.baudRate} bps）：${error?.message ?? error}。` +
          '请关闭占用串口的调试助手或其他标签页，确认转接板和驱动支持 6 Mbps。' +
          'FTDI 转接板可在设备管理器将延迟计时器设为 1 ms。',
      );
    }
    this.#ownsPort = true;
    try {
      this.#writer = this.#port.writable.getWriter();
      this.#reader = this.#port.readable.getReader();
    } catch (error) {
      // The caller keeps ownership of this port until close() finishes.
      throw Error(`无法访问串口数据流：${error.message}`, { cause: error });
    }
    this.#readTask = this.#readLoop();
  }

  async #readLoop() {
    try {
      for (;;) {
        const { value, done } = await this.#reader.read();
        if (done) break;
        if (value?.length && !this.#closing) this.onData(value);
      }
      this.#reportFailure(Error('串口数据流已结束（设备可能被拔出）'));
    } catch (error) {
      this.#reportFailure(error);
    } finally {
      try {
        this.#reader?.releaseLock();
      } catch {
        /* 已释放 */
      }
      this.#reader = null;
    }
  }

  #reportFailure(error) {
    if (this.#closing || this.#failed) return;
    this.#failed = true;
    this.onError(error);
  }

  async write(bytes) {
    if (!this.#writer || this.#closing || this.#failed) throw Error('串口未打开、正在关闭或写入已失败');
    try {
      await withDeadline(this.#writer.write(bytes), this.writeTimeout, '串口写入超时');
    } catch (error) {
      this.#reportFailure(error);
      throw error;
    }
  }

  async close() {
    if (!this.#ownsPort) return;
    this.#closeTask ??= this.#closePort().catch((error) => {
      this.#closeTask = null;
      throw error;
    });
    await withDeadline(this.#closeTask, this.closeTimeout, '等待串口释放超时，请确认设备状态后重试。');
  }

  async #closePort() {
    this.#closing = true;
    try {
      await this.#reader?.cancel();
    } catch {
      /* 忽略 */
    }
    try {
      this.#writer?.releaseLock();
    } catch {
      /* 忽略 */
    }
    this.#writer = null;
    try {
      await this.#readTask;
    } catch {
      /* 忽略 */
    }
    try {
      await this.#port.close();
    } catch (error) {
      if (this.#port.readable || this.#port.writable) throw error;
    }
    this.#ownsPort = false;
  }
}

/**
 * 模拟总线：按同一套协议回帧，用于没有硬件时的开发与回归。
 * 必须始终标注为"模拟"，不得当作实机证据。
 */
export class MockTransport {
  constructor({ ids = [0, 1], latency = 1.2, dropRate = 0, echo = true, seed = 1 } = {}) {
    this.ids = new Set(ids);
    this.latency = latency;
    this.dropRate = dropRate;
    this.echo = echo;
    this.onData = () => {};
    this.onError = () => {};
    this.opened = false;
    this.random = mulberry32(seed);
    this.states = new Map();
    for (const id of ids) {
      this.states.set(id, {
        pos: id === 0 ? 0.35 : id === 1 ? -0.6 : id * 0.47,
        vel: 0,
        temp: 28 + id * 2,
        vol: 24,
        last: performance.now(),
      });
    }
  }

  async open() {
    this.opened = true;
  }

  async close() {
    this.opened = false;
  }

  step(state, cmd, now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - state.last) / 1000));
    state.last = now;
    if (cmd.mode === MODE.LOCK) {
      state.vel *= 0.6;
      state.pos += state.vel * dt;
      return 0;
    }
    let torque = cmd.tor + cmd.kp * (cmd.pos - state.pos) + cmd.kd * (cmd.spd - state.vel);
    torque = Math.max(-36.9, Math.min(36.9, torque));
    const inertia = 0.35; // 输出端等效转动惯量，仅用于让曲线像真实关节
    state.vel = Math.max(-25, Math.min(25, state.vel + (torque / inertia) * dt));
    state.pos = Math.max(-1428, Math.min(1428, state.pos + state.vel * dt));
    state.temp = Math.min(60, state.temp + Math.abs(torque) * dt * 0.02);
    state.vol = 24 - Math.abs(torque) * 0.02;
    return torque;
  }

  async write(packet) {
    if (!this.opened) throw Error('模拟串口未打开');
    if (this.echo) this.onData(packet.slice());
    const cmd = parseControl(packet);
    if (!cmd) return;
    const targets = cmd.id === BROADCAST_ID ? [...this.ids] : this.ids.has(cmd.id) ? [cmd.id] : [];
    for (const id of targets) {
      const state = this.states.get(id);
      const torque = this.step(state, cmd, performance.now());
      if (cmd.id === BROADCAST_ID) continue; // 广播无应答
      if (this.dropRate > 0 && this.random() < this.dropRate) continue;
      await sleep(this.latency * (0.7 + this.random() * 0.6));
      const reply = encodeFeedback({
        id,
        mode: cmd.mode,
        // 反馈帧的 timeout 位表示"舵机是否已进入超时保护"，与主机指令里的
        // timeout 位含义不同；模拟器持续收到指令，所以永远不置位。
        timeout: 0,
        temp: state.temp,
        sensor: state.temp + 8,
        vol: state.vol,
        tor: torque,
        spd: state.vel,
        pos: state.pos,
        error: 0,
        exPos: ((state.pos % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
      });
      // 拆成两段推送，覆盖分帧器跨 chunk 拼包路径。
      this.onData(reply.slice(0, 7));
      this.onData(reply.slice(7));
    }
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
