// 界面层：只负责输入、渲染和心跳续约；所有串口时序都在 worker 中。
import { DEFAULT_HZ, DEFAULT_LIMITS } from './safety.mjs';
import { LIMITS, MAX_ID, MODE } from './protocol.mjs';
import { MODES, SINGLE_TURN_MAX, isPositionMode } from './control-law.mjs';
import { samePortInfo } from './adapters.mjs';
import { fitPlotRange } from './plot-range.mjs';

const BROADCAST_DRAFT = Symbol('broadcastDraft');
const $ = (selector) => document.querySelector(selector);

const ui = {
  badge: $('#conn-badge'),
  connectionState: $('#diagnostics-connection-state'),
  fault: $('#connection-fault'),
  notice: $('#notice'),
  latestNotice: $('#latest-notice'),
  portName: $('#port-name'),
  portConflictNote: $('#port-conflict-note'),
  forgetOtherPorts: $('#forget-other-ports'),
  connect: $('#connect'),
  mock: $('#mock'),
  mockNote: $('#mock-note'),
  scan: $('#scan'),
  deviceCount: $('#device-count .stable-number'),
  controlHz: $('#hz'),
  scanSummary: $('#scan-summary'),
  scanWarning: $('#scan-warning'),
  dupWarning: $('#dup-warning'),
  openIdChange: $('#open-id-change'),
  currentDeviceCard: $('#current-device-card'),
  participantTitle: $('.participant-title'),
  participantState: $('.participant-state'),
  limitsDialog: $('#limits-dialog'),
  applyLimits: $('#apply-limits'),
  idDialog: $('#id-change-dialog'),
  idForm: $('#id-change-form'),
  idSubmit: $('#id-change-form button[type="submit"]'),
  closeIdChange: $('#close-id-change'),
  idOptions: $('#id-options'),
  idUnloaded: $('#id-unloaded'),
  idResult: $('#id-change-result'),
  arm: $('#arm'),
  apply: $('#apply-target'),
  disarm: $('#disarm'),
  stopMotor: $('#stop-motor'),
  updateManual: $('#update-manual'),
  updateAuto: $('#update-auto'),
  singleControl: $('#single-control'),
  broadcast: $('#broadcast'),
  deviceRows: $('#device-rows'),
  deviceEmpty: $('.device-empty'),
  deviceEmptyTitle: $('#device-empty-title'),
  deviceEmptyHint: $('#device-empty-hint'),
  deviceEmptyMock: $('#device-empty-mock'),
  modeButtons: [...document.querySelectorAll('[data-run-mode]')],
  targetState: $('#target-state'),
  modeHint: $('#mode-hint'),
  modeWarn: $('#mode-warn'),
  modeFields: [...document.querySelectorAll('.mode-fields')],
  positionKinds: [...document.querySelectorAll('[data-position-kind]')],
  singlePos: $('#single-pos'),
  singleTravelPosition: $('#single-travel-position'),
  setPos: $('#set-pos'),
  posAngle: $('#pos-angle'),
  multiReference: $('#multi-reference'),
  multiReferenceField: $('#multi-reference-field'),
  positionGoalLabel: $('#position-goal-label'),
  posTmax: $('#pos-tmax'),
  posKp: $('#pos-kp'),
  posKd: $('#pos-kd'),
  posTmaxLabel: $('#pos-tmax-label'),
  posKpLabel: $('#pos-kp-label'),
  posKdLabel: $('#pos-kd-label'),
  velSpd: $('#vel-spd'),
  velSpdLabel: $('#vel-spd-label'),
  velRpmLabel: $('#vel-rpm-label'),
  velZero: $('#vel-zero'),
  velKd: $('#vel-kd'),
  velTmax: $('#vel-tmax'),
  velKdLabel: $('#vel-kd-label'),
  velTmaxLabel: $('#vel-tmax-label'),
  manPos: $('#man-pos'),
  manSpd: $('#man-spd'),
  manTor: $('#man-tor'),
  manKp: $('#man-kp'),
  manKd: $('#man-kd'),
  log: $('#log'),
  logDialog: $('#log-dialog'),
  logNotice: $('#log-notice'),
  diagnosticsPanel: $('#diagnostics-panel'),
  plot: $('#plot'),
  plotSeries: $('#plot-series'),
  plotStatus: $('#plot-status'),
  plotWindow: $('#plot-window'),
  plotEmpty: $('#plot-empty'),
  plotTooltip: $('#plot-tooltip'),
};

const app = {
  worker: null,
  workerFailed: false,
  autoScan: false,
  disconnecting: false,
  armAfterConnect: false,
  idChangePending: false,
  applyingLimits: false,
  idChangeFrom: null,
  idChangeTo: null,
  status: null,
  devices: new Map(),
  selectedId: null,
  profiles: new Map(),
  selectedPort: null,
  conflictingPorts: [],
  checkingPorts: false,
  heartbeatTimer: null,
  series: new Map(), // id -> [{t, pos}]
  resumedIds: new Set(),
  feedbackFrame: null,
  mode: MODES.SINGLE_TURN,
  initializedFor: null,
  arming: false,
  disabling: false,
  stopPending: false,
  liveTargetTimer: null,
  autoTarget: true,
  broadcast: true,
  broadcastRelative: false,
  resolvedBroadcastPosition: null,
};

/* ---------------- worker ---------------- */

function startWorker() {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (app.workerFailed) return;
    switch (data.type) {
      case 'status': {
        const running = data.status.armed || data.status.monitoring;
        if (running && !(app.status?.armed || app.status?.monitoring)) {
          app.resumedIds = new Set(app.series.keys());
        }
        const supportsVisibility = Array.isArray(data.status.activeIds);
        if (!app.status) {
          if (!supportsVisibility) appendLog('warn', '已加载旧版控制线程。请刷新页面以使用前台自动恢复。');
          else if (document.hidden) post({ type: 'visibility', visible: false });
        }
        if ((app.status?.armed || app.status?.monitoring) && !running) {
          stopHeartbeat();
        }
        if (app.status?.armed && !data.status.armed) {
          app.resolvedBroadcastPosition = null;
          cancelLiveTarget();
        }
        const disconnected = app.status?.connected && !data.status.connected;
        const wasStopping = app.status?.stopping;
        app.status = data.status;
        if (data.status.closing || !data.status.connected) app.disconnecting = false;
        if (disconnected) {
          resetScanSummary();
          clearDeviceSession();
        }
        if (data.status.monitoring || !data.status.connected) app.disabling = false;
        if (data.status.stopping || wasStopping || !data.status.connected) app.stopPending = false;
        if (data.status.armed) app.arming = false;
        if (running && document.hidden && !supportsVisibility && !app.stopPending && !data.status.stopping) {
          requestStop(!data.status.monitoring, '页面进入后台');
        }
        if (running && data.status.connected && !data.status.closing && !app.disconnecting
          && !document.hidden && !app.heartbeatTimer && !app.stopPending) startHeartbeat();
        if (app.autoScan && data.status.connected && !data.status.opening) {
          app.autoScan = false;
          app.armAfterConnect = !document.hidden;
          setTargetUpdateMode(true);
          resetScanSummary();
          if (document.hidden) appendLog('warn', '连接已建立。请返回前台后点击「搜索节点」。');
          else post({ type: 'scan' });
        }
        renderStatus();
        break;
      }
      case 'devices': {
        if (!app.status?.connected) break;
        const previous = app.devices;
        app.devices = new Map(data.devices.map((d) => [d.id, d]));
        for (const id of previous.keys()) {
          if (app.devices.has(id)) continue;
          app.series.delete(id);
          app.profiles.delete(id);
        }
        if (!app.devices.has(app.selectedId)) app.selectedId = null;
        if (app.selectedId === null && data.devices.length) {
          selectDevice(data.devices[0].id);
        } else {
          renderDevices();
          renderStatus();
        }
        break;
      }
      case 'scan-result': {
        const shouldArm = app.armAfterConnect && !document.hidden && !app.stopPending && !app.status?.closing;
        app.armAfterConnect = false;
        app.profiles.clear();
        app.initializedFor = null;
        app.series.clear();
        renderFeedback(false);
        app.resolvedBroadcastPosition = null;
        ui.dupWarning.hidden = !data.found.some((item) => item.duplicate);
        const crc = data.crcAddresses ?? [];
        ui.scanSummary.textContent = crc.length
          ? `探测 ID ${crc.join('、')} 时收到 CRC 错误。请检查连线、供电和是否重号。`
          : data.found.length ? `发现 ${data.found.length} 台舵机。` : '未收到有效应答，请检查供电和所选串口。';
        ui.scanSummary.title = ui.scanSummary.textContent;
        setStatusMessage(ui.scanWarning, crc.length || !data.found.length ? ui.scanSummary.textContent
          : shouldArm ? data.activationIssue : '');
        renderNotice();
        if (shouldArm && data.found.length && !data.activationIssue) {
          startFoc(data.found.map(({ id }) => id));
        }
        break;
      }
      case 'samples': {
        if (!app.status?.connected) break;
        for (const { id, ...sample } of data.samples) {
          const list = app.series.get(id) ?? [];
          if (app.resumedIds.delete(id) && list.length) sample.afterPause = true;
          list.push(sample);
          const cutoff = sample.t - PLOT_RETENTION_MS;
          // Keep one predecessor, even across a long pause, to locate the start of a visible gap.
          const trim = list.length > 1 && list[1].t < cutoff - 1000;
          app.series.set(id, trim ? list.slice(list.findIndex((point) => point.t >= cutoff) - 1) : list);
        }
        if (data.samples.some(({ id }) => id === app.selectedId)) scheduleFeedbackFrame();
        break;
      }
      case 'log':
        appendLog(data.level, data.message, data.at);
        break;
      case 'id-change-result':
        if (app.devices.has(data.to)) selectDevice(data.to);
        finishIdChange(`已保存 ID ${data.to}。新地址应答正常，旧地址 ID ${data.from} 无应答。`);
        break;
      case 'limits-applied':
        app.applyingLimits = false;
        appendLog('info', '已应用浏览器控制台的设定值上限');
        ui.limitsDialog.close();
        renderStatus();
        break;
      case 'error':
        if (data.operation === 'open' || data.operation === 'close') {
          if (data.operation === 'open') app.autoScan = false;
          else app.disconnecting = false;
          renderStatus();
        }
        if (data.operation === 'scan') app.armAfterConnect = false;
        if (data.operation === 'arm' && !app.status?.armed) {
          app.arming = false;
          if (!app.status?.monitoring) stopHeartbeat();
          renderStatus();
        }
        if (data.operation === 'disable') {
          app.disabling = false;
          if (!app.status?.armed && !app.status?.monitoring) stopHeartbeat();
          renderStatus();
        }
        if (data.operation === 'stop') {
          app.stopPending = false;
          renderStatus();
        }
        if (data.operation === 'change-id') finishIdChange(app.status?.fault || data.message, true);
        if (data.operation === 'limits') {
          app.applyingLimits = false;
          renderStatus();
        }
        break;
      default:
        break;
    }
  };
  worker.onerror = (event) => {
    if (app.workerFailed) return;
    worker.postMessage({ type: 'stop', hold: true, reason: '控制线程异常' });
    stopHeartbeat();
    app.workerFailed = true;
    const fault = '控制线程中断。请确认舵机已停稳，再刷新页面恢复。';
    app.status = { connected: false, fault };
    clearDeviceSession();
    appendLog('error', `${fault}（${event.message || '未知错误'}）`);
    if (app.idChangePending) finishIdChange('改号结果未确认。请重新上电并扫描设备地址。', true);
    renderStatus();
  };
  return worker;
}

