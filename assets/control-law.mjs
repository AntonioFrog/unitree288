// 控制律：把「模式 + 用户参数」翻译成每帧实际发送的五个增益。
//
// 位置和速度模式由主机按速度偏差缩放 Kd。高级模式直接下发五个参数。
import { clamp } from './protocol.mjs';

export const MODES = Object.freeze({
  SINGLE_TURN: 'single-turn',
  POSITION: 'position',
  VELOCITY: 'velocity',
  MANUAL: 'manual',
});

export const SINGLE_TURN_MAX = 2 * Math.PI;

export function isPositionMode(mode) {
  return mode === MODES.SINGLE_TURN || mode === MODES.POSITION;
}

/**
 * 计算本帧要发送的增益与目标位置。
 * @param {object} profile 设定点 {mode,pos,spd,tor,kp,kd,tmax,vmax}
 * @param {object} feedback 最新反馈 {pos,spd}
 * @returns {{pos:number,spd:number,tor:number,kp:number,kd:number,capped:boolean}}
 */
export function resolveGains(profile, feedback) {
  const mode = profile.mode ?? MODES.MANUAL;
  const pos = Number.isFinite(profile.pos) ? profile.pos : 0;
  const spd = Number.isFinite(profile.spd) ? profile.spd : 0;
  const tor = Number.isFinite(profile.tor) ? profile.tor : 0;
  const kp = Math.max(0, Number.isFinite(profile.kp) ? profile.kp : 0);
  const kd = Math.max(0, Number.isFinite(profile.kd) ? profile.kd : 0);
  const tmax = Number.isFinite(profile.tmax) ? Math.max(0, profile.tmax) : Infinity;

  const p = Number.isFinite(feedback?.pos) ? feedback.pos : pos;
  const w = Number.isFinite(feedback?.spd) ? feedback.spd : 0;

  if (mode === MODES.MANUAL) {
    return { pos, spd, tor, kp, kd, capped: false };
  }

  if (mode === MODES.VELOCITY) {
    // 速度模式本来就没有位置项；上限只作用在阻尼项上。
    const error = Math.abs(spd - w);
    let kdEff = kd;
    let capped = false;
    if (error > 1e-6 && kd * error > tmax) {
      kdEff = tmax / error;
      capped = true;
    }
    return { pos, spd, tor: 0, kp: 0, kd: kdEff, capped };
  }

  // 位置模式：位置误差 → 速度指令 → 阻尼增益（串级），而不是直接发 Kp。
  //
  // 为什么不用 Kp 直发：
  //   1) 力矩上限只能靠缩放 Kp 实现，而 Kp 在协议里是 16 位定点
  //      （k_pos = Kp/(RATIO²)×1.28e6，Kp < 0.065 就变成 0），
  //      远目标会把 Kp 压到 0，舵机一滴力都不出——"目标填 0 没反应"就是这个。
  //   2) Kp 直发时，阻尼项会与位置项对冲，远距离稳态速度只有 tmax/kd
  //      （0.3/0.4 ≈ 0.75 rad/s），跑几十 rad 要几分钟。
  //
  // 串级形式：v_des = clamp(Kp·e / Kd, ±vmax)，发送 spd_des=v_des、Kp=0、Kd=Kd。
  // 小误差时 τ = Kd·(v_des − ω) = Kp·e − Kd·ω，与原 PD 完全等价；
  // 大误差时 v_des 被钳到 vmax，就是"限速逼近"；力矩上限只需缩放 Kd，
  // Kd 的定点分辨率是 Kp 的 100 倍（k_spd = Kd/(RATIO²)×1.28e8）。
  const vmax = Number.isFinite(profile.vmax) ? Math.max(0, profile.vmax) : 3;
  if (kd <= 1e-6) {
    // 串级需要阻尼；直发 Kp 会绕过位置模式的速度指令上限。
    return { pos: p, spd: 0, tor: 0, kp: 0, kd: 0, capped: false };
  }
  const desiredSpeed = (kp * (pos - p)) / kd;
  const clamped = clamp(desiredSpeed, -vmax, vmax);
  const error = Math.abs(clamped - w);
  let kdEff = kd;
  let capped = false;
  if (error > 1e-6 && kd * error > tmax) {
    kdEff = tmax / error;
    capped = true;
  }
  return {
    pos: p, // 位置项交给速度指令表达，这里不再叠加位置刚度
    spd: clamped,
    tor: 0,
    kp: 0,
    kd: kdEff,
    capped,
  };
}
