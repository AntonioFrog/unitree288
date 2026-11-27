// 串口工作线程：独占 Web Serial，负责扫描、控制循环、遥测与停机。
// 主线程只发声明过的操作，不在主线程做任何串口时序相关工作。
import { Bus, sleep } from './bus.mjs';
import { SerialTransport, MockTransport, samePortInfo } from './adapters.mjs';
import {
  BAUD_RATE,
  BROADCAST_ID,
  MAX_ID,
  MODE,
  LIMITS,
  buildControl,
  describeError,
  describeWarn,
} from './protocol.mjs';
import { DEFAULT_HZ, DEFAULT_LIMITS, LINK_MIN_SAMPLES, linkVerdict, sanitizeSetpoint, supervise } from './safety.mjs';
import { MODES, isPositionMode, resolveGains } from './control-law.mjs';
import { isDeviceId, writeStoppedDeviceId } from './id-config.mjs';

const state = {
  transport: null,
  bus: null,
  backend: null, // 'serial' | 'mock'
  portInfo: null,
  scanning: false,
  scanTask: null,
  scanStopIds: new Set(),
  cancelScan: false,
  changingId: false,
  opening: false,
  closing: false,
  stopTask: null,
  stopHold: false,
  stopUpgradeRequested: false,
  stopMode: null,
  stopFault: null,
  armed: false,
  monitoring: false,
  pageVisible: true,
  pausedMode: null,
  hz: DEFAULT_HZ,
  limits: { ...DEFAULT_LIMITS },
  loopToken: 0,
  loopIds: null,
  inFlight: null,
  lastHeartbeat: performance.now(),
  heartbeatWatch: null,
  lastPublish: 0,
  fault: null,
};

const devices = new Map(); // id -> { ...feedback, at, latency, setpoint, hz }
const setpoints = new Map(); // id -> { pos, spd, tor, kp, kd }
const samples = [];
const TELEMETRY_INTERVAL_MS = 60;

const post = (message) => self.postMessage(message);
const log = (level, message) => post({ type: 'log', level, message, at: Date.now() });

function publishSamples() {
  if (samples.length) post({ type: 'samples', samples: samples.splice(0, samples.length) });
}

function publish(force = false) {
  const now = performance.now();
  if (!force && now - state.lastPublish < TELEMETRY_INTERVAL_MS) return;
  state.lastPublish = now;
  const bus = state.bus;
  post({
    type: 'status',
    status: {
      connected: Boolean(state.bus && !state.bus.closed),
      backend: state.backend,
      portInfo: state.portInfo,
      baudRate: BAUD_RATE,
      scanning: state.scanning,
      changingId: state.changingId,
      opening: state.opening,
      closing: state.closing,
      stopping: Boolean(state.stopTask),
      checkingZeroOutput: Boolean(state.stopTask && !state.stopHold && !state.stopUpgradeRequested),
      resumePending: state.pausedMode !== null,
      stopMode: state.stopMode,
      armed: state.armed,
      monitoring: state.monitoring,
      activeIds: state.armed ? state.loopIds : [],
      hz: state.hz,
      loopHz: state.loopHz ?? 0,
      limits: state.limits,
      fault: state.stopFault ?? state.fault,
      bus: bus ? { ...bus.stats, pending: bus.pending } : null,
    },
  });
  // Deliver curve data before the device snapshot that triggers the UI refresh.
  publishSamples();
  post({
    type: 'devices',
    devices: [...devices.values()].map((d) => ({
      id: d.id,
      mode: d.mode,
      timeout: d.timeout,
      pos: d.pos,
      spd: d.spd,
      tor: d.tor,
      vol: d.vol,
      temp: d.temp,
      sensor: d.sensor,
      error: d.error,
      warn: d.warn,
      duplicate: d.duplicate === true,
      errorText: describeError(d.error),
      warnText: describeWarn(d.warn),
      exPos: d.exPos,
      at: d.at,
      latency: d.latency,
      hz: d.hz,
      capped: d.capped === true,
      setpoint: setpoints.get(d.id) ?? null,
    })),
  });
}

function requireBus() {
  if (!state.bus || state.bus.closed) throw Error('尚未连接串口');
  return state.bus;
}