const post = (message) => app.worker.postMessage(message);

function clearDeviceSession() {
  stopHeartbeat();
  cancelLiveTarget();
  app.devices.clear();
  app.profiles.clear();
  app.series.clear();
  app.selectedId = null;
  app.initializedFor = null;
  app.resolvedBroadcastPosition = null;
  renderDevices();
}

function appendLog(level, message, at = Date.now()) {
  ui.latestNotice.textContent = message;
  ui.latestNotice.dataset.level = level;
  renderNotice();
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
  const tag = document.createElement('span');
  tag.className = `lvl-${level}`;
  tag.textContent = { info: '信息', warn: '警告', error: '错误' }[level] ?? level;
  const body = document.createElement('span');
  body.className = 'msg';
  body.textContent = message;
  li.append(time, tag, body);
  ui.log.prepend(li);
  while (ui.log.children.length > 300) ui.log.lastChild.remove();
}

/* ---------------- 渲染 ---------------- */

function setStatusMessage(element, message) {
  if (element.textContent !== message) element.textContent = message;
  element.hidden = !message;
}

function renderNotice() {
  const warning = [!ui.forgetOtherPorts.hidden && ui.portConflictNote, !ui.dupWarning.hidden && ui.dupWarning,
    !ui.scanWarning.hidden && ui.scanWarning, !ui.modeWarn.hidden && ui.modeWarn].find(Boolean);
  const fault = !ui.fault.hidden ? ui.fault : null;
  const latest = ui.latestNotice;
  const item = fault ?? (latest.dataset.level === 'error' ? latest : warning || latest);
  const level = item === fault ? 'error' : item === warning ? 'warn' : latest.dataset.level;
  const message = item.textContent;
  if (ui.notice.textContent !== message) {
    ui.notice.textContent = message;
    ui.notice.title = message;
  }
  if (ui.notice.dataset.level !== level) ui.notice.dataset.level = level;
  setStatusMessage(ui.logNotice, level === 'warn' || level === 'error' ? message : '');
  if (ui.logNotice.dataset.level !== level) ui.logNotice.dataset.level = level;
}

function renderStatus() {
  const status = app.status;
  const connected = status?.connected ?? false;
  const armed = status?.armed ?? false;
  const monitoring = status?.monitoring ?? false;
  const stopped = status?.stopMode === MODE.LOCK;
  const changingId = app.idChangePending || status?.changingId;
  const busy = app.autoScan || app.disconnecting || status?.opening || status?.closing
    || status?.stopping || app.stopPending || app.disabling || changingId;
  const unavailable = busy || app.workerFailed;

  const fault = status?.fault ?? '';
  setStatusMessage(ui.fault, fault);
  let connectionState = '未连接';
  let badgeClass = 'badge';
  if (busy) {
    badgeClass = 'badge badge-busy';
    connectionState = changingId ? '正在改号' : status?.closing || app.disconnecting ? '正在断开'
      : app.disabling ? '正在切换监测'
      : status?.stopping || app.stopPending ? '正在停机' : '正在连接';
  } else if (connected) {
    const mock = status.backend === 'mock';
    badgeClass = mock ? 'badge badge-mock' : 'badge badge-live';
    connectionState = mock ? '模拟中' : '已连接';
  }
  if (ui.badge.className !== badgeClass) ui.badge.className = badgeClass;
  if (ui.connectionState.textContent !== connectionState) {
    ui.connectionState.textContent = connectionState;
    ui.badge.setAttribute('aria-label', connectionState);
    ui.badge.title = connectionState;
  }
  ui.mockNote.classList.toggle('hidden', status?.backend !== 'mock');
  ui.connect.disabled = unavailable || app.checkingPorts;
  ui.connect.classList.toggle('btn-primary', !connected);
  const connectionAction = connected ? '断开连接' : '连接设备';
  if (ui.connect.textContent !== connectionAction) ui.connect.textContent = connectionAction;
  ui.scan.disabled = busy || !connected || status?.scanning || armed || app.arming;
  const ids = targetIds();
  const broadcast = app.broadcast;
  ui.singleControl.setAttribute('aria-pressed', String(!broadcast));
  ui.broadcast.setAttribute('aria-pressed', String(broadcast));
  ui.controlHz.disabled = unavailable;
  ui.arm.disabled = busy || !connected || status?.scanning || armed || app.arming || app.applyingLimits || Boolean(fault) || ids.length === 0
    || [...app.devices.values()].some((device) => device.duplicate);
  ui.arm.setAttribute('aria-pressed', String(armed));
  ui.disarm.setAttribute('aria-pressed', String(monitoring));
  ui.stopMotor.setAttribute('aria-pressed', String(stopped));
  ui.apply.disabled = !canApplyTarget(ids);
  ui.applyLimits.disabled = unavailable || armed || app.arming || app.applyingLimits || status?.scanning;
  const targetHint = monitoring ? '零力矩监测中，切到 FOC 后可下发目标。'
    : app.autoTarget ? '键入数值后按回车或移开焦点下发。目标角度框聚焦时，滚轮可实时微调 1°。滑块和快捷操作自动下发。'
    : '编辑只更新草稿。使能后点击「更新控制目标」。';
  if (ui.targetState.textContent !== targetHint) ui.targetState.textContent = targetHint;
  const canInterruptStop = connected && status.stopping && (status.checkingZeroOutput || status.resumePending)
    && !app.stopPending && !app.disconnecting && !status.closing;
  ui.disarm.disabled = busy || !connected || !app.devices.size || status?.scanning || monitoring || Boolean(fault);
  ui.stopMotor.disabled = (!canInterruptStop && (busy || !connected)) || (stopped && !status?.resumePending);
  ui.mock.disabled = unavailable || connected || app.checkingPorts;
  ui.deviceEmptyMock.hidden = connected;
  const emptyTitle = status?.scanning ? '正在扫描设备' : connected ? '未发现设备' : '等待设备接入';
  if (ui.deviceEmptyTitle.textContent !== emptyTitle) ui.deviceEmptyTitle.textContent = emptyTitle;
  ui.deviceEmptyHint.hidden = connected;
  ui.forgetOtherPorts.hidden = connected || app.conflictingPorts.length === 0;
  renderNotice();
  ui.forgetOtherPorts.disabled = unavailable || app.checkingPorts;
  renderIdChange();

  // 速度滑块的可调范围跟随"安全上限 · 转速"，避免设了却被静默截断。
  const spdLimit = app.status?.limits?.spd ?? 4;
  ui.velSpd.min = String(-spdLimit);
  ui.velSpd.max = String(spdLimit);
  if (Number(ui.velSpd.value) > spdLimit) ui.velSpd.value = String(spdLimit);
  if (Number(ui.velSpd.value) < -spdLimit) ui.velSpd.value = String(-spdLimit);

  if (!connected) {
    app.series.clear();
    renderDeviceCard();
  }
  if (ui.logDialog.open && !ui.diagnosticsPanel.hidden) renderStats();
}

function addressCandidate() {
  const status = app.status;
  if (app.workerFailed || app.idChangePending || !status?.connected || status.backend !== 'serial'
    || status.stopMode !== MODE.LOCK || status.scanning || status.opening || status.closing || status.stopping
    || status.changingId || status.fault) return null;
  const device = app.devices.get(app.selectedId);
  return !device || device.duplicate || device.error || Math.abs(device.spd) > 0.25 ? null : device.id;
}

function canWriteId(id) {
  return id !== null && id === app.idChangeFrom
    && app.idChangeTo !== null && !app.devices.has(app.idChangeTo) && ui.idUnloaded.checked;
}

