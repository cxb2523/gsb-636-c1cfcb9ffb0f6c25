/* tools/weapon-diagnostics.js — 武器命中与反馈诊断（纯函数模块）
 *
 * Dev-only: never referenced by index.html. Loaded manually alongside
 * test-harness.js (console / DevTools protocol), or required from Node tests.
 *
 * 设计约束：
 *   - 输入是一份纯数据快照，不接触 Three.js / DOM / 任何游戏全局对象；
 *   - 输出是可 JSON 序列化的纯数据对象（仅原始类型、数组、普通对象）；
 *   - 任何输入都不得抛异常，畸形快照回退为“不可诊断”结果；
 *   - 有效命中的判定与 test-harness.js 的 fidelity 语义一致：
 *     fidelity 中 preEnemy=准星是否落在敌人 hitbox，got=G.hits 是否增加，
 *     注册命中当且仅当 preEnemy && got。
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.WeaponDiagnostics = api;
  else if (global) global.WeaponDiagnostics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  /* adsEase 由 easeInOutCubic(adsK) 驱动，完全稳定时收敛到 1；留一点浮点余量 */
  const ADS_STABLE_EPS = 0.99;
  /* 这两类武器不在开火瞬间抛壳：霰弹枪随泵动、狙击枪随枪机循环延迟抛壳 */
  const DELAYED_EJECT = { shotgun: true, sniper: true };

  const VERDICT = {
    VALID_HIT: 'valid-hit',         // 准星在敌人上且命中被记录
    GHOST_MISS: 'ghost-miss',       // 准星在敌人上但未记录命中
    FALSE_HIT: 'false-hit',         // 准星不在敌人上却记录了命中
    WORLD_IMPACT: 'world-impact',   // 准星在世界几何上，未记录命中（正常阻挡）
    OPEN_SHOT: 'open-shot',         // 射线落空，未记录命中
    NOT_FIRED: 'not-fired',         // 未开火
    NOT_DIAGNOSABLE: 'not-diagnosable'
  };

  const CHECK = {
    SHOT_FIRED: 'shot-fired',
    MAGAZINE_AMMO: 'magazine-ammo',
    FIRE_COOLDOWN: 'fire-cooldown',
    PUMP_LOCK: 'pump-lock',
    BOLT_LOCK: 'bolt-lock',
    RELOAD_LOCK: 'reload-lock',
    GHOST_MISS: 'ghost-miss',
    FALSE_HIT: 'false-hit',
    ADS_STABILITY: 'ads-stability',
    MUZZLE_FLASH: 'muzzle-flash',
    SHELL_EJECTION: 'shell-ejection'
  };

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function bool(v) {
    return v === true;
  }
  function str(v) {
    return v === undefined || v === null ? '' : String(v);
  }
  function sideLabel(side) {
    if (side === null) return null;
    if (side > 0) return 'right';
    if (side < 0) return 'left';
    return 'centered';
  }

  /* 把任意输入归一化为形状固定、全原始类型的快照；永不抛异常 */
  function normalize(input) {
    const src = input && typeof input === 'object' ? input : {};
    const w = src.weapon && typeof src.weapon === 'object' ? src.weapon : {};
    const p = src.player && typeof src.player === 'object' ? src.player : {};
    const s = src.shot && typeof src.shot === 'object' ? src.shot : {};

    const shellSideRaw = s.shellSide === null || s.shellSide === undefined
      ? null : Number(s.shellSide);
    return {
      weapon: {
        id: str(w.id),
        name: str(w.name),
        mag: num(w.mag),
        magSize: num(w.magSize),
        reserve: num(w.reserve),
        range: num(w.range),
        adsFov: num(w.adsFov),
        spreadBase: num(w.spreadBase)
      },
      player: {
        weapon: num(p.weapon),
        fireCooldown: num(p.fireCooldown),
        pumpT: num(p.pumpT),
        boltT: num(p.boltT),
        reloadT: num(p.reloadT),
        ads: bool(p.ads),
        adsEase: Math.max(0, Math.min(1, num(p.adsEase))),
        triggerHeld: bool(p.triggerHeld)
      },
      shot: {
        fired: bool(s.fired),
        crosshairOnEnemy: bool(s.crosshairOnEnemy),
        crosshairOnWorld: bool(s.crosshairOnWorld),
        hitRecorded: bool(s.hitRecorded),
        muzzleFlash: bool(s.muzzleFlash),
        shellEjected: bool(s.shellEjected),
        shellSide: Number.isFinite(shellSideRaw) ? shellSideRaw : null
      }
    };
  }

  function item(name, label, pass, reason, note) {
    return {
      name,
      label,
      pass: pass === true,
      reason: pass === true ? null : (reason || '检查未通过'),
      note: note || null
    };
  }

  function notDiagnosable(reason) {
    return {
      schemaVersion: SCHEMA_VERSION,
      diagnosable: false,
      verdict: VERDICT.NOT_DIAGNOSABLE,
      validHit: false,
      reason: str(reason) || '当前状态不可诊断',
      firing: {
        canFire: false,
        ammoReady: false,
        timersClear: false,
        blockers: []
      },
      aim: {
        adsRequested: false,
        adsEase: 0,
        stable: false,
        warning: null
      },
      feedback: {
        muzzleFlash: false,
        shellEjected: false,
        shellSide: null,
        shellSideLabel: null
      },
      fidelity: {
        preEnemy: false,
        got: false,
        registeredHit: false,
        matches: null
      },
      checks: [],
      snapshot: null
    };
  }

  function diagnoseShot(input) {
    let snap;
    try {
      snap = normalize(input);
    } catch (err) {
      return notDiagnosable('快照格式无效：' + (err && err.message ? err.message : String(err)));
    }
    const w = snap.weapon;
    const p = snap.player;
    const s = snap.shot;

    /* ---- 弹药与冷却：复刻 fireWeapon() 开头的开火门槛 -------------------- */
    const blockers = [];
    const ammoReady = w.mag > 0;
    if (!ammoReady) {
      blockers.push({
        code: 'magazine-empty',
        reason: '弹匣已空（mag=0），无实弹可发射；若尚有备弹，游戏会先触发自动换弹'
      });
    }
    if (p.fireCooldown > 0) {
      blockers.push({
        code: 'fire-cooldown',
        reason: '射击冷却尚未结束（fireCooldown=' + p.fireCooldown + ' > 0）'
      });
    }
    if (p.pumpT > 0) {
      blockers.push({
        code: 'pump-lock',
        reason: '泵动动作未完成（pumpT=' + p.pumpT + ' > 0），暂不可开火'
      });
    }
    if (p.boltT > 0) {
      blockers.push({
        code: 'bolt-lock',
        reason: '枪机循环未完成（boltT=' + p.boltT + ' > 0），暂不可开火'
      });
    }
    if (p.reloadT > 0) {
      blockers.push({
        code: 'reload-lock',
        reason: '正在换弹（reloadT=' + p.reloadT + ' > 0），暂不可开火'
      });
    }
    const timersClear = p.fireCooldown <= 0 && p.pumpT <= 0 &&
                        p.boltT <= 0 && p.reloadT <= 0;
    const canFire = ammoReady && timersClear;

    /* ---- 命中判定：与 fidelity 的 preEnemy / got 比较保持同构 ------------- */
    const onEnemy = s.crosshairOnEnemy;
    const onWorld = !onEnemy && s.crosshairOnWorld;
    const recorded = s.hitRecorded;

    /* fidelity 口径下的四个分类（与 test-harness.js fidelity() 的计数器同构）：
       registered  = preEnemy && got
       ghostMiss   = preEnemy && !got
       falsePositive = !preEnemy && got
       cleanWorld  = !preEnemy && !got（世界阻挡或落空，均属正常） */
    const fidelityCategory = !s.fired ? 'not-fired'
      : (onEnemy && recorded) ? 'registered'
      : (onEnemy && !recorded) ? 'ghost-miss'
      : (!onEnemy && recorded) ? 'false-positive'
      : 'clean-world';

    let verdict;
    let verdictReason;
    if (!s.fired) {
      verdict = VERDICT.NOT_FIRED;
      verdictReason = '本次没有成功开火，无命中判定';
    } else if (onEnemy && recorded) {
      verdict = VERDICT.VALID_HIT;
      verdictReason = '准星落在敌人 hitbox 上且命中已被 G.hits 记录，判定为有效命中';
    } else if (onEnemy && !recorded) {
      verdict = VERDICT.GHOST_MISS;
      verdictReason = '准星落在敌人 hitbox 上但命中未被 G.hits 记录，判定为幽灵未命中';
    } else if (!onEnemy && recorded) {
      verdict = VERDICT.FALSE_HIT;
      verdictReason = onWorld
        ? '准星落在世界几何上，G.hits 却记录了命中，判定为虚假命中'
        : '准星未落在敌人 hitbox 上，G.hits 却记录了命中，判定为虚假命中';
    } else if (onWorld) {
      verdict = VERDICT.WORLD_IMPACT;
      verdictReason = '准星落在世界几何上且未记录命中，属于正常的世界阻挡，不是有效命中';
    } else {
      verdict = VERDICT.OPEN_SHOT;
      verdictReason = '准星射线未命中敌人或世界几何，也未记录命中';
    }
    const validHit = verdict === VERDICT.VALID_HIT;
    /* fidelity 分类与最终 verdict 是否自洽；若不一致说明判定链出现回归 */
    const expectedVerdictByCategory = {
      'registered': VERDICT.VALID_HIT,
      'ghost-miss': VERDICT.GHOST_MISS,
      'false-positive': VERDICT.FALSE_HIT,
      'clean-world': onWorld ? VERDICT.WORLD_IMPACT : VERDICT.OPEN_SHOT,
      'not-fired': VERDICT.NOT_FIRED
    };
    const fidelityMatches = s.fired
      ? verdict === expectedVerdictByCategory[fidelityCategory]
      : null;

    /* ---- 顺序检查项 ------------------------------------------------------ */
    const checks = [];

    checks.push(item(
      CHECK.SHOT_FIRED, '开火状态',
      s.fired,
      '本次射击未成功开火（fired=false），无法形成命中'
    ));

    checks.push(item(
      CHECK.MAGAZINE_AMMO, '弹匣弹药',
      ammoReady,
      '弹匣已空（mag=0），且当前没有实弹可供发射'
    ));

    checks.push(item(
      CHECK.FIRE_COOLDOWN, '射击冷却',
      p.fireCooldown <= 0,
      '射击冷却尚未结束（fireCooldown=' + p.fireCooldown + ' > 0），不可开火'
    ));

    checks.push(item(
      CHECK.PUMP_LOCK, '泵动锁定',
      p.pumpT <= 0,
      '泵动动作未完成（pumpT=' + p.pumpT + ' > 0），不可开火'
    ));

    checks.push(item(
      CHECK.BOLT_LOCK, '枪机锁定',
      p.boltT <= 0,
      '枪机循环未完成（boltT=' + p.boltT + ' > 0），不可开火'
    ));

    checks.push(item(
      CHECK.RELOAD_LOCK, '换弹锁定',
      p.reloadT <= 0,
      '正在换弹（reloadT=' + p.reloadT + ' > 0），不可开火'
    ));

    /* 幽灵未命中：准星在敌人 hitbox 上、枪也响了，G.hits 却没记 */
    const ghost = s.fired && onEnemy && !recorded;
    checks.push(item(
      CHECK.GHOST_MISS, '幽灵未命中',
      !ghost,
      '准星射线首个命中为敌人 hitbox，但 G.hits 未记录本次命中（幽灵未命中）',
      !s.fired ? '未开火，幽灵未命中检查不适用' : null
    ));

    /* 虚假命中：准星根本不在敌人上，G.hits 却记了一发 */
    const falseHit = recorded && !onEnemy;
    checks.push(item(
      CHECK.FALSE_HIT, '虚假命中',
      !falseHit,
      onWorld
        ? '准星落在世界几何上，G.hits 却记录了命中（虚假命中）'
        : '准星未落在敌人 hitbox 上，G.hits 却记录了命中（虚假命中）'
    ));

    /* ADS 稳定性：只标注、永不判失败 */
    const adsStable = !p.ads || p.adsEase >= ADS_STABLE_EPS;
    checks.push(item(
      CHECK.ADS_STABILITY, '瞄准稳定性',
      true,
      null,
      p.ads && !adsStable
        ? 'ADS 已请求但缓动尚未完成（adsEase=' + p.adsEase + ' < 1），瞄准尚未稳定；该状态不判定为失败'
        : null
    ));

    /* 枪口闪光反馈 */
    let flashPass = true;
    let flashReason = null;
    if (s.fired && !s.muzzleFlash) {
      flashPass = false;
      flashReason = '已开火但未观测到枪口闪光，反馈通道异常';
    } else if (!s.fired && s.muzzleFlash) {
      flashPass = false;
      flashReason = '未开火却观测到枪口闪光，反馈通道异常';
    }
    checks.push(item(CHECK.MUZZLE_FLASH, '枪口闪光', flashPass, flashReason));

    /* 抛壳反馈：步枪/手枪开火即抛；霰弹/狙击随泵动/枪机延迟抛壳 */
    let shellPass = true;
    let shellReason = null;
    let shellNote = null;
    const delayed = !!DELAYED_EJECT[w.id];
    if (!s.fired && s.shellEjected) {
      shellPass = false;
      shellReason = '未开火却观测到弹壳抛出，反馈通道异常';
    } else if (s.fired && !delayed && !s.shellEjected) {
      shellPass = false;
      shellReason = '已开火但未观测到弹壳抛出，反馈通道异常';
    } else if (s.fired && delayed) {
      shellNote = w.id === 'shotgun'
        ? '霰弹枪在泵动阶段抛壳，开火瞬间无弹壳属预期行为'
        : '狙击枪在枪机循环阶段抛壳，开火瞬间无弹壳属预期行为';
    } else if (!s.fired) {
      shellNote = '未开火，抛壳检查不适用';
    }
    checks.push(item(CHECK.SHELL_EJECTION, '抛壳反馈', shellPass, shellReason, shellNote));

    return {
      schemaVersion: SCHEMA_VERSION,
      diagnosable: true,
      verdict,
      validHit,
      reason: verdictReason,
      firing: {
        canFire,
        ammoReady,
        timersClear,
        blockers
      },
      aim: {
        adsRequested: p.ads,
        adsEase: p.adsEase,
        stable: adsStable,
        warning: p.ads && !adsStable
          ? 'ADS 缓动尚未完成（adsEase=' + p.adsEase + '），瞄准尚未稳定'
          : null
      },
      feedback: {
        muzzleFlash: s.muzzleFlash,
        shellEjected: s.shellEjected,
        shellSide: s.shellSide,
        shellSideLabel: sideLabel(s.shellSide)
      },
      fidelity: {
        /* 与 test-harness.js fidelity() 的 preEnemy / got 同构 */
        preEnemy: onEnemy,
        got: recorded,
        registeredHit: onEnemy && recorded,
        ghostMiss: s.fired && onEnemy && !recorded,
        falsePositive: s.fired && !onEnemy && recorded,
        category: fidelityCategory,
        /* 开火观测下，最终判定必须与 fidelity 的 preEnemy/got 比较结果吻合 */
        matches: fidelityMatches
      },
      checks,
      snapshot: snap
    };
  }

  return {
    SCHEMA_VERSION,
    ADS_STABLE_EPS,
    VERDICT,
    CHECK,
    diagnoseShot,
    notDiagnosable
  };
});