async function openTransport({ backend, portInfo }) {
  if (state.bus) throw Error('串口已打开，请先断开');
  if (backend !== 'mock' && backend !== 'serial') throw Error('未知连接类型');

  let transport;
  let portInfoForStatus;
  if (backend === 'mock') {
    transport = new MockTransport({ ids: Array.from({ length: MAX_ID + 1 }, (_, id) => id) });
    portInfoForStatus = { simulated: true };
  } else {
    if (!navigator.serial) throw Error('当前浏览器不支持 Worker 中的 Web Serial');
    const ports = await navigator.serial.getPorts();
    const matches = ports.filter((port) => samePortInfo(port.getInfo(), portInfo ?? {}));
    if (matches.length !== 1) {
      throw Error('没有唯一匹配的已授权串口，请在主界面重新选择端口');
    }
    transport = new SerialTransport(matches[0]);
    portInfoForStatus = matches[0].getInfo();
  }

  let startupError;
  const bus = new Bus(transport, {
    timeout: 25,
    onDuplicate(id) {
      if (state.bus !== bus) return;
      const device = devices.get(id);
      if (device) device.duplicate = true;
      state.stopMode = null;
      state.pausedMode = null;
      state.fault = duplicateFault(bus);
      if (!state.scanning && !state.stopTask && !state.loopIds) {
        log('error', state.fault);
        publish(true);
      }
    },
    onError(error) {
      if (state.bus !== bus) {
        startupError = error;
        return;
      }
      state.fault = `串口连接中断：${error.message}`;
      log('error', state.fault);
      publish(true);
    },
  });
  try {
    await transport.open();
    if (startupError) throw startupError;
  } catch (error) {
    // Preserve the bus during cleanup so a later open waits for the same port to release.
    state.bus = bus;
    try {
      await closeTransport();
    } catch (closeError) {
      throw Error(`${error.message}。另外，${closeError.message}`, { cause: error });
    }
    throw error;
  }
  state.transport = transport;
  state.backend = backend;
  state.bus = bus;
  state.portInfo = portInfoForStatus;
  state.fault = null;
  state.stopFault = null;
  log('info', `已连接 ${backend === 'mock' ? '模拟设备' : '串口'}，${BAUD_RATE} bps 8N1`);
  publish(true);
}

async function closeTransport() {
  const interruptedScan = Boolean(state.scanTask);
  await state.scanTask?.catch(() => {});
  if (interruptedScan || state.scanStopIds.size || state.loopIds || state.stopTask
    || (devices.size && state.stopMode === null)) {
    await stop({ hold: interruptedScan || state.scanStopIds.size > 0 || !state.monitoring, reason: '断开连接' });
  }
  const bus = state.bus;
  if (bus) await bus.close();
  state.bus = null;
  state.transport = null;
  state.backend = null;
  state.portInfo = null;
  state.scanning = false;
  state.stopMode = null;
  devices.clear();
  setpoints.clear();
  samples.length = 0;
  state.scanStopIds.clear();
  log('info', '串口已关闭');
  publish(true);
}