function renderIdChange() {
  const id = addressCandidate();
  const pending = app.idChangePending;
  ui.openIdChange.disabled = id === null;
  const hint = id === null ? '连接真实舵机并完成扫描，点击「停止」并等待舵机停稳后可修改 ID。'
    : `仅修改当前设备 ID ${id}，目标地址可选 0–${MAX_ID} 中的空闲 ID。`;
  if (ui.openIdChange.title !== hint) ui.openIdChange.title = hint;
  ui.closeIdChange.disabled = pending;
  if (!ui.idDialog.open || ui.idForm.hidden) return;
  ui.idUnloaded.disabled = pending;
  ui.idSubmit.disabled = !canWriteId(id);
  [...ui.idOptions.children].forEach((button, target) => {
    const occupied = app.devices.has(target);
    const label = target === app.idChangeFrom ? '当前' : occupied ? '占用' : '';
    const note = button.lastElementChild;
    if (note.textContent !== label) note.textContent = label;
    note.hidden = !label;
    button.disabled = pending || id === null || id !== app.idChangeFrom || occupied;
    button.setAttribute('aria-pressed', String(!occupied && target === app.idChangeTo));
  });
}

function finishIdChange(result, error = false) {
  app.idChangePending = false;
  ui.idForm.hidden = true;
  ui.idResult.textContent = result;
  ui.idResult.toggleAttribute('data-error', error);
  renderStatus();
  if (ui.idDialog.open) ui.closeIdChange.focus();
}

function renderStats() {
  const bus = app.status?.bus;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  set('st-requests', bus?.requests ?? 0);
  set('st-responses', bus?.responses ?? 0);
  set('st-loop', app.status?.loopHz ?? 0);
  set('st-timeouts', bus?.timeouts ?? 0);
  set('st-pending', bus?.pending ?? 0);
  set('st-crc', bus?.crcErrors ?? 0);
  set('st-noise', bus?.noise ?? 0);
  set('st-echo', bus?.echoes ?? 0);
  set('st-mismatch', bus?.mismatched ?? 0);
  set('st-bytes', bus ? `${bus.bytesIn} / ${bus.bytesOut}` : '0 / 0');
  const latencies = [...app.devices.values()].map((device) => device.latency).filter(Number.isFinite);
  set('st-latency', latencies.length ? `${Math.min(...latencies).toFixed(1)}–${Math.max(...latencies).toFixed(1)}` : '—');
}

function resetScanSummary() {
  ui.scanSummary.textContent = '尚未扫描';
  ui.scanSummary.removeAttribute('title');
  ui.dupWarning.hidden = true;
  setStatusMessage(ui.scanWarning, '');
  renderNotice();
}

function createDeviceCard() {
  const card = document.createElement('article');
  card.className = 'participant';
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-axis-${name}"/></svg>`;
  card.innerHTML = `
    <div class="participant-readings">
      <div class="participant-motion">
        <div class="participant-angle">
          <div class="angle-dial" aria-hidden="true">
            <span class="angle-zero">0°</span>
            <span class="angle-quarter">90°</span>
            <span class="angle-half">180°</span>
            <span class="angle-three-quarters">270°</span>
            <span class="angle-needle"></span>
          </div>
          <span class="angle-caption" title="累计位置折算到 0–360°">折算单圈 <b class="stable-number" data-reading="angle">—</b></span>
        </div>
        <dl class="participant-motion-readings">
          <div data-meter="angle" title="数字为累计位置，横条为该位置折算的单圈角度"><dt>${icon('position')}位置</dt><dd><b data-reading="position"></b> <span class="reading-unit">rad</span><span class="motion-meter" aria-hidden="true"></span></dd></div>
          <div data-meter="spd" title="转速刻度相对于当前设定上限"><dt>${icon('speed')}转速</dt><dd><b data-reading="speed"></b> <span class="reading-unit">rpm</span><span class="motion-meter" aria-hidden="true"></span></dd></div>
          <div data-meter="tor" title="输出端扭矩刻度相对于当前设定上限"><dt>${icon('torque')}扭矩</dt><dd><b data-reading="torque"></b> <span class="reading-unit">N·m</span><span class="motion-meter" aria-hidden="true"></span></dd></div>
        </dl>
      </div>
      <div class="participant-feedback">
        <dl class="participant-sensors">
          <div><dt>${icon('voltage')}电压</dt><dd><b data-reading="voltage"></b> <span class="reading-unit">V</span></dd></div>
          <div><dt title="驱动温度（协议字段为壳体温度）">${icon('temp')}驱动温度</dt><dd><b data-reading="temperature"></b> <span class="reading-unit">°C</span></dd></div>
          <div><dt>${icon('winding')}绕组温度</dt><dd><b data-reading="winding"></b> <span class="reading-unit">°C</span></dd></div>
        </dl>
        <dl class="participant-flags">
          <div><dt>电机模式</dt><dd><b data-reading="mode"></b></dd></div>
          <div><dt>超时状态</dt><dd><b data-reading="timeout"></b></dd></div>
          <div><dt>错误码</dt><dd><b data-reading="error"></b></dd></div>
          <div><dt>警告码</dt><dd><b data-reading="warning"></b></dd></div>
        </dl>
      </div>
    </div>
  `;
  return card;
}

function singleTurnDegrees(angle) {
  return ((angle / RAD_PER_DEG) % 360 + 360) % 360;
}

function angleLabel(degrees) {
  return `${(Math.round(degrees * 10) % 3600 / 10).toFixed(1)}°`;
}

function createDeviceRow({ id }) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'device-row';
  row.dataset.id = id;
  row.innerHTML = `
    <strong class="device-row-id"><span>ID </span>${id}</strong>
    <small class="device-row-state"></small>
    <small class="device-row-rate" title="每秒收到的有效设备回报" hidden><span class="stable-number">0</span> Hz</small>
    <span class="device-row-angle" title="单圈角度">
      <span class="angle-dial" aria-hidden="true"><span class="angle-needle"></span></span>
      <b class="device-row-degrees stable-number"></b>
    </span>
    <span class="device-row-speed" title="转速（rpm）">
      <svg class="icon" aria-hidden="true"><use href="#i-axis-speed"/></svg>
      <b class="device-row-rpm"><span class="device-row-rpm-value"></span><span class="device-row-rpm-unit">rpm</span></b>
    </span>`;
  row.addEventListener('click', () => selectDevice(id));
  return row;
}

function deviceStateLabel(device) {
  if (!device) return app.status?.connected ? '未选择设备' : '未连接';
  if (device.duplicate) return '疑似重号';
  if (device.error) return '设备故障';
  if (device.timeout) return '超时保护';
  if (device.warn) return '设备警告';
  if (app.status?.armed) return '已使能';
  if (app.status?.monitoring) return '采样中';
  return device.mode === MODE.LOCK ? 'Stop' : '待机';
}

function renderDeviceState(label, rate, device) {
  const text = deviceStateLabel(device);
  if (label.textContent !== text) label.textContent = text;
  rate.hidden = text !== '已使能' && text !== '采样中';
  if (!rate.hidden) {
    const value = String(device.hz);
    if (rate.firstElementChild.textContent !== value) rate.firstElementChild.textContent = value;
  }
}

function scheduleFeedbackFrame() {
  if (app.feedbackFrame !== null || document.hidden) return;
  app.feedbackFrame = requestAnimationFrame(() => {
    app.feedbackFrame = null;
    renderFeedback(false);
  });
}

function renderFeedback(force = true) {
  const device = app.devices.get(app.selectedId);
  const sample = app.series.get(app.selectedId)?.at(-1);
  renderDeviceCard(device && sample && sample.t > device.at ? { ...device, ...sample } : device);
  drawPlot(force);
}

function renderDeviceCard(device) {
  const container = ui.currentDeviceCard;
  if (!container.firstElementChild) container.append(createDeviceCard());
  const card = container.firstElementChild;
  if (device) card.dataset.id = device.id;
  else delete card.dataset.id;
  const title = ui.participantTitle;
  const heading = device ? `设备 ID ${device.id}` : '当前设备';
  if (title.textContent !== heading) title.textContent = heading;
  card.toggleAttribute('data-error', Boolean(device?.error));
  card.toggleAttribute('data-warning', Boolean(device?.warn));
  card.toggleAttribute('data-timeout', Boolean(device?.timeout));
  const angle = device ? singleTurnDegrees(device.pos) : null;
  const needle = card.querySelector('.angle-needle');
  needle.hidden = !device;
  needle.style.transform = device ? `rotate(${angle}deg)` : '';
  const values = device ? {
    angle: angleLabel(angle),
    position: device.pos.toFixed(3),
    speed: (device.spd * RAD_TO_RPM).toFixed(1),
    torque: device.tor.toFixed(3),
    voltage: device.vol.toFixed(1),
    temperature: String(device.temp),
    winding: String(device.sensor),
    mode: ['0 Stop', '1 FOC', '2 校准'][device.mode] ?? String(device.mode),
    timeout: device.timeout ? '1 是' : '0 否',
    error: `${device.error} · ${device.errorText}`,
    warning: `${device.warn} · ${device.warn ? device.warnText : '正常'}`,
  } : null;
  for (const cell of card.querySelectorAll('[data-reading]')) {
    const value = values?.[cell.dataset.reading] ?? '—';
    if (cell.textContent !== value) cell.textContent = value;
  }
  const limits = app.status?.limits ?? DEFAULT_LIMITS;
  for (const meter of card.querySelectorAll('[data-meter]')) {
    const key = meter.dataset.meter;
    if (key === 'angle') {
      meter.style.setProperty('--meter-start', '0%');
      meter.style.setProperty('--meter-size', `${(angle ?? 0) / 3.6}%`);
      continue;
    }
    const fraction = device && limits[key] > 0 ? Math.max(-1, Math.min(1, device[key] / limits[key])) : 0;
    meter.style.setProperty('--meter-start', `${50 + Math.min(0, fraction) * 50}%`);
    meter.style.setProperty('--meter-size', `${Math.abs(fraction) * 50}%`);
  }
  const reading = ui.participantState;
  const [label, rate] = reading.firstElementChild.children;
  renderDeviceState(label, rate, device);
  reading.title = device?.error ? device.errorText : device?.warn ? device.warnText : '';
  reading.classList.toggle('hint-warn', Boolean(device?.error || device?.duplicate || device?.timeout || device?.warn));
}

