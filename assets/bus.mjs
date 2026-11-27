// 单事务总线：同一时刻只允许一个在途请求，超时即判定该轮失败。
// 半双工单总线没有队列概念，积压请求只会造成控制延迟，因此这里直接拒绝并发。
import { Framer } from './protocol.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export class Bus {
  #transport;
  #framer = new Framer();
  #pending = null;
  #retryAfter = new Map();
  #replySeen = new Map(); // 每个已发请求的地址自上次写出后是否收到过有效反馈，含迟到帧。
  duplicateIds = new Set(); // 包括事务结束后到达的第二帧，直到一次完整的正常复扫才清除。
  #busy = false;
  #closed = false;
  #closeTask = null;
  #onError;
  #onDuplicate;

  constructor(transport, { timeout = 25, onError = () => {}, onDuplicate = () => {} } = {}) {
    this.#transport = transport;
    this.#onError = onError;
    this.#onDuplicate = onDuplicate;
    this.timeout = timeout;
    this.stats = {
      requests: 0,
      responses: 0,
      timeouts: 0,
      mismatched: 0,
      bytesOut: 0,
      bytesIn: 0,
      echoes: 0,
      crcErrors: 0,
      noise: 0,
    };
    transport.onData = (chunk) => this.#receive(chunk);
    transport.onError = (error) => this.#invalidate(error);
  }

  get closed() {
    return this.#closed;
  }

  get pending() {
    return this.#busy ? 1 : 0;
  }

  #receive(chunk) {
    if (this.#closed) return;
    this.stats.bytesIn += chunk.length;
    const frames = this.#framer.push(chunk);
    this.stats.echoes = this.#framer.stats.echo;
    this.stats.crcErrors = this.#framer.stats.crcErrors;
    this.stats.noise = this.#framer.stats.noise;

    const pending = this.#pending;
    for (const frame of frames) {
      const alreadyAnswered = this.#replySeen.get(frame.id);
      if (alreadyAnswered === false) this.#replySeen.set(frame.id, true);
      if (!pending || frame.id !== pending.id || pending.feedback) {
        pending?.unexpected.push(frame);
        this.stats.mismatched++;
        if (alreadyAnswered && !this.duplicateIds.has(frame.id)) {
          this.duplicateIds.add(frame.id);
          this.#onDuplicate(frame.id);
        }
        continue;
      }
      pending.feedback = frame;
      pending.resolve(frame);
    }
  }

  #fail(error) {
    this.#closed = true;
    const pending = this.#pending;
    this.#pending = null;
    if (pending) pending.reject(error);
  }

  #invalidate(error) {
    if (this.#closed) return;
    this.#fail(error);
    this.#onError(error);
  }

  /**
   * 发送一帧控制包并等待同 ID 的反馈帧。
   * beforeWrite 在真正写出前执行，返回 false 时取消本次请求并返回 null。
   * @returns {Promise<{feedback: object, latency: number, unexpected: object[]}|null>}
   */
  async transact(packet, id, { observeMs = 0, beforeWrite } = {}) {
    if (this.#closed) throw Error('串口已关闭');
    if (this.#busy) throw Error('总线忙：禁止并发事务');
    this.#busy = true;
    const unexpected = [];
    let written = false;
    let timer;

    try {
      // 反馈帧没有事务序号。同一地址超时后留出一个应答窗口，丢弃迟到的回包。
      const wait = (this.#retryAfter.get(id) ?? 0) - performance.now();
      // 即使无隔离期也先让调用方登记在途事务，之后从取消检查到写出不再让出执行权。
      await (wait > 0 ? sleep(Math.ceil(wait)) : undefined);
      if (this.#closed) throw Error('串口已关闭');
      if (beforeWrite?.() === false) return null;
      this.#retryAfter.delete(id);
      this.#replySeen.set(id, false);
      this.stats.requests++;
      const started = performance.now();
      const answer = new Promise((resolve, reject) => {
        this.#pending = { id, unexpected, resolve, reject };
      });
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          this.stats.timeouts++;
          const message = written
            ? `等待 ID ${id} 反馈超时（${this.timeout} ms）`
            : `串口写入超时（${this.timeout} ms）`;
          reject(Object.assign(Error(message), { code: written ? 'TIMEOUT' : 'WRITE_TIMEOUT' }));
        }, this.timeout);
      });

      this.stats.bytesOut += packet.length;
      const write = (async () => {
        await this.#transport.write(packet);
        written = true;
      })();
      const [, frame] = await Promise.race([Promise.all([write, answer]), deadline]);
      clearTimeout(timer);
      const latency = performance.now() - started;
      // 扫描时短暂保留本次事务，收集后续 USB 读块中的重复应答。
      if (observeMs > 0) {
        await sleep(observeMs);
        if (this.#closed) throw Error('串口在扫描期间断开');
      }
      this.stats.responses++;
      return { feedback: frame, latency, unexpected };
    } catch (error) {
      if (error?.code === 'TIMEOUT') {
        this.#retryAfter.set(id, performance.now() + this.timeout);
      } else {
        this.#invalidate(error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.#pending = null;
      this.#busy = false;
    }
  }

  /** 广播帧（ID 15）没有应答，只写不读。 */
  async write(packet) {
    if (this.#closed) throw Error('串口已关闭');
    if (this.#busy) throw Error('总线忙：禁止并发事务');
    this.#busy = true;
    try {
      this.stats.bytesOut += packet.length;
      await this.#transport.write(packet);
    } catch (error) {
      this.#invalidate(error);
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async close() {
    if (!this.#closeTask) {
      this.#fail(Error('连接已断开'));
      this.#closeTask = Promise.resolve().then(() => this.#transport.close?.()).catch((error) => {
        this.#closeTask = null;
        throw error;
      });
    }
    await this.#closeTask;
  }
}