async function scan({ keepStopped = false } = {}) {
  const bus = requireBus();
  if (state.armed) throw Error('运动中不允许扫描');
  if (state.scanning) throw Error('扫描进行中');
  if (!keepStopped && !state.pageVisible) throw Error('请回到前台后重新搜索节点');
  state.scanning = true;
  if (!keepStopped) state.stopMode = null;
  if (state.monitoring) await endLoop();
  publish(true);
  const scanned = new Map();
  const previouslyProbed = new Set([...devices.keys(), ...state.scanStopIds]);
  const crcAddresses = [];
  const mismatchedBefore = bus.stats.mismatched;
  const previousTimeout = bus.timeout;
  bus.timeout = 15;
  try {
    const mode = keepStopped ? MODE.LOCK : MODE.FOC;
    log('info', keepStopped ? '开始核验 ID 0–14（保持 Stop）' : '开始扫描 ID 0–14（每帧零力矩 FOC，不产生运动，不写入任何参数）');
    for (let id = 0; id <= MAX_ID; id++) {
      if (state.closing || state.cancelScan) return;
      const crcBefore = bus.stats.crcErrors;
      const packet = buildControl({ id, mode, timeout: 0, tor: 0, spd: 0, pos: 0, kp: 0, kd: 0 });
      try {
        const result = await bus.transact(packet, id, {
          observeMs: id === MAX_ID ? bus.timeout : 4,
          beforeWrite() {
            if (state.closing || state.cancelScan) return false;
            if (!keepStopped) state.scanStopIds.add(id);
            return true;
          },
        });
        if (!result) return;
        const duplicate = result.unexpected.some((frame) => frame.id === id);
        scanned.set(id, {
          ...result.feedback,
          duplicate,
          at: Date.now(),
          latency: result.latency,
          hz: 0,
        });
        log(duplicate ? 'warn' : 'info', `发现 ID ${id}${duplicate ? '（同一地址上有多个应答，疑似重号）' : ''}`);
      } catch (error) {
        if (error.code !== 'TIMEOUT') throw error;
      }
      if (bus.stats.crcErrors > crcBefore) crcAddresses.push(id);
    }
    if (state.closing || state.cancelScan) return;
    const abnormalDevice = [...scanned.values()].find((device) =>
      device.warn || supervise(device, state.limits).level !== 'ok');
    const communicationIssue = crcAddresses.length || bus.stats.mismatched !== mismatchedBefore;
    if (!keepStopped && scanned.size && !communicationIssue && !abnormalDevice) bus.duplicateIds.clear();
    const found = [...scanned.values()].map((device) => {
      device.duplicate = bus.duplicateIds.has(device.id);
      return { id: device.id, duplicate: device.duplicate };
    });
    if (!keepStopped) {
      // 全无应答时保留全部探测地址。部分应答但通信异常时，缺席的已知或有 CRC 的地址仍须核验。
      if (found.length) {
        state.scanStopIds.clear();
        if (communicationIssue) {
          for (const id of [...previouslyProbed, ...crcAddresses]) {
            if (!scanned.has(id)) state.scanStopIds.add(id);
          }
        }
        if (!state.scanStopIds.size) state.stopFault = null;
      }
      devices.clear();
      setpoints.clear();
      for (const [id, device] of scanned) devices.set(id, device);
    }
    if (!found.length) {
      log(
        'warn',
        '未发现任何舵机：检查供电、PH2.0 线序与 ID；' +
          '另外这块板上两个“USB 串行设备”口只有一个通总线，选错端口也会全部超时——换另一个口再试。',
      );
    } else log('info', `扫描完成，共 ${found.length} 台：${found.map((f) => f.id).join(', ')}`);
    const activationIssue = (communicationIssue || bus.duplicateIds.size)
      ? '扫描有通信异常，保持待机'
      : abnormalDevice ? `ID ${abnormalDevice.id} 反馈异常，保持待机` : '';
    state.fault = duplicateFault(bus) ?? (communicationIssue ? '扫描有 CRC 错误或非预期应答，请排查总线并重新扫描。' : null);
    if (!keepStopped) post({ type: 'scan-result', found, crcAddresses, activationIssue });
    return { found, crcAddresses, activationIssue, scanned };
  } finally {
    if (state.cancelScan || state.closing) {
      // Retain every address seen so the stop operation can reach newly discovered axes.
      for (const [id, device] of scanned) devices.set(id, { ...device, duplicate: bus.duplicateIds.has(id) });
    }
    if (state.cancelScan && !state.closing && !bus.closed) {
      state.fault = '扫描已中止。请重新扫描总线后再使能。';
    }
    bus.timeout = previousTimeout;
    state.scanning = false;
    state.cancelScan = false;
    publish(true);
  }
}