function renderDevices() {
  const devices = [...app.devices.values()].sort((a, b) => a.id - b.id);
  const count = String(devices.length);
  if (ui.deviceCount.textContent !== count) ui.deviceCount.textContent = count;
  const ids = devices.map(({ id }) => id).join(',');
  if (ui.deviceRows.dataset.ids !== ids) {
    ui.deviceRows.dataset.ids = ids;
    ui.deviceRows.replaceChildren(...(devices.length ? devices.map(createDeviceRow) : [ui.deviceEmpty]));
  }
  for (const [index, device] of devices.entries()) {
    const row = ui.deviceRows.children[index];
    row.setAttribute('aria-pressed', String(device.id === app.selectedId));
    row.toggleAttribute('data-alert', Boolean(device.error || device.duplicate || device.timeout || device.warn));
    const state = row.querySelector('.device-row-state');
    const rate = row.querySelector('.device-row-rate');
    renderDeviceState(state, rate, device);
    const stateTitle = rate.hidden ? state.textContent : `${state.textContent} ${rate.textContent}`;
    if (state.title !== stateTitle) state.title = stateTitle;
    const angle = singleTurnDegrees(Number.isFinite(device.exPos) ? device.exPos : device.pos);
    row.querySelector('.angle-needle').style.transform = `rotate(${angle}deg)`;
    row.querySelector('.device-row-degrees').textContent = angleLabel(angle);
    const rpm = device.spd * RAD_TO_RPM;
    const magnitude = Math.abs(rpm).toFixed(1).padStart(4, '0');
    const sign = rpm < 0 && magnitude !== '00.0' ? '-' : '';
    row.querySelector('.device-row-rpm-value').textContent = sign + magnitude;
  }
  scheduleFeedbackFrame();
  renderControlPanel();
}

function selectDevice(id) {
  if (app.selectedId !== id && !app.broadcast) {
    cancelLiveTarget();
    app.initializedFor = null;
  }
  app.selectedId = id;
  renderDevices();
  renderStatus();
}

function targetIds() {
  return app.broadcast ? [...app.devices.keys()].sort((a, b) => a - b)
    : app.selectedId === null ? [] : [app.selectedId];
}

function resolveTarget(device, setpoint, broadcast, relative) {
  if (relative) {
    return { ...setpoint, pos: device.pos + setpoint.pos };
  }
  if (broadcast && setpoint.mode === MODES.VELOCITY) return { ...setpoint, pos: device.pos };
  return setpoint;
}

function renderControlPanel(preserveMode = false) {
  const device = app.devices.get(app.selectedId);
  if (!device) {
    updateModeHint();
    return;
  }

  const broadcast = app.broadcast;
  const draftId = broadcast ? BROADCAST_DRAFT : device.id;
  if (app.initializedFor !== draftId) {
    app.initializedFor = draftId;
    const profile = app.profiles.get(draftId);
    if (broadcast) app.broadcastRelative = profile?.relative ?? false;
    if (!preserveMode && !broadcast) showMode(profile?.mode ?? app.mode);
    for (const [field, value] of Object.entries(profile?.fields ?? {})) ui[field].value = value;
    if (!profile) {
      for (const field of setpointFields) ui[field].value = ui[field].defaultValue;
      ui.singlePos.value = !broadcast && isInSingleTurnTravel(device.pos)
        ? (device.pos / RAD_PER_DEG).toFixed(2) : '';
      ui.setPos.value = broadcast ? '' : device.pos.toFixed(3);
      ui.manPos.value = broadcast ? '0' : device.pos.toFixed(3);
      if (broadcast) ui.manKp.value = '0';
    }
  }
  updateModeHint();
}

function updateModeHint() {
  for (const [field, digits] of [['posTmax', 2], ['posKp', 1], ['posKd', 2], ['velTmax', 2], ['velKd', 2]]) {
    ui[`${field}Label`].textContent = Number(ui[field].value).toFixed(digits);
  }
  let warning = '';
  if (isPositionMode(app.mode)) {
    const singleTurn = app.mode === MODES.SINGLE_TURN;
    const broadcast = app.broadcast;
    const device = app.devices.get(app.selectedId);
    const inTravel = isInSingleTurnTravel(device?.pos);
    ui.multiReferenceField.hidden = singleTurn || !broadcast;
    ui.multiReference.value = app.broadcastRelative ? 'relative' : 'absolute';
    ui.positionGoalLabel.textContent = broadcast && app.broadcastRelative ? '目标位移' : '累计位置';
    if (singleTurn) {
      const position = device ? `${(device.pos / RAD_PER_DEG).toFixed(1)}°` : '—';
      const label = device && !inTravel ? '行程外 ·' : '当前轴';
      const [travelLabel, travelValue] = ui.singleTravelPosition.children;
      if (travelLabel.textContent !== label) travelLabel.textContent = label;
      if (travelValue.textContent !== position) travelValue.textContent = position;
      syncAngleSlider();
    }
    const tmax = Math.min(Number(ui.posTmax.value), app.status?.limits?.tor ?? DEFAULT_LIMITS.tor);
    const kp = Math.min(Number(ui.posKp.value), app.status?.limits?.kp ?? DEFAULT_LIMITS.kp);
    const kd = Math.min(Number(ui.posKd.value), app.status?.limits?.kd ?? DEFAULT_LIMITS.kd);
    if (kd <= 1e-6) {
      ui.modeHint.textContent = '当前有效阻尼 Kd 为 0，位置模式输出零力矩。调高阻尼后可恢复回位。';
      setStatusMessage(ui.modeWarn, '');
      renderNotice();
      return;
    }
    const linear = kp > 0 ? tmax / kp : 0;
    const grams = (tmax / 0.0000980665).toFixed(0);
    const text =
      `估算力矩软上限 ${tmax.toFixed(2)} N·m（约 ${grams} gf·cm）；` +
      `静止刚度 ${kp}，偏差 ${linear.toFixed(3)} rad 时到上限。`;
    const target = (singleTurn ? ui.singlePos : ui.setPos).valueAsNumber;
    if (device && !broadcast && Number.isFinite(target)) {
      const distance = (singleTurn ? target * RAD_PER_DEG : target) - device.pos;
      if (Math.abs(distance) > 0.5) {
        const vmax = app.status?.limits?.spd ?? 4;
        const v = Math.min(3, vmax);
        warning =
          `目标距实测位置 ${distance.toFixed(2)} rad（${(Math.abs(distance) / (2 * Math.PI)).toFixed(1)} 圈），` +
          (v > 0 ? `按 ${v} rad/s 限速约需 ${Math.ceil(Math.abs(distance) / v)} s。` : '当前转速上限为 0 rad/s。');
      }
    }
    const behavior = singleTurn ? '以上电位置为 0°，沿固定的 0–360° 行程定位。'
      : broadcast && app.broadcastRelative ? '改动位移后从各轴当前位置重新计算。微调和再次提交沿用各轴的目标。'
      : '累计位置从电机上电起计，跨整圈时按目标位置运行。';
    ui.modeHint.textContent = `${behavior}${text}`;
  } else if (app.mode === MODES.VELOCITY) {
    const spd = Number(ui.velSpd.value);
    const rpm = (spd * 60) / (2 * Math.PI);
    ui.velSpdLabel.textContent = spd.toFixed(2);
    ui.velRpmLabel.textContent = rpm.toFixed(1);
    ui.modeHint.textContent =
      `纯阻尼速度环（Kp=0）：目标 ${spd.toFixed(2)} rad/s ≈ ${rpm.toFixed(1)} rpm；` +
      `力矩软上限 ${Math.min(Number(ui.velTmax.value), app.status?.limits?.tor ?? DEFAULT_LIMITS.tor).toFixed(2)} N·m，速度误差较大时会降低阻尼增益。` +
        `滑块上限跟随「设定值上限」中的转速上限。`;
  } else {
    ui.modeHint.textContent =
      '五参数直通。Kp 和 Kd 设为 0 时仅输出前馈力矩。设定值上限约束前馈和指令值，舵机闭环产生的力矩不受软上限约束。';
  }
  setStatusMessage(ui.modeWarn, warning);
  renderNotice();
}

