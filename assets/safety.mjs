// 安全策略：把"能发什么"和"什么时候必须停"集中在一处，便于离线回归。
// 默认值刻意保守：首次上电只允许小力矩、低转速、低刚度。
import { LIMITS, clamp } from './protocol.mjs';
import { MODES, SINGLE_TURN_MAX } from './control-law.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  tor: 1.5, // N·m（输出端）
  spd: 4, // rad/s（输出端）
  kp: 20,
  kd: 1.0,
  minVoltage: 10, // V
  maxTemp: 75, // ℃
});

export const DEFAULT_HZ = 100;
export const LINK_MIN_SAMPLES = 20;

/**
 * 把界面输入规整成可发送的设定点：先按用户配置上限，再按协议物理上限。
 * 返回 { setpoint, clipped: string[] }，clipped 用于在界面上提示。
 */
export function sanitizeSetpoint(input, limits = DEFAULT_LIMITS) {
  const clipped = [];
  const pick = (name, value, min, max, fallback = 0) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return fallback;
    const clamped = clamp(v, min, max);
    if (clamped !== v) clipped.push(name);
    return clamped;
  };

  const mode = input?.mode ?? MODES.MANUAL;
  const singleTurn = mode === MODES.SINGLE_TURN;
  const setpoint = {
    mode,
    pos: pick('pos', input?.pos, singleTurn ? 0 : -LIMITS.pos, singleTurn ? SINGLE_TURN_MAX : LIMITS.pos, 0),
    spd: pick('spd', input?.spd, -Math.min(limits.spd, LIMITS.spd), Math.min(limits.spd, LIMITS.spd)),
    tor: pick('tor', input?.tor, -Math.min(limits.tor, LIMITS.tor), Math.min(limits.tor, LIMITS.tor)),
    kp: pick('kp', input?.kp, 0, Math.min(limits.kp, LIMITS.kp)),
    kd: pick('kd', input?.kd, 0, Math.min(limits.kd, LIMITS.kd)),
    // 力矩上限不能超过全局力矩上限，否则"上限"形同虚设。
    tmax: pick('tmax', input?.tmax, 0, limits.tor, Math.min(0.3, limits.tor)),
    // 位置模式远距离逼近的限速（只影响"引导目标"推进速度，不改变稳态刚度）。
    vmax: pick('vmax', input?.vmax, 0, limits.spd, Math.min(3, limits.spd)),
  };
  return { setpoint, clipped };
}

/**
 * 单帧监督。返回 { level: 'ok' | 'warn' | 'fault', reasons }。
 * fault 由控制循环立即停机；warn 只在界面提示，不中断运动。
 */
export function supervise(feedback, limits = DEFAULT_LIMITS) {
  const reasons = [];
  let level = 'ok';

  if (feedback.error) {
    level = 'fault';
    reasons.push(`舵机错误码 0x${feedback.error.toString(16)}`);
  }
  if (feedback.vol < limits.minVoltage) {
    level = 'fault';
    reasons.push(`母线电压 ${feedback.vol.toFixed(1)} V 低于 ${limits.minVoltage} V`);
  } else if (feedback.vol < limits.minVoltage + 1) {
    level = level === 'ok' ? 'warn' : level;
    reasons.push(`母线电压偏低 ${feedback.vol.toFixed(1)} V`);
  }
  if (feedback.temp > limits.maxTemp) {
    level = 'fault';
    reasons.push(`壳体温度 ${feedback.temp} ℃ 超过 ${limits.maxTemp} ℃`);
  } else if (feedback.temp > 70) {
    level = level === 'ok' ? 'warn' : level;
    reasons.push(`壳体温度偏高 ${feedback.temp} ℃`);
  }
  if (feedback.timeout) {
    level = level === 'ok' ? 'warn' : level;
    reasons.push('舵机报告超时保护已触发');
  }
  return { level, reasons };
}

/**
 * 通信质量判据。连续缺测或超时比例过高时，运动必须停止而不是"继续重试"。
 */
export function linkVerdict({ timeouts, total }, { maxTimeoutRatio = 0.25, minSamples = LINK_MIN_SAMPLES } = {}) {
  if (total < minSamples) return { level: 'ok', reasons: [] };
  const ratio = timeouts / total;
  if (ratio > maxTimeoutRatio) {
    return {
      level: 'fault',
      reasons: `反馈超时率 ${(ratio * 100).toFixed(0)}%（阈值 ${(maxTimeoutRatio * 100).toFixed(0)}%）`,
    };
  }
  return { level: 'ok', reasons: [] };
}