async function changeId({ from, to, unloaded }) {
  const bus = requireBus();
  if (state.backend !== 'serial') throw Error('修改 ID 需要连接真实舵机');
  if (!isDeviceId(from) || !isDeviceId(to) || from === to) throw Error('目标 ID 必须为 0–14，且与当前 ID 不同');
  if (unloaded !== true) throw Error('请确认待改号舵机的输出轴无负载');
  if (state.stopMode !== MODE.LOCK || state.scanning || state.scanTask || state.stopTask
    || state.opening || state.closing || state.stopFault || state.fault) {
    throw Error('请先停止总线，并确认设备进入 Stop 且通信正常');
  }
  state.changingId = true;
  publish(true);
  let phase = 'scan';
  try {
    const scanAddresses = async () => {
      const mismatched = bus.stats.mismatched;
      const { found, crcAddresses, activationIssue, scanned } = await scan({ keepStopped: true });
      if (crcAddresses.length || bus.stats.mismatched !== mismatched || found.some(({ duplicate }) => duplicate)) {
        throw Error('总线存在疑似重号或通信异常，无法核验设备地址');
      }
      if (activationIssue || [...scanned.values()].some((device) => device.mode !== MODE.LOCK)) {
        throw Error(`暂不能写入设备 ID：${activationIssue || '总线设备未确认进入 Stop'}`);
      }
      return scanned;
    };
    const before = await scanAddresses();
    if (!before.has(from) || Math.abs(before.get(from).spd) > 0.25) {
      throw Error(`未确认 ID ${from} 在线且已停稳`);
    }
    if (before.has(to)) throw Error(`目标 ID ${to} 已占用`);
    const missing = [...devices.keys()].filter((id) => !before.has(id));
    if (missing.length) throw Error(`改号前复扫未确认已知设备 ID ${missing.join('、')}，请检查连接后重扫`);
    const verified = await scanAddresses();
    if (verified.has(to)) throw Error(`目标 ID ${to} 已占用`);
    if (verified.size !== before.size || [...verified.keys()].some((id) => !before.has(id))
      || Math.abs(verified.get(from).spd) > 0.25) {
      throw Error('改号前两次核验结果不一致，请确认总线设备和停机状态后重试');
    }
    const expected = new Set(before.keys());
    expected.delete(from);
    expected.add(to);
    // 最后一帧定址 Stop 仍是普通总线事务。保留一个完整反馈窗口，再进入配置协议。
    phase = 'prepare';
    const { crcErrors, mismatched } = bus.stats;
    const failure = await confirmStop(bus, from, MODE.LOCK, bus.timeout);
    const source = devices.get(from);
    if (failure || bus.duplicateIds.size || bus.stats.crcErrors !== crcErrors || bus.stats.mismatched !== mismatched
      || source.warn || supervise(source, state.limits).level !== 'ok' || Math.abs(source.spd) > 0.25) {
      throw Error(`未能确认 ID ${from} 已停稳且应答正常：${failure || state.fault || '反馈异常，请重新扫描'}`);
    }
    log('info', `正在写入并保存设备地址 ID ${from} → ${to}`);
    await writeStoppedDeviceId(state.transport, from, to, () => { phase = 'write'; });
    log('info', '设备已确认保存，等待重启后核验地址');
    await sleep(500);
    let after = await scanAddresses();
    for (let attempt = 0; !after.has(to) && [...after.keys()].every((id) => expected.has(id)) && attempt < 2; attempt++) {
      await sleep(350);
      after = await scanAddresses();
    }
    if (after.size !== expected.size || [...after.keys()].some((id) => !expected.has(id))) {
      throw Error('复扫地址与预期不符，无法确认仅目标舵机改号');
    }
    if (Math.abs(after.get(to).spd) > 0.25) throw Error(`未确认 ID ${to} 已停稳`);
    devices.clear();
    for (const [id, device] of after) devices.set(id, device);
    log('info', `设备已改为 ID ${to}，旧地址无应答`);
  } catch (error) {
    if (phase !== 'scan') {
      if (phase === 'write') devices.delete(from);
      state.stopMode = null;
      setpoints.clear();
      state.fault = phase === 'write' ? `改号结果未确认。请给舵机重新上电后扫描地址。原因：${error.message}`
        : `改号已在写入地址前中止。原因：${error.message}`;
    }
    throw error;
  } finally {
    state.changingId = false;
    publish(true);
  }
  post({ type: 'id-change-result', ok: true, from, to });
}

function arm(ids) {
  requireBus();
  if (!state.pageVisible) throw Error('请回到调试台页面后再使能 FOC');
  if (state.scanning || state.stopTask || state.opening || state.closing) throw Error('请等待连接、扫描或停机操作完成');
  if (state.armed) return;
  if (!devices.size) throw Error('请先扫描设备');
  if (!Array.isArray(ids) || new Set(ids).size !== devices.size || ids.length !== devices.size) {
    throw Error('设备列表已变化，请重新确认全局使能范围');
  }
  for (const id of ids) {
    if (!devices.has(id)) throw Error(`ID ${id} 尚未扫描到，不能使能`);
    const device = devices.get(id);
    if (device.duplicate) throw Error(`ID ${id} 疑似重号，不能使能`);
    const verdict = supervise(device, state.limits);
    if (verdict.level === 'fault') throw Error(`ID ${id}：${verdict.reasons.join('；')}`);
  }
  if (state.stopFault || state.fault) throw Error('请先重新扫描总线，确认设备状态后再使能');
  // 每次全局使能都从零输出开始，等待新的目标下发。
  for (const id of ids) {
    setpoints.set(id, { ...ZERO_OUTPUT, mode: MODES.MANUAL, pos: devices.get(id).pos });
  }
  state.fault = null;
  state.stopMode = null;
  state.armed = true;
  state.monitoring = false;
  log('info', `开始 ${state.hz} Hz 控制循环：ID ${ids.join(', ')}`);
  startLoop(ids);
}

const ZERO_OUTPUT = Object.freeze({ pos: 0, spd: 0, tor: 0, kp: 0, kd: 0 });