function showMode(mode) {
  app.mode = mode;
  for (const button of ui.modeButtons) {
    const selected = button.dataset.runMode === mode;
    button.setAttribute('aria-pressed', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const block of ui.modeFields) {
    const visible = block.dataset.mode === MODES.POSITION ? isPositionMode(mode) : block.dataset.mode === mode;
    block.hidden = !visible;
  }
  for (const block of ui.positionKinds) block.hidden = block.dataset.positionKind !== mode;
}

function setMode(mode) {
  if (app.mode === mode) return;
  cancelLiveTarget();
  showMode(mode);
  const device = app.devices.get(app.selectedId);
  // 每轴保留各模式的输入，切换后仍须明确下发。
  if (device) applySetpoint({}, false);
  else updateModeHint();
  renderStatus();
}

/* ---------------- 曲线 ---------------- */

const PLOT_AXES = {
  pos: { unit: 'rad', digits: 2, minSpan: 4 * Math.PI, labelSample: '-0000.00' },
  spd: { unit: 'rad/s', digits: 2, minSpan: 8, center: 0, labelSample: '-000.00' },
  exPos: { unit: '°', digits: 0, range: [0, 360], labelSample: '000' },
  tor: { unit: 'N·m', digits: 3, minSpan: 1, center: 0, labelSample: '-00.000' },
  vol: { unit: 'V', digits: 1, minSpan: 2, labelSample: '-000.0' },
  temp: { unit: '°C', digits: 1, minSpan: 8, labelSample: '-000.0' },
};

const PLOT_CHANNELS = [
  { key: 'pos', axis: 'pos', label: '累计位置', color: '#86afff', level: 2 },
  { key: 'targetPos', axis: 'pos', label: '位置目标', color: '#d8a0ef', target: true, level: 2 },
  { key: 'spd', axis: 'spd', label: '输出速度', color: '#5cdbb2', level: 1 },
  { key: 'targetSpd', axis: 'spd', label: '速度目标', color: '#c9b6ff', target: true, level: 2 },
  { key: 'exPos', axis: 'exPos', label: '原始单圈角度', color: '#63cef1' },
  { key: 'tor', axis: 'tor', label: '输出扭矩', color: '#e8b66a' },
  { key: 'vol', axis: 'vol', label: '母线电压', color: '#ece294' },
  { key: 'temp', axis: 'temp', label: '驱动温度', color: '#ff9b83' },
  { key: 'sensor', axis: 'temp', label: '绕组温度', color: '#f998c6' },
];
const PLOT_VISIBILITY = ['关闭', '50% 显示', '100% 显示'];
const PLOT_GAP_MS = 500;
const PLOT_RETENTION_MS = 120000 + PLOT_GAP_MS;
let plotFont = currentPlotFont();
const plotLatestLabel = '最新回报';
const plotRanges = new Map();
let plotWindowSeconds = 30;
let plotDeviceId;
let plotTimeOrigin;
let plotPointer = null;
let lastPlotPaint;
let plotAxisLabelWidths;
let plotInterruptionTimer;

function currentPlotFont() {
  const { fontWeight, fontSize, fontFamily } = getComputedStyle(ui.plot);
  return `${fontWeight} ${fontSize} ${fontFamily}`;
}

function measurePlotAxisLabels(ctx) {
  const widestDigit = [...'0123456789'].reduce((widest, digit) =>
    ctx.measureText(digit).width > ctx.measureText(widest).width ? digit : widest);
  return Object.fromEntries(Object.entries(PLOT_AXES).map(([key, { unit, labelSample }]) => [
    key,
    Math.ceil(Math.max(ctx.measureText(unit).width, ctx.measureText(labelSample.replaceAll('0', widestDigit)).width)) + 12,
  ]));
}

function bindStatusPlot() {
  const windowButtons = [...ui.plotWindow.querySelectorAll('button')];
  for (const button of windowButtons) {
    button.addEventListener('click', () => {
      plotWindowSeconds = Number(button.dataset.seconds);
      for (const option of windowButtons) option.setAttribute('aria-pressed', String(option === button));
      ui.plot.setAttribute('aria-label', `最近 ${plotWindowSeconds} 秒状态曲线`);
      renderFeedback();
    });
  }
  for (const channel of PLOT_CHANNELS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.chartSeries = channel.key;
    button.style.setProperty('--series-color', channel.color);
    button.textContent = channel.label;
    channel.level ??= 0;
    const update = () => {
      const level = channel.level;
      const next = (level + 1) % PLOT_VISIBILITY.length;
      button.dataset.level = String(level);
      button.setAttribute('aria-pressed', ['false', 'mixed', 'true'][level]);
      button.setAttribute('aria-label', `${channel.label} · ${PLOT_VISIBILITY[level]}`);
      button.title = `点击切换为${PLOT_VISIBILITY[next]}${channel.target ? ' · 本控制台下发的目标' : ''}`;
    };
    button.addEventListener('click', () => {
      channel.level = (channel.level + 1) % PLOT_VISIBILITY.length;
      update();
      renderFeedback();
    });
    update();
    ui.plotSeries.append(button);
  }
  ui.plot.addEventListener('pointermove', (event) => {
    plotPointer = event.clientX;
    renderFeedback();
  });
  ui.plot.addEventListener('pointerleave', () => {
    plotPointer = null;
    renderFeedback();
  });
}

function plotValue(point, key) {
  return key === 'exPos' ? point.exPos / RAD_PER_DEG : point[key];
}

function drawTargetTrace(ctx, points, key, xAt, yAt, { dashX, top, bottom }) {
  const dash = 5;
  const period = 9;
  const addDashedRun = (from, to, fixed, vertical = false) => {
    // Horizontal dashes travel with their timestamps. Vertical dashes stay anchored in value space.
    const origin = vertical ? top : dashX;
    for (let mark = origin + Math.floor((from - origin) / period) * period; mark < to; mark += period) {
      const start = Math.max(from, mark);
      const end = Math.min(to, mark + dash);
      if (end <= start) continue;
      ctx.moveTo(vertical ? fixed : start, vertical ? start : fixed);
      ctx.lineTo(vertical ? fixed : end, vertical ? end : fixed);
    }
  };
  let runStart = 0;
  let previousTime = -Infinity;
  let previousValue;
  ctx.beginPath();
  for (const point of points) {
    const value = point[key];
    if (!Number.isFinite(value) || point.afterPause || point.t - previousTime >= PLOT_GAP_MS) {
      if (Number.isFinite(previousTime)) addDashedRun(runStart, xAt(previousTime), yAt(previousValue));
      previousTime = -Infinity;
    }
    if (!Number.isFinite(value)) continue;
    const x = xAt(point.t);
    if (!Number.isFinite(previousTime)) {
      runStart = x;
    } else if (value !== previousValue) {
      const previousY = yAt(previousValue);
      addDashedRun(runStart, x, previousY);
      const y = yAt(value);
      addDashedRun(Math.max(top, Math.min(previousY, y)), Math.min(bottom, Math.max(previousY, y)), x, true);
      runStart = x;
    }
    previousTime = point.t;
    previousValue = value;
  }
  if (Number.isFinite(previousTime)) addDashedRun(runStart, xAt(previousTime), yAt(previousValue));
  ctx.stroke();
}

function drawPlot(force) {
  if (!force && document.hidden) return;
  const canvas = ui.plot;
  const { clientWidth: width, clientHeight: height } = canvas;
  if (!width || !height) return;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
  const id = app.selectedId;
  const history = app.series.get(id) ?? [];
  const latest = history.at(-1);
  const now = Date.now();
  const interrupted = Boolean(latest && now - latest.t >= PLOT_GAP_MS);
  const end = interrupted ? now : latest?.t ?? now;
  if (!force && !resized && lastPlotPaint && lastPlotPaint.id === id
    && lastPlotPaint.width === width && lastPlotPaint.height === height && lastPlotPaint.dpr === dpr
    && lastPlotPaint.latest === latest && lastPlotPaint.interrupted === interrupted && !interrupted) return;
  clearTimeout(plotInterruptionTimer);
  if (latest && now - latest.t < plotWindowSeconds * 1000) {
    plotInterruptionTimer = setTimeout(() => renderFeedback(false),
      interrupted ? 250 : latest.t + PLOT_GAP_MS - now + 1);
  }
  lastPlotPaint = { id, width, height, dpr, latest, interrupted };

  const ctx = canvas.getContext('2d');
  if (resized) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (plotDeviceId !== id || !latest) {
    plotRanges.clear();
    plotTimeOrigin = undefined;
  }
  plotDeviceId = id;
  const windowMs = plotWindowSeconds * 1000;
  // Keep one point before the window so a line crossing the left edge can be clipped in place.
  const index = history.findIndex(({ t }) => t >= end - windowMs);
  const first = index < 0 ? history.length : index;
  const points = history.slice(first);
  const tracePoints = first > 0 ? history.slice(first - 1) : points;
  const gaps = [];
  for (let i = 1; i < tracePoints.length; i++) {
    const previous = tracePoints[i - 1], point = tracePoints[i];
    if (point.afterPause || point.t - previous.t >= PLOT_GAP_MS) gaps.push([previous.t, point.t]);
  }
  if (interrupted) gaps.push([latest.t, end]);
  if (latest) plotTimeOrigin ??= end;

  const channels = PLOT_CHANNELS.filter(({ level }) => level > 0);
  const hasData = channels.some(({ key }) => points.some((point) => Number.isFinite(plotValue(point, key))));
  ui.plotEmpty.hidden = hasData;
  const emptyText = channels.length ? '等待所选曲线数据' : '曲线已全部关闭';
  if (ui.plotEmpty.textContent !== emptyText) ui.plotEmpty.textContent = emptyText;
  ui.plotTooltip.hidden = true;

  const axes = new Map();
  for (const channel of channels) {
    let axis = axes.get(channel.axis);
    if (!axis) {
      axis = { ...PLOT_AXES[channel.axis], color: channel.color, low: Infinity, high: -Infinity };
      axes.set(channel.axis, axis);
    }
    for (const point of points) {
      const value = plotValue(point, channel.key);
      if (!Number.isFinite(value)) continue;
      axis.low = Math.min(axis.low, value);
      axis.high = Math.max(axis.high, value);
    }
  }

  ctx.font = plotFont;
  plotAxisLabelWidths ??= measurePlotAxisLabels(ctx);
  let left = 8;
  let right = 8;
  let labeledAxes = 0;
  let outsideRange = false;
  for (const [key, axis] of axes) {
    const bounds = fitPlotRange(axis, plotRanges.get(key));
    plotRanges.set(key, bounds);
    const [low, high] = bounds;
    outsideRange ||= axis.low < low || axis.high > high;
    axis.low = low;
    axis.high = high;
    const labelWidth = plotAxisLabelWidths[key];
    if (width - left - right - labelWidth < 138) continue;
    if (labeledAxes++ % 2 === 0) {
      axis.labelX = left;
      left += labelWidth;
    } else {
      axis.labelX = width - right;
      axis.onRight = true;
      right += labelWidth;
    }
  }
  const plotCaption = [interrupted && '数据已中断', gaps.length && '阴影为无采样时段', outsideRange && '数据超出纵轴'].filter(Boolean).join(' · ');
  if (ui.plotStatus.textContent !== plotCaption) ui.plotStatus.textContent = plotCaption;
  ui.plotStatus.hidden = !plotCaption;
  ui.plotStatus.toggleAttribute('data-outside-range', outsideRange);

  const top = 23;
  const bottom = height - 22;
  const plotWidth = width - right - left;
  const plotHeight = bottom - top;
  if (plotWidth <= 0 || plotHeight <= 0) return;
  const gridRows = plotHeight < 44 ? 1 : plotHeight < 88 ? 2 : 4;
  const gridRowHeight = plotHeight / gridRows;
  if (!hasData) {
    const emptyRow = Math.floor((gridRows - 1) / 2);
    const emptyY = top + gridRowHeight * (emptyRow + 0.5);
    ui.plotEmpty.style.setProperty('--plot-empty-y', `${emptyY}px`);
  }
  const xAt = (time) => left + plotWidth * (1 - (end - time) / windowMs);
  const yAt = (value, axis) => bottom - plotHeight * (value - axis.low) / (axis.high - axis.low);

  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#304159';
  for (let i = 0; i <= gridRows; i++) {
    const y = top + gridRowHeight * i;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();
  }
  for (const axis of axes.values()) {
    if (axis.labelX === undefined) continue;
    ctx.fillStyle = axis.color;
    ctx.textAlign = axis.onRight ? 'right' : 'left';
    ctx.fillText(axis.unit, axis.labelX, 8);
    for (let i = 0; i <= gridRows; i++) {
      const value = axis.high - (axis.high - axis.low) * i / gridRows;
      ctx.fillText(value.toFixed(axis.digits), axis.labelX, top + gridRowHeight * i);
    }
  }

  ctx.fillStyle = '#a4b9d5';
  const timeSteps = plotWidth < 230 ? 3 : 6;
  for (let i = 0; i <= timeSteps; i++) {
    const x = left + plotWidth * i / timeSteps;
    ctx.textAlign = i === 0 ? 'left' : i === timeSteps ? 'right' : 'center';
    ctx.fillText(i === timeSteps ? (interrupted ? '现在' : plotLatestLabel) : '−' + (plotWindowSeconds * (timeSteps - i) / timeSteps) + 's', x, height - 7);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, plotWidth + 3, plotHeight);
  ctx.clip();
  ctx.fillStyle = '#90a9ca26';
  for (const [start, stop] of gaps) {
    const x = Math.max(left, xAt(start));
    ctx.fillRect(x, top, xAt(stop) - x, plotHeight);
  }
  const layerOrder = [...channels].sort((a, b) => a.level - b.level);
  for (const { key, axis: axisKey, color, target, level } of layerOrder) {
    const axis = axes.get(axisKey);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = level / 2;
    if (target) {
      const dashX = xAt(plotTimeOrigin ?? end);
      drawTargetTrace(ctx, tracePoints, key, xAt, (value) => yAt(value, axis), { dashX, top, bottom });
      continue;
    }
    ctx.beginPath();
    let previousTime = -Infinity;
    let previousValue;
    for (const point of tracePoints) {
      const value = plotValue(point, key);
      if (!Number.isFinite(value)) {
        previousTime = -Infinity;
        continue;
      }
      const x = xAt(point.t);
      const y = yAt(value, axis);
      if (point.afterPause || point.t - previousTime >= PLOT_GAP_MS || (key === 'exPos' && Math.abs(value - previousValue) > 180)) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      previousTime = point.t;
      previousValue = value;
    }
    ctx.stroke();
    if (latest && Number.isFinite(plotValue(latest, key))) {
      ctx.beginPath();
      ctx.arc(xAt(latest.t), yAt(plotValue(latest, key), axis), 2.5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  const rect = canvas.getBoundingClientRect();
  const pointerX = plotPointer === null ? -1 : (plotPointer - rect.left) * width / rect.width;
  if (pointerX >= left && pointerX <= width - right + 1) {
    const cursorTime = end - windowMs * (1 - (pointerX - left) / plotWidth);
    const gap = gaps.find(([start, stop]) => cursorTime > start && cursorTime < stop);
    if (gap) {
      ui.plotTooltip.textContent = '无采样 · ' + ((gap[1] - gap[0]) / 1000).toFixed(2) + ' s';
      ui.plotTooltip.hidden = false;
      ui.plotTooltip.style.left = Math.max(8, Math.min(pointerX + 12, width - ui.plotTooltip.offsetWidth - 8)) + 'px';
      if (interrupted && latest.t === gap[0] && now - latest.t >= windowMs) {
        // The whole window is shaded. Only the hovered duration still changes.
        const updateDuration = () => {
          if (document.hidden || plotPointer === null || ui.plotTooltip.hidden) return;
          ui.plotTooltip.textContent = '无采样 · ' + ((Date.now() - gap[0]) / 1000).toFixed(2) + ' s';
          plotInterruptionTimer = setTimeout(updateDuration, 250);
        };
        plotInterruptionTimer = setTimeout(updateDuration, 250);
      }
      ctx.restore();
      return;
    }
    let closest;
    for (const point of points) {
      if (!closest || Math.abs(point.t - cursorTime) < Math.abs(closest.t - cursorTime)) closest = point;
    }
    if (closest && Math.abs(closest.t - cursorTime) < PLOT_GAP_MS / 2) {
      const values = [];
      for (const channel of layerOrder) {
        const value = plotValue(closest, channel.key);
        if (!Number.isFinite(value)) continue;
        const axis = axes.get(channel.axis);
        const digits = channel.key === 'exPos' ? 1 : axis.digits;
        values.push(channel.label + ' ' + value.toFixed(digits) + ' ' + axis.unit);
        ctx.fillStyle = channel.color;
        ctx.globalAlpha = channel.level / 2;
        ctx.beginPath();
        ctx.arc(xAt(closest.t), yAt(value, axis), 3.5, 0, 2 * Math.PI);
        ctx.fill();
      }
      if (values.length) {
        const x = xAt(closest.t);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#8198bb';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
        const tooltipText = (interrupted ? '距现在 ' : '距最新回报 ') + ((end - closest.t) / 1000).toFixed(1) + ' s · ' + values.join(' · ');
        if (ui.plotTooltip.textContent !== tooltipText) ui.plotTooltip.textContent = tooltipText;
        ui.plotTooltip.hidden = false;
        const tooltipX = x + 12 + ui.plotTooltip.offsetWidth <= width - 8 ? x + 12 : x - ui.plotTooltip.offsetWidth - 12;
        ui.plotTooltip.style.left = Math.max(8, tooltipX) + 'px';
      }
    }
  }
  ctx.restore();
}

const RAD_TO_RPM = 60 / (2 * Math.PI);

/* ---------------- 交互 ---------------- */

/* ---------------- 快捷动作 ---------------- */

const RAD_PER_DEG = Math.PI / 180;

function isInSingleTurnTravel(pos) {
  return pos >= 0 && pos <= SINGLE_TURN_MAX;
}

function goToAngle(degrees) {
  ui.singlePos.value = String(degrees);
  applySetpoint();
}

function syncAngleSlider() {
  if (document.activeElement !== ui.posAngle) {
    ui.posAngle.value = String(Math.round(ui.singlePos.valueAsNumber || 0));
  }
}

// 相对转动：顺 = 正方向，逆 = 负方向。
function relativeMove(degrees) {
  const device = app.devices.get(app.selectedId);
  if (!device) return;
  const broadcast = app.broadcast;
  if (broadcast) app.broadcastRelative = true;
  const pos = (broadcast ? 0 : device.pos) + degrees * RAD_PER_DEG;
  ui.setPos.value = pos.toFixed(3);
  applySetpoint({ pos });
  appendLog('info', `目标草稿：${degrees > 0 ? '顺' : '逆'}转 ${Math.abs(degrees)}°，${pos.toFixed(3)} rad`);
}

function nudgePosition(delta) {
  if (app.mode !== MODES.POSITION) return;
  const device = app.devices.get(app.selectedId);
  if (!device) return;
  const relative = app.broadcast && app.broadcastRelative;
  let base = ui.setPos.valueAsNumber;
  if (!Number.isFinite(base)) {
    if (ui.setPos.validity.badInput || (app.broadcast && !relative)) return;
    base = relative ? 0 : device.pos;
  }
  const previous = relative ? app.resolvedBroadcastPosition : null;
  ui.setPos.value = (base + delta).toFixed(3);
  if (applySetpoint() && previous) {
    // Use the last resolved target for each axis, even if it is still moving.
    app.resolvedBroadcastPosition = new Map([...previous].map(([id, pos]) => [id, pos + delta]));
  }
}

const positionParameters = ['posTmax', 'posKp', 'posKd'];
const fieldsByMode = {
  [MODES.SINGLE_TURN]: ['singlePos', ...positionParameters],
  [MODES.POSITION]: ['setPos', ...positionParameters],
  [MODES.VELOCITY]: ['velSpd', 'velKd', 'velTmax'],
  [MODES.MANUAL]: ['manPos', 'manSpd', 'manTor', 'manKp', 'manKd'],
};
const setpointFields = [...new Set(Object.values(fieldsByMode).flat())];

function canApplyTarget(ids) {
  const status = app.status;
  return !document.hidden && status?.connected && status.armed && !status.stopping
    && !status.closing && !status.fault && !app.disconnecting && !app.stopPending && !app.disabling && ids.length > 0
    && ids.every((id) => status.activeIds?.includes(id) ?? app.devices.has(id));
}

function cancelLiveTarget() {
  clearTimeout(app.liveTargetTimer);
  app.liveTargetTimer = null;
}

function setTargetUpdateMode(automatic) {
  cancelLiveTarget();
  app.autoTarget = automatic;
  ui.updateManual.setAttribute('aria-pressed', String(!automatic));
  ui.updateAuto.setAttribute('aria-pressed', String(automatic));
}

function startFoc(ids) {
  app.arming = true;
  app.resolvedBroadcastPosition = null;
  startHeartbeat();
  post({ type: 'arm', ids });
  renderStatus();
}

function requestStop(hold, reason) {
  app.armAfterConnect = false;
  cancelLiveTarget();
  app.stopPending = true;
  app.resolvedBroadcastPosition = null;
  post({ type: 'stop', hold, reason });
  stopHeartbeat();
  renderStatus();
}

function submitTarget(ids, automatic = false) {
  if (!canApplyTarget(ids)) return;
  const broadcast = app.broadcast;
  const profile = app.profiles.get(broadcast ? BROADCAST_DRAFT : ids[0]);
  const draft = profile?.setpoint;
  if (!draft) return;
  const relative = broadcast && profile.relative && draft.mode === MODES.POSITION;
  const previousPositions = relative ? app.resolvedBroadcastPosition : null;
  const targets = ids.map((id) => {
    const setpoint = previousPositions?.has(id) ? { ...draft, pos: previousPositions.get(id) }
      : resolveTarget(app.devices.get(id), draft, broadcast, relative);
    return { id, setpoint };
  });
  if (relative) app.resolvedBroadcastPosition = new Map(targets.map(({ id, setpoint }) => [id, setpoint.pos]));
  if (broadcast) {
    post({ type: 'apply-broadcast', targets, automatic });
    return;
  }
  const [{ id, setpoint }] = targets;
  post({ type: 'apply', id, setpoint });
  if (!automatic) appendLog('info', `已下发 ID ${id} 的目标`);
}

function applySetpoint(patch = {}, live = true) {
  const id = app.selectedId;
  if (id === null || id === undefined) return;
  const device = app.devices.get(id);
  const current = device?.pos ?? 0;
  const activeFields = fieldsByMode[app.mode];
  const broadcast = app.broadcast;
  const draftId = broadcast ? BROADCAST_DRAFT : id;
  const previous = app.profiles.get(draftId);
  const relative = broadcast && app.broadcastRelative;
  const fields = Object.fromEntries(setpointFields.map((field) => [field, ui[field].value]));
  const positionField = activeFields[0];
  if (broadcast && (Object.hasOwn(patch, 'pos') || previous?.mode !== app.mode
    || previous?.relative !== relative || previous?.fields[positionField] !== fields[positionField])) {
    app.resolvedBroadcastPosition = null;
  }
  if (activeFields.some((field) => ui[field].value === '' || ui[field].validity.badInput)
    || (app.mode === MODES.SINGLE_TURN && !ui.singlePos.validity.valid)) {
    app.profiles.set(draftId, { mode: app.mode, relative, fields });
    cancelLiveTarget();
    updateModeHint();
    return false;
  }

  let setpoint;
  if (isPositionMode(app.mode)) {
    setpoint = {
      mode: app.mode,
      pos: app.mode === MODES.SINGLE_TURN ? ui.singlePos.valueAsNumber * RAD_PER_DEG : ui.setPos.valueAsNumber,
      spd: 0,
      tor: 0,
      kp: Number(ui.posKp.value),
      kd: Number(ui.posKd.value),
      tmax: Number(ui.posTmax.value),
    };
  } else if (app.mode === MODES.VELOCITY) {
    setpoint = {
      mode: MODES.VELOCITY,
      pos: current,
      spd: Number(ui.velSpd.value),
      tor: 0,
      kp: 0,
      kd: Number(ui.velKd.value),
      tmax: Number(ui.velTmax.value),
    };
  } else {
    setpoint = {
      mode: MODES.MANUAL,
      pos: Number(ui.manPos.value),
      spd: Number(ui.manSpd.value),
      tor: Number(ui.manTor.value),
      kp: Number(ui.manKp.value),
      kd: Number(ui.manKd.value),
      tmax: app.status?.limits?.tor ?? DEFAULT_LIMITS.tor,
    };
  }
  setpoint = { ...setpoint, ...patch };
  app.profiles.set(draftId, { mode: app.mode, relative, fields, setpoint });
  if (live && app.autoTarget && canApplyTarget(targetIds()) && app.liveTargetTimer === null) {
    app.liveTargetTimer = setTimeout(() => {
      app.liveTargetTimer = null;
      if (app.autoTarget) submitTarget(targetIds(), true);
    }, 60);
  }
  updateModeHint();
  return true;
}

async function checkSelectedPort() {
  const ports = await navigator.serial.getPorts();
  if (!ports.includes(app.selectedPort)) {
    app.selectedPort = null;
    app.conflictingPorts = [];
    ui.portName.textContent = '未选择';
    throw Error('所选串口已断开或授权已撤销，请重新选择');
  }
  const info = app.selectedPort.getInfo();
  app.conflictingPorts = ports.filter((port) => port !== app.selectedPort && samePortInfo(port.getInfo(), info));
  return info;
}

function bindControls() {
  bindStatusPlot();
  for (let target = 0; target <= MAX_ID; target++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.append(String(target), document.createElement('small'));
    button.addEventListener('click', () => {
      app.idChangeTo = target;
      renderIdChange();
    });
    ui.idOptions.append(button);
  }
  ui.openIdChange.addEventListener('click', () => {
    const id = addressCandidate();
    if (id === null) return;
    ui.idForm.reset();
    app.idChangeFrom = id;
    app.idChangeTo = null;
    ui.idForm.hidden = false;
    ui.idResult.textContent = '';
    ui.idResult.removeAttribute('data-error');
    ui.idDialog.showModal();
    renderIdChange();
    ui.idOptions.querySelector('button:not(:disabled)')?.focus();
  });
  ui.closeIdChange.addEventListener('click', () => ui.idDialog.close());
  ui.idDialog.addEventListener('cancel', (event) => {
    if (app.idChangePending) event.preventDefault();
  });
  ui.idForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!canWriteId(addressCandidate())) return;
    const from = app.idChangeFrom;
    const to = app.idChangeTo;
    app.idChangePending = true;
    ui.idResult.textContent = `正在执行 ID ${from} → ${to}，请保持连接。`;
    renderStatus();
    post({ type: 'change-id', from, to, unloaded: ui.idUnloaded.checked });
  });
  ui.idUnloaded.addEventListener('change', renderIdChange);
  for (const [button, broadcast] of [[ui.singleControl, false], [ui.broadcast, true]]) {
    button.addEventListener('click', () => {
      if (app.broadcast === broadcast) return;
      app.broadcast = broadcast;
      cancelLiveTarget();
      app.initializedFor = null;
      renderControlPanel(true);
      renderStatus();
    });
  }
  function openSession(backend, portInfo) {
    app.autoScan = true;
    renderStatus();
    post({ type: 'open', backend, portInfo });
  }

  async function pickSerialPort() {
    if (!('serial' in navigator)) {
      const hint = window.isSecureContext
        ? '请使用桌面版 Chrome 或 Edge 打开独立页面，并检查站点的串口权限。'
        : '请使用 HTTPS 公网地址，或用启动器打开本机调试台。';
      appendLog('error', `当前页面无法使用 Web Serial。${hint}`);
      return;
    }
    app.checkingPorts = true;
    renderStatus();
    try {
      const port = await navigator.serial.requestPort();
      app.selectedPort = port;
      const info = await checkSelectedPort();
      const { usbVendorId, usbProductId } = info;
      ui.portName.textContent = usbVendorId === undefined || usbProductId === undefined
        ? '已选择串口'
        : `VID ${usbVendorId.toString(16).padStart(4, '0')} / PID ${usbProductId.toString(16).padStart(4, '0')}`;
      appendLog('info', '已选择串口');
      if (!app.conflictingPorts.length) {
        openSession('serial', info);
      }
    } catch (error) {
      if (error?.name !== 'NotFoundError') appendLog('error', `选择串口失败：${error.message}`);
    } finally {
      app.checkingPorts = false;
      renderStatus();
    }
  }

  ui.forgetOtherPorts.addEventListener('click', async () => {
    app.checkingPorts = true;
    renderStatus();
    try {
      await checkSelectedPort();
      for (const port of app.conflictingPorts) {
        try {
          await port.forget();
        } catch (error) {
          appendLog('error', `移除授权失败：${error.message}`);
          break;
        }
      }
      await checkSelectedPort();
    } catch (error) {
      appendLog('error', `移除授权失败：${error.message}`);
    } finally {
      app.checkingPorts = false;
      renderStatus();
    }
  });

  ui.connect.addEventListener('click', async () => {
    if (!app.status?.connected) {
      await pickSerialPort();
      return;
    }
    app.disconnecting = true;
    app.armAfterConnect = false;
    cancelLiveTarget();
    renderStatus();
    post({ type: 'close' });
    stopHeartbeat();
  });

  ui.mock.addEventListener('click', () => openSession('mock'));

  ui.scan.addEventListener('click', () => {
    app.armAfterConnect = false;
    post({ type: 'scan' });
    resetScanSummary();
  });

  ui.arm.addEventListener('click', () => {
    if (ui.arm.disabled || document.hidden) return;
    const ids = [...app.devices.keys()].sort((a, b) => a - b);
    startFoc(ids);
  });

  for (const [button, automatic] of [[ui.updateManual, false], [ui.updateAuto, true]]) {
    button.addEventListener('click', () => {
      setTargetUpdateMode(automatic);
      renderStatus();
    });
  }

  ui.apply.addEventListener('click', () => {
    cancelLiveTarget();
    const ids = targetIds();
    if (!canApplyTarget(ids)) return;
    if (!applySetpoint({}, false)) {
      appendLog('warn', '请填写有效控制参数后再下发。');
      return;
    }
    submitTarget(ids);
  });

  ui.disarm.addEventListener('click', () => {
    if (document.hidden) return;
    cancelLiveTarget();
    app.disabling = true;
    startHeartbeat();
    post({ type: 'disable' });
    renderStatus();
  });
  // 在指针导致数字框失焦前停止，长按也不能让草稿先于 Stop 下发。
  ui.stopMotor.addEventListener('pointerdown', (event) => {
    if (event.isPrimary && event.button === 0) requestStop(true, '全局停止');
  });
  ui.stopMotor.addEventListener('click', (event) => {
    if (event.detail === 0) requestStop(true, '全局停止'); // 键盘和辅助技术的激活
  });

  // 模式切换
  const modeButtons = ui.modeButtons;
  modeButtons.forEach((button, index) => {
    button.addEventListener('click', () => setMode(button.dataset.runMode));
    button.addEventListener('keydown', (event) => {
      const next = {
        ArrowRight: (index + 1) % modeButtons.length,
        ArrowLeft: (index + modeButtons.length - 1) % modeButtons.length,
        Home: 0,
        End: modeButtons.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      setMode(modeButtons[next].dataset.runMode);
      modeButtons[next].focus();
    });
  });
  ui.multiReference.addEventListener('change', () => {
    app.broadcastRelative = ui.multiReference.value === 'relative';
    ui.setPos.value = '';
    app.resolvedBroadcastPosition = null;
    if (app.devices.has(app.selectedId)) applySetpoint({}, false);
    else updateModeHint();
  });

  // 数字逐键更新草稿。取消旧滑块计时器，防止它发送尚在编辑的数值。
  for (const field of setpointFields) {
    const input = ui[field];
    if (input.type === 'number') {
      input.addEventListener('input', () => {
        cancelLiveTarget();
        applySetpoint({}, false);
      });
      input.addEventListener('change', () => applySetpoint());
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          input.blur();
        }
      });
    } else {
      input.addEventListener('input', () => applySetpoint());
    }
  }

  for (const button of document.querySelectorAll('[data-nudge]')) {
    button.addEventListener('click', () => nudgePosition(Number(button.dataset.nudge)));
  }

  for (const button of document.querySelectorAll('[data-go]')) {
    button.addEventListener('click', () => goToAngle(Number(button.dataset.go)));
  }

  for (const button of document.querySelectorAll('[data-rel]')) {
    button.addEventListener('click', () => relativeMove(Number(button.dataset.rel)));
  }

  ui.posAngle.addEventListener('input', () => goToAngle(ui.posAngle.valueAsNumber));
  ui.singlePos.addEventListener('wheel', (event) => {
    if (document.activeElement !== ui.singlePos || event.ctrlKey || !event.deltaY || !event.cancelable) return;
    event.preventDefault();
    const angle = ui.singlePos.valueAsNumber;
    if (!Number.isFinite(angle) || !ui.singlePos.validity.valid) return;
    const next = Math.max(0, Math.min(360, angle - Math.sign(event.deltaY)));
    if (next !== angle) goToAngle(next);
  }, { passive: false });

  ui.velZero.addEventListener('click', () => {
    ui.velSpd.value = '0';
    applySetpoint();
  });

  const limitsForm = $('#limits-form');
  const limitInputs = [...limitsForm.querySelectorAll('input')];
  $('#open-limits').addEventListener('click', () => {
    if (ui.limitsDialog.open) {
      ui.limitsDialog.close();
      return;
    }
    ui.logDialog.close();
    const limits = app.status?.limits ?? DEFAULT_LIMITS;
    for (const input of limitInputs) input.value = limits[input.name];
    ui.limitsDialog.show();
  });
  $('#close-limits').addEventListener('click', () => ui.limitsDialog.close());
  ui.limitsDialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') ui.limitsDialog.close();
  });
  limitsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (ui.applyLimits.disabled) return;
    const limits = Object.fromEntries(limitInputs.map((input) => [input.name, input.valueAsNumber]));
    app.applyingLimits = true;
    renderStatus();
    post({ type: 'limits', limits });
  });

  for (const hz of [10, 20, 30, 50, 60, 100, 200]) {
    ui.controlHz.add(new Option(`${hz} Hz`, String(hz)));
  }
  ui.controlHz.value = String(DEFAULT_HZ);
  ui.controlHz.addEventListener('change', () => {
    post({ type: 'hz', hz: Number(ui.controlHz.value) });
  });

  const openLog = $('#open-log');
  const clearLog = $('#clear-log');
  const detailTabs = [...$('#log-tabs').querySelectorAll('[role="tab"]')];
  function selectDetailTab(tab) {
    for (const option of detailTabs) {
      const selected = option === tab;
      option.setAttribute('aria-selected', String(selected));
      option.tabIndex = selected ? 0 : -1;
      document.getElementById(option.getAttribute('aria-controls')).hidden = !selected;
    }
    clearLog.hidden = !ui.diagnosticsPanel.hidden;
    if (!ui.diagnosticsPanel.hidden) renderStats();
  }
  detailTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectDetailTab(tab));
    tab.addEventListener('keydown', (event) => {
      const next = {
        ArrowLeft: (index - 1 + detailTabs.length) % detailTabs.length,
        ArrowRight: (index + 1) % detailTabs.length,
        Home: 0,
        End: detailTabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      selectDetailTab(detailTabs[next]);
      detailTabs[next].focus();
    });
  });
  openLog.addEventListener('click', () => {
    if (ui.logDialog.open) {
      ui.logDialog.close();
      return;
    }
    ui.limitsDialog.close();
    ui.logDialog.show();
    openLog.setAttribute('aria-expanded', 'true');
    if (!ui.diagnosticsPanel.hidden) renderStats();
  });
  $('#close-log').addEventListener('click', () => ui.logDialog.close());
  ui.logDialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') ui.logDialog.close();
  });
  ui.logDialog.addEventListener('close', () => openLog.setAttribute('aria-expanded', 'false'));
  clearLog.addEventListener('click', () => {
    ui.log.replaceChildren();
  });

  document.addEventListener('visibilitychange', () => {
    const visible = !document.hidden;
    const supportsVisibility = Array.isArray(app.status?.activeIds);
    if (!visible) {
      if (!supportsVisibility && app.heartbeatTimer && !app.stopPending) {
        requestStop(!app.status?.monitoring, '页面进入后台');
        return;
      }
      app.armAfterConnect = false;
      cancelLiveTarget();
      stopHeartbeat();
    }
    if (supportsVisibility) post({ type: 'visibility', visible });
    if (visible) scheduleFeedbackFrame();
  });

  window.addEventListener('beforeunload', (event) => {
    if (app.idChangePending) {
      event.preventDefault();
      event.returnValue = '';
      return;
    }
    if (app.heartbeatTimer) post({ type: 'stop', hold: !app.status?.monitoring, reason: '页面关闭' });
  });
}