function disable() {
  requireBus();
  if (!state.pageVisible) throw Error('请回到调试台页面后再开启零力矩监测');
  if (state.scanning || state.stopTask || state.opening || state.closing) throw Error('请等待连接、扫描或停机操作完成');
  if (state.monitoring) return;
  if (state.stopFault || state.fault) throw Error('请先确认停机或重新扫描总线');
  if (!devices.size) throw Error('请先扫描设备');
  if ([...devices.values()].some((device) => device.duplicate)) throw Error('存在疑似重号设备，无法开始监测');
  state.armed = false;
  state.monitoring = true;
  state.stopMode = null;
  setpoints.clear();
  log('info', '已切到卸力，开始零力矩监测');
  startLoop([...devices.keys()]);
}

function startLoop(ids) {
  const running = state.loopIds !== null;
  state.loopIds = ids;
  state.lastHeartbeat = performance.now();
  publish(true);
  if (!running) {
    state.heartbeatWatch = setInterval(() => {
      if (heartbeatExpired()) void stopForHeartbeat();
    }, 100);
    state.heartbeatWatch.unref?.();
    void controlLoop(++state.loopToken);
  }
}

async function controlLoop(token) {
  let next = performance.now();
  const link = { total: 0, timeouts: 0, checkedAt: next };
  let currentIds;
  const counter = new Map();
  const cycleTimes = [];

  while (state.loopIds && token === state.loopToken) {
    const ids = state.loopIds;
    const monitoring = state.monitoring;
    if (ids !== currentIds) {
      currentIds = ids;
      counter.clear();
      link.total = 0;
      link.timeouts = 0;
      link.checkedAt = performance.now();
    }
    const now = performance.now();
    cycleTimes.push(now);
    while (cycleTimes.length && cycleTimes[0] < now - 1000) cycleTimes.shift();
    state.loopHz = cycleTimes.length;
    // All axes in this cycle use the same setpoint snapshot.
    const targets = new Map(setpoints);
    for (const id of ids) {
      if (ids !== state.loopIds || token !== state.loopToken) break;
      if (heartbeatExpired()) {
        await stopForHeartbeat(token);
        return;
      }
      const lateDuplicate = duplicateFault(state.bus);
      if (lateDuplicate) {
        await stopAfterFault(lateDuplicate, token);
        return;
      }
      if (!counter.has(id)) {
        counter.set(id, { times: [], missedSince: null, modeMismatch: false, ready: false,
          total: 0, timeouts: 0, checkedAt: now });
      }
      const throughput = counter.get(id);
      const profile = targets.get(id);
      if (!monitoring && !profile) continue;
      // 模式 → 实际增益：力矩上限在这里生效（舵机固件没有这个参数）。
      // Wait for a valid FOC reply before commanding torque, including after a missed reply.
      const issuingTarget = !monitoring && throughput.ready;
      const gains = issuingTarget ? resolveGains(profile, devices.get(id)) : ZERO_OUTPUT;
      const packet = buildControl({
        id,
        mode: MODE.FOC,
        timeout: monitoring ? 0 : 1,
        pos: gains.pos,
        spd: gains.spd,
        tor: gains.tor,
        kp: gains.kp,
        kd: gains.kd,
      });

      try {
        state.inFlight = state.bus.transact(packet, id);
        const result = await state.inFlight;
        if (token !== state.loopToken) return;
        if (ids !== state.loopIds) break;
        const duplicate = duplicateFault(state.bus);
        if (duplicate) {
          await stopAfterFault(duplicate, token);
          return;
        }
        throughput.missedSince = null;
        const now = Date.now();
        // 1 秒滑动窗口内的应答数即实际反馈频率。
        throughput.times.push(now);
        while (throughput.times.length && throughput.times[0] < now - 1000) throughput.times.shift();
        devices.set(id, {
          ...result.feedback,
          at: now,
          latency: result.latency,
          hz: throughput.times.length,
          capped: gains.capped,
        });
        const { pos, exPos, spd, tor, vol, temp, sensor } = result.feedback;
        const targetPos = issuingTarget && (isPositionMode(profile.mode) || (profile.mode === MODES.MANUAL && profile.kp > 0))
          ? profile.pos : null;
        const targetSpd = issuingTarget && (profile.mode === MODES.VELOCITY || (profile.mode === MODES.MANUAL && profile.kd > 0))
          ? profile.spd : null;
        samples.push({ id, t: now, pos, exPos, spd, tor, vol, temp, sensor, targetPos, targetSpd });

        const modeMismatch = result.feedback.mode !== MODE.FOC;
        throughput.ready = !modeMismatch && !result.feedback.timeout;
        if (!monitoring && result.feedback.timeout) {
          await stopAfterFault(`ID ${id}：舵机超时保护已触发，请重新扫描后再使能`, token);
          return;
        }
        // 实机切换模式时首帧可能回报旧模式，以连续两帧不符作为确认失败。
        if (modeMismatch && throughput.modeMismatch) {
          await stopAfterFault(`ID ${id} 未确认${monitoring ? '零力矩监测' : 'FOC'}：反馈模式 ${result.feedback.mode}`, token);
          return;
        }
        throughput.modeMismatch = modeMismatch;
        const verdict = supervise(result.feedback, state.limits);
        if (verdict.level === 'fault') {
          await stopAfterFault(`ID ${id}：${verdict.reasons.join('；')}`, token);
          return;
        }
        if (verdict.level === 'warn' && verdict.reasons.length) {
          const key = `${id}:${verdict.reasons[0]}`;
          if (!state.lastWarn?.has?.(key)) {
            state.lastWarn ??= new Set();
            state.lastWarn.add(key);
            log('warn', `ID ${id}：${verdict.reasons.join('；')}`);
            setTimeout(() => state.lastWarn?.delete(key), 3000);
          }
        }
        throughput.total++;
        link.total++;
      } catch (error) {
        if (token !== state.loopToken) return;
        if (ids !== state.loopIds) break;
        if (error.code === 'TIMEOUT') {
          throughput.ready = false;
          const now = performance.now();
          throughput.missedSince ??= now;
          if (now - throughput.missedSince >= 250) {
            await stopAfterFault(`ID ${id} 持续无反馈`, token);
            return;
          }
          throughput.total++;
          throughput.timeouts++;
          link.total++;
          link.timeouts++;
          continue;
        }
        await stopAfterFault(`通信失败：${error.message}`, token, false);
        return;
      } finally {
        state.inFlight = null;
      }
    }

    if (ids !== state.loopIds) continue;

    const checkedAt = performance.now();
    for (const [id, throughput] of counter) {
      const fault = takeLinkFault(throughput, checkedAt);
      if (fault) {
        await stopAfterFault(`ID ${id}：${fault}`, token);
        return;
      }
    }
    const fault = takeLinkFault(link, checkedAt);
    if (fault) {
      await stopAfterFault(fault, token);
      return;
    }

    publish();
    publishSamples();
    const period = 1000 / state.hz;
    next += period;
    const wait = next - performance.now();
    if (wait < -period) next = performance.now(); // 严重落后时重置节奏，绝不补发积压帧
    await sleep(Math.max(0, wait));
  }
}

function duplicateFault(bus) {
  if (!bus.duplicateIds.size) return null;
  return `ID ${[...bus.duplicateIds].join('、')} ${state.loopIds ? '运行中' : ''}收到重复应答，疑似重号，请重新扫描`;
}

function takeLinkFault(stats, now) {
  // Keep low-frequency samples until there are enough for a meaningful rate.
  if (stats.total < LINK_MIN_SAMPLES || now - stats.checkedAt < 1000) return null;
  const verdict = linkVerdict(stats);
  stats.total = 0;
  stats.timeouts = 0;
  stats.checkedAt = now;
  return verdict.level === 'fault' ? verdict.reasons : null;
}

async function stopAfterFault(reason, token, hold = true) {
  if (token !== state.loopToken) return;
  state.fault = reason;
  await stop({ hold: hold && !state.monitoring, reason }, token);
}

function pauseForBackground(mode) {
  if (!state.fault && !state.stopFault) state.pausedMode = mode;
  return stop({ hold: mode === 'foc', reason: '页面进入后台' });
}

async function updatePageVisibility(visible) {
  if (visible === state.pageVisible) return;
  state.pageVisible = visible;
  if (!visible) {
    if (state.closing) return;
    if (state.scanTask) await stopAfterScan({ hold: true, reason: '扫描时页面进入后台' });
    else if (state.loopIds) await pauseForBackground(state.monitoring ? 'monitoring' : 'foc');
    return;
  }
  if (!state.pausedMode) return;

  // 快速切回时，等本次停机完成，再检查页面是否仍在前台。
  await state.stopTask;
  if (!state.pageVisible || !state.pausedMode) return;
  const wasFoc = state.pausedMode === 'foc';
  state.pausedMode = null;
  if (state.stopMode !== (wasFoc ? MODE.LOCK : MODE.FOC)
    || state.fault || state.stopFault || !state.bus || state.bus.closed || state.closing) return;

  if (wasFoc) arm([...devices.keys()]);
  else disable();
  log('info', `页面返回前台，已恢复${wasFoc ? ' FOC（零输出）' : '卸力监测'}`);
}

async function stopAfterScan(options) {
  state.pausedMode = null;
  if (state.scanTask) {
    state.cancelScan = true;
    await state.scanTask.catch(() => {});
  }
  await stop(options);
}