function startHeartbeat() {
  stopHeartbeat();
  const tick = () => post({ type: 'heartbeat' });
  tick();
  app.heartbeatTimer = setInterval(tick, 200);
}

function stopHeartbeat() {
  if (app.heartbeatTimer) clearInterval(app.heartbeatTimer);
  app.heartbeatTimer = null;
}

/* ---------------- 启动 ---------------- */

app.worker = startWorker();
bindControls();
showMode(app.mode);
renderStatus();

// 卡片读数和图表按设备快照重绘，指针跟随采样更新。
const plotGlyphs = Object.values(PLOT_AXES).map(({ unit }) => unit).join('');
function refreshPlotFont() {
  plotFont = currentPlotFont();
  plotAxisLabelWidths = undefined;
  renderFeedback();
  document.fonts.load(plotFont, `${plotLatestLabel}${plotGlyphs}0123456789−.`).then(() => {
    plotAxisLabelWidths = undefined;
    renderFeedback();
  }, () => {});
}
refreshPlotFont();

const remoteFonts = document.querySelector('meta[name="console-font-stylesheet"]')?.content;
if (remoteFonts) {
  const fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = remoteFonts;
  fonts.referrerPolicy = 'no-referrer';
  fonts.addEventListener('load', refreshPlotFont, { once: true });
  document.head.append(fonts);
}
new ResizeObserver(() => renderFeedback(false)).observe(ui.plot);
// Moving between displays can change DPR without resizing the canvas in CSS pixels.
setInterval(() => {
  if (lastPlotPaint && lastPlotPaint.dpr !== (window.devicePixelRatio || 1)) renderFeedback(false);
}, 500);

appendLog('info', '界面已就绪。选择串口连接真实设备，或进入模拟模式先熟悉操作。');
appendLog('info', `协议物理上限：力矩 ±${LIMITS.tor.toFixed(2)} N·m、转速 ±${LIMITS.spd.toFixed(1)} rad/s、位置 ±${LIMITS.pos.toFixed(1)} rad。`);
appendLog('info', `当前安全上限：力矩 ±${DEFAULT_LIMITS.tor} N·m、转速 ±${DEFAULT_LIMITS.spd} rad/s、Kp ≤ ${DEFAULT_LIMITS.kp}、Kd ≤ ${DEFAULT_LIMITS.kd}。`);