async function stop(options, token = state.loopToken) {
  if (token !== state.loopToken) return;
  const hold = options.hold !== false;
  if (state.stopTask) {
    if (!hold || state.stopHold) return state.stopTask;
    // A lock request takes precedence over an in-progress zero-output check.
    state.stopUpgradeRequested = true;
    await state.stopTask;
    return stop(options);
  }
  if (state.scanning) return;
  state.stopHold = hold;
  state.stopTask = sendStop(options);
  publish(true);
  try {
    await state.stopTask;
  } finally {
    state.stopTask = null;
    state.stopHold = false;
    state.stopUpgradeRequested = false;
    publish(true);
  }
}

async function endLoop() {
  clearInterval(state.heartbeatWatch);
  state.heartbeatWatch = null;
  state.armed = false;
  state.monitoring = false;
  state.loopIds = null;
  state.loopToken++;
  await state.inFlight?.catch(() => {});
  state.inFlight = null;
  state.loopHz = 0;
  for (const device of devices.values()) device.hz = 0;
}

async function sendStop({ hold = true, reason = '' } = {}) {
  state.stopMode = null;
  await endLoop();
  setpoints.clear();
  const bus = state.bus;
  const mode = hold ? MODE.LOCK : MODE.FOC;
  const ids = new Set([...devices.keys(), ...state.scanStopIds]);
  const pending = new Map([...ids].map((id) => [id, '连接已断开']));
  const unconfirmed = [];
  if (bus && !bus.closed) {
    // Send Stop to the whole bus before waiting on possibly unresponsive addresses.
    if (hold) {
      try {
        await bus.write(buildControl({ id: BROADCAST_ID, mode, timeout: 0 }));
      } catch (error) {
        unconfirmed.push(`广播 Stop 写入失败（${error.message}）`);
      }
    }
    for (let attempt = 0; attempt < 2 && !bus.closed; attempt++) {
      const remaining = [...pending.keys()];
      for (const id of remaining) {
        if (state.stopUpgradeRequested) return;
        if (bus.closed) break;
        // 最后一台也留出一个完整的反馈窗口，再宣布停机完成或恢复控制。
        const observeMs = id === remaining.at(-1) ? bus.timeout : 4;
        const failure = await confirmStop(bus, id, mode, observeMs);
        if (failure) {
          pending.set(id, failure);
        } else {
          pending.delete(id);
          state.scanStopIds.delete(id);
        }
      }
    }
  }
  if (state.stopUpgradeRequested) return;
  for (const id of bus?.duplicateIds ?? []) pending.set(id, '疑似重号，无法逐台确认');
  if (!ids.size && bus && !bus.closed) unconfirmed.push('没有可逐台核验的设备地址');
  for (const [id, failure] of pending) unconfirmed.push(`ID ${id}（${failure}）`);
  if (unconfirmed.length) {
    state.stopFault = `停止指令未获确认：${unconfirmed.join('、')}${reason ? `（${reason}）` : ''}。请确认舵机已停稳。`;
    log('error', state.stopFault);
  } else if (bus && !bus.closed && ids.size) {
    state.stopFault = null;
    state.stopMode = mode;
    log('warn', `已停止并将全部设备切到 ${hold ? 'Stop' : '零力矩 FOC'}${reason ? `：${reason}` : ''}`);
  }
}

async function confirmStop(bus, id, mode, observeMs) {
  try {
    const { feedback, latency } = await bus.transact(buildControl({ id, mode, timeout: 0 }), id, { observeMs });
    const duplicate = bus.duplicateIds.has(id) || devices.get(id)?.duplicate === true;
    devices.set(id, { ...feedback, duplicate, at: Date.now(), latency, hz: 0 });
    const verdict = supervise(feedback, state.limits);
    if (verdict.level === 'fault') {
      state.pausedMode = null;
      const fault = `ID ${id}：${verdict.reasons.join('；')}`;
      if (state.fault !== fault) log('error', fault);
      state.fault ??= fault;
    }
    if (duplicate) return '疑似重号，无法逐台确认';
    if (feedback.mode !== mode) return `反馈模式 ${feedback.mode}，期望 ${mode}`;
    if (feedback.timeout) return '反馈仍处于超时保护';
    return null;
  } catch (error) {
    return error.code === 'TIMEOUT' ? '等待反馈超时' : error.message;
  }
}

function apply(id, target) {
  if (!devices.has(id)) throw Error(`ID ${id} 未在线`);
  const { setpoint, clipped } = sanitizeSetpoint(target, state.limits);
  setpoints.set(id, setpoint);
  if (clipped.length) {
    // 输入框每次按键都会重发整组设定点，同一截断提示 3 秒内只记一次。
    const key = `${id}:${clipped.join(',')}`;
    state.clipNotes ??= new Map();
    const now = Date.now();
    if ((state.clipNotes.get(key) ?? 0) + 3000 < now) {
      state.clipNotes.set(key, now);
      log('warn', `ID ${id} 的 ${clipped.join('、')} 已按安全上限截断`);
    }
  }
}

/** 主线程每 200 ms 续约一次；隐藏页面不再续约，控制循环会自行停机。 */
function heartbeat() {
  state.lastHeartbeat = performance.now();
}

const heartbeatExpired = () => performance.now() - state.lastHeartbeat > 600;
const stopForHeartbeat = (token) => stop({ hold: !state.monitoring, reason: '页面心跳丢失，自动停机' }, token);

self.onmessage = async ({ data: message }) => {
  try {
    if (state.changingId && message.type !== 'visibility') {
      if (message.type === 'heartbeat') return;
      throw Error('设备正在改号，请等待写入和核验完成');
    }
    switch (message.type) {
      case 'open':
        if (state.opening || state.closing) throw Error('连接状态正在切换，请稍候');
        state.pausedMode = null;
        state.opening = true;
        publish(true);
        try {
          if (state.bus?.closed) await closeTransport();
          await openTransport(message);
        } finally {
          state.opening = false;
          publish(true);
        }
        break;
      case 'close':
        if (state.opening || state.closing) throw Error('连接状态正在切换，请稍候');
        state.pausedMode = null;
        state.closing = true;
        publish(true);
        try {
          await closeTransport();
        } finally {
          state.closing = false;
          publish(true);
        }
        break;
      case 'scan': {
        if (state.scanTask || state.opening || state.closing || state.stopTask) throw Error('请等待当前总线操作完成');
        state.pausedMode = null;
        const resumeMonitoring = state.monitoring;
        state.scanTask = scan();
        let result;
        try {
          result = await state.scanTask;
        } finally {
          state.scanTask = null;
        }
        if (resumeMonitoring && result?.found.length && !state.closing) {
          if (result.activationIssue) {
            log('warn', result.activationIssue);
          } else if (state.pageVisible) {
            disable();
          } else {
            await pauseForBackground('monitoring');
          }
        }
        break;
      }
      case 'change-id':
        state.pausedMode = null;
        await changeId(message);
        break;
      case 'limits':
        if (state.armed || state.scanning || state.scanTask || state.stopTask || state.opening || state.closing) {
          throw Error('请在控制循环未使能且总线空闲时应用设定值上限');
        }
        state.limits = { ...state.limits };
        for (const key of ['tor', 'spd', 'kp', 'kd']) {
          const value = message.limits?.[key];
          if (Number.isFinite(value)) state.limits[key] = Math.max(0, Math.min(LIMITS[key], value));
        }
        publish(true);
        post({ type: 'limits-applied' });
        break;
      case 'hz':
        if (!Number.isFinite(message.hz)) throw Error('控制频率必须是有效数字');
        state.hz = Math.min(200, Math.max(10, Math.round(message.hz)));
        log('info', `控制频率设为 ${state.hz} Hz`);
        publish(true);
        break;
      case 'apply':
        if (!state.armed) throw Error('请先切到 FOC 再下发目标');
        apply(message.id, message.setpoint);
        publish(true);
        break;
      case 'apply-broadcast': {
        const targets = message.targets;
        if (!state.armed) throw Error('请先切到 FOC 再下发目标');
        if (!Array.isArray(targets) || targets.length !== devices.size
          || new Set(targets.map(({ id }) => id)).size !== devices.size
          || targets.some(({ id }) => !devices.has(id))) throw Error('设备列表已变化，请重新确认广播范围');
        for (const { id, setpoint } of targets) apply(id, setpoint);
        if (!message.automatic) log('info', `已下发广播目标 · ${targets.length} 台`);
        publish(true);
        break;
      }
      case 'arm':
        arm(message.ids);
        break;
      case 'disable':
        disable();
        break;
      case 'stop':
        await stopAfterScan({ hold: message.hold !== false, reason: message.reason ?? '用户操作' });
        break;
      case 'visibility':
        await updatePageVisibility(message.visible);
        break;
      case 'heartbeat':
        heartbeat();
        break;
      default:
        throw Error(`未知操作：${message.type}`);
    }
  } catch (error) {
    log('error', error?.message ?? String(error));
    post({ type: 'error', operation: message.type, message: error?.message ?? String(error) });
  }
};

publish(true);
