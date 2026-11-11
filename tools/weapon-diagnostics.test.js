/* tools/weapon-diagnostics.test.js
 *
 * 纯本地自动化测试：只依赖 Node 内置模块，不访问网络、凭据或 GPU。
 * 运行：node tools/weapon-diagnostics.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const D = require('./weapon-diagnostics.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok - ' + name);
  } catch (err) {
    console.error('  FAIL - ' + name);
    console.error('        ' + (err && err.stack ? err.stack.split('\n').join('\n        ') : err));
    process.exitCode = 1;
  }
}

/* 基线快照：步枪、状态干净、一次正常开火并记录命中 */
function baseSnapshot(overrides) {
  const snap = {
    weapon: {
      id: 'rifle', name: 'M4 CARBINE', mag: 29, magSize: 30, reserve: 210,
      range: 140, adsFov: 38, spreadBase: 0.0055
    },
    player: {
      weapon: 0, fireCooldown: 0, pumpT: 0, boltT: 0, reloadT: 0,
      ads: false, adsEase: 0, triggerHeld: true
    },
    shot: {
      fired: true,
      crosshairOnEnemy: true,
      crosshairOnWorld: false,
      hitRecorded: true,
      muzzleFlash: true,
      shellEjected: true,
      shellSide: 0.18
    }
  };
  if (overrides) {
    if (overrides.weapon) Object.assign(snap.weapon, overrides.weapon);
    if (overrides.player) Object.assign(snap.player, overrides.player);
    if (overrides.shot) Object.assign(snap.shot, overrides.shot);
  }
  return snap;
}

/* 递归确认整个诊断对象只含 JSON 类型（无函数/Symbol/undefined/循环引用） */
function assertJsonSafe(value, seen) {
  seen = seen || new Set();
  const t = typeof value;
  assert.ok(t !== 'function', '诊断对象不得包含函数');
  assert.ok(t !== 'symbol', '诊断对象不得包含 Symbol');
  if (value === null || t === 'string' || t === 'number' || t === 'boolean') return;
  assert.ok(t !== 'undefined', '诊断对象不得包含 undefined');
  assert.ok(!seen.has(value), '诊断对象不得包含循环引用');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(v => assertJsonSafe(v, seen));
  } else {
    assert.strictEqual(Object.getPrototypeOf(value), Object.prototype, '诊断对象只能含普通对象');
    for (const k of Object.keys(value)) assertJsonSafe(value[k], seen);
  }
}

console.log('weapon-diagnostics 自动化测试');

/* ---- 正常路径 ----------------------------------------------------------- */
test('正常路径：准星在敌人上且命中被记录 => 有效命中，全部检查项通过', () => {
  const r = D.diagnoseShot(baseSnapshot());
  assert.strictEqual(r.diagnosable, true);
  assert.strictEqual(r.verdict, D.VERDICT.VALID_HIT);
  assert.strictEqual(r.validHit, true);
  assert.ok(r.checks.length >= 10, '检查项数量应覆盖全部规定场景');
  const failed = r.checks.filter(c => !c.pass);
  assert.deepStrictEqual(failed, [], '正常路径下不应有失败的检查项: ' + JSON.stringify(failed));
  assert.strictEqual(r.firing.canFire, true);
  assert.strictEqual(r.firing.ammoReady, true);
  assert.strictEqual(r.firing.timersClear, true);
  assert.deepStrictEqual(r.firing.blockers, []);
  assert.strictEqual(r.fidelity.preEnemy, true);
  assert.strictEqual(r.fidelity.got, true);
  assert.strictEqual(r.fidelity.registeredHit, true);
  assert.strictEqual(r.fidelity.ghostMiss, false);
  assert.strictEqual(r.fidelity.falsePositive, false);
  assert.strictEqual(r.fidelity.category, 'registered');
  assert.strictEqual(r.fidelity.matches, true);
  assert.strictEqual(r.feedback.shellSideLabel, 'right');
});

/* ---- 负向路径：幽灵未命中 ------------------------------------------------ */
test('负向路径：准星在敌人上但未记录 => 幽灵未命中并给出可读原因', () => {
  const r = D.diagnoseShot(baseSnapshot({ shot: { hitRecorded: false } }));
  assert.strictEqual(r.validHit, false);
  assert.strictEqual(r.verdict, D.VERDICT.GHOST_MISS);
  const ghost = r.checks.find(c => c.name === D.CHECK.GHOST_MISS);
  assert.ok(ghost, '应包含幽灵未命中检查项');
  assert.strictEqual(ghost.pass, false);
  assert.ok(typeof ghost.reason === 'string' && ghost.reason.length > 0, '未通过时必须给出可读原因');
  assert.strictEqual(r.fidelity.preEnemy, true);
  assert.strictEqual(r.fidelity.got, false);
  assert.strictEqual(r.fidelity.registeredHit, false);
  assert.strictEqual(r.fidelity.ghostMiss, true);
  assert.strictEqual(r.fidelity.category, 'ghost-miss');
  /* 最终判定与 fidelity 的 preEnemy/got 分类自洽 => matches=true */
  assert.strictEqual(r.fidelity.matches, true);
  assert.ok(/G\.hits|命中/.test(ghost.reason));
});

/* ---- 边界：mag=0 -------------------------------------------------------- */
test('边界：mag=0 且无冷却 => 判不可开火，不抛异常', () => {
  const snap = baseSnapshot({
    weapon: { mag: 0 },
    player: { fireCooldown: 0 },
    shot: { fired: false, crosshairOnEnemy: false, hitRecorded: false,
            muzzleFlash: false, shellEjected: false }
  });
  let r;
  assert.doesNotThrow(() => { r = D.diagnoseShot(snap); });
  assert.strictEqual(r.firing.canFire, false);
  assert.strictEqual(r.firing.ammoReady, false);
  const mag = r.checks.find(c => c.name === D.CHECK.MAGAZINE_AMMO);
  assert.strictEqual(mag.pass, false);
  assert.ok(mag.reason.length > 0);
  assert.ok(r.firing.blockers.some(b => b.code === 'magazine-empty'));
  assert.strictEqual(r.verdict, D.VERDICT.NOT_FIRED);
  assert.strictEqual(r.validHit, false);
});

/* ---- 边界：pumpT 与 boltT 同时大于 0 ------------------------------------ */
test('边界：pumpT 与 boltT 同时 > 0 => 判不可开火，不抛异常', () => {
  const snap = baseSnapshot({
    player: { pumpT: 0.62, boltT: 1.5 },
    shot: { fired: false, crosshairOnEnemy: false, hitRecorded: false,
            muzzleFlash: false, shellEjected: false }
  });
  let r;
  assert.doesNotThrow(() => { r = D.diagnoseShot(snap); });
  assert.strictEqual(r.firing.canFire, false);
  assert.strictEqual(r.firing.timersClear, false);
  assert.strictEqual(r.checks.find(c => c.name === D.CHECK.PUMP_LOCK).pass, false);
  assert.strictEqual(r.checks.find(c => c.name === D.CHECK.BOLT_LOCK).pass, false);
  const codes = r.firing.blockers.map(b => b.code);
  assert.ok(codes.includes('pump-lock') && codes.includes('bolt-lock'));
});

/* ---- JSON 可序列化 ------------------------------------------------------ */
test('诊断对象经 JSON.stringify 可序列化且往返后结构一致', () => {
  const r = D.diagnoseShot(baseSnapshot());
  let text;
  assert.doesNotThrow(() => { text = JSON.stringify(r); });
  assert.strictEqual(typeof text, 'string');
  const back = JSON.parse(text);
  assert.strictEqual(back.verdict, r.verdict);
  assert.strictEqual(back.validHit, r.validHit);
  assert.strictEqual(back.checks.length, r.checks.length);
  assertJsonSafe(r);
});

/* ---- fidelity 语义真值表吻合 -------------------------------------------- */
test('fidelity 语义：四种观测组合下 validHit === (preEnemy && got)', () => {
  const combos = [
    { onEnemy: true, got: true },
    { onEnemy: true, got: false },
    { onEnemy: false, got: true },
    { onEnemy: false, got: false }
  ];
  for (const c of combos) {
    const r = D.diagnoseShot(baseSnapshot({
      shot: {
        crosshairOnEnemy: c.onEnemy,
        crosshairOnWorld: !c.onEnemy,
        hitRecorded: c.got
      }
    }));
    const expected = c.onEnemy && c.got;
    assert.strictEqual(r.validHit, expected,
      'preEnemy=' + c.onEnemy + ' got=' + c.got + ' 应得到 validHit=' + expected);
    assert.strictEqual(r.fidelity.registeredHit, expected,
      'registeredHit 必须等于 preEnemy && got');
    assert.strictEqual(r.fidelity.ghostMiss, c.onEnemy && !c.got);
    assert.strictEqual(r.fidelity.falsePositive, !c.onEnemy && c.got);
    assert.strictEqual(r.fidelity.matches, true, '判定链必须与 fidelity 分类自洽: ' + JSON.stringify(c));
  }
});

/* ---- 虚假命中 ----------------------------------------------------------- */
test('负向路径：准星在世界几何上却记录命中 => 虚假命中', () => {
  const r = D.diagnoseShot(baseSnapshot({
    shot: { crosshairOnEnemy: false, crosshairOnWorld: true, hitRecorded: true }
  }));
  assert.strictEqual(r.verdict, D.VERDICT.FALSE_HIT);
  assert.strictEqual(r.validHit, false);
  const fh = r.checks.find(c => c.name === D.CHECK.FALSE_HIT);
  assert.strictEqual(fh.pass, false);
  assert.ok(fh.reason.length > 0);
  assert.strictEqual(r.fidelity.falsePositive, true);
  assert.strictEqual(r.fidelity.category, 'false-positive');
  /* 最终判定与 fidelity 分类自洽 => matches=true（异常已在 verdict 与 false-hit 检查中体现） */
  assert.strictEqual(r.fidelity.matches, true);
});

/* ---- 世界阻挡不是命中 --------------------------------------------------- */
test('世界阻挡：准星在世界几何上且无记录 => world-impact，不算命中', () => {
  const r = D.diagnoseShot(baseSnapshot({
    shot: { crosshairOnEnemy: false, crosshairOnWorld: true,
            hitRecorded: false, shellEjected: true }
  }));
  assert.strictEqual(r.verdict, D.VERDICT.WORLD_IMPACT);
  assert.strictEqual(r.validHit, false);
  assert.strictEqual(r.fidelity.matches, true);
});

/* ---- 未开火 ------------------------------------------------------------- */
test('未开火 => not-fired，且不产生幽灵/虚假命中误报', () => {
  const r = D.diagnoseShot(baseSnapshot({
    shot: { fired: false, crosshairOnEnemy: true, hitRecorded: false,
            muzzleFlash: false, shellEjected: false }
  }));
  assert.strictEqual(r.verdict, D.VERDICT.NOT_FIRED);
  assert.strictEqual(r.validHit, false);
  assert.strictEqual(r.fidelity.matches, null, '未开火时不做 fidelity 吻合判定');
  assert.strictEqual(r.checks.find(c => c.name === D.CHECK.GHOST_MISS).pass, true,
    '未开火不应报幽灵未命中');
});

/* ---- ADS 未稳定只警告不失败 --------------------------------------------- */
test('ADS 缓动未完成 => 标注瞄准未稳定，但不判失败', () => {
  const r = D.diagnoseShot(baseSnapshot({
    player: { ads: true, adsEase: 0.42 }
  }));
  const stab = r.checks.find(c => c.name === D.CHECK.ADS_STABILITY);
  assert.strictEqual(stab.pass, true, 'ADS 未稳定不得判为失败');
  assert.ok(stab.note && stab.note.length > 0, '应以 note 标注瞄准尚未稳定');
  assert.strictEqual(r.aim.stable, false);
  assert.ok(r.aim.warning && r.aim.warning.indexOf('尚未稳定') >= 0);
  assert.strictEqual(r.validHit, true, 'ADS 未稳定不影响有效命中结论');

  const settled = D.diagnoseShot(baseSnapshot({ player: { ads: true, adsEase: 1 } }));
  assert.strictEqual(settled.aim.stable, true);
  assert.strictEqual(settled.aim.warning, null);
});

/* ---- 延迟抛壳武器的反馈语义 --------------------------------------------- */
test('霰弹枪/狙击枪开火瞬间无弹壳 => 抛壳检查通过并附预期行为说明', () => {
  const sg = D.diagnoseShot(baseSnapshot({
    weapon: { id: 'shotgun', name: 'KS-12 PUMP' },
    player: { pumpT: 0.62, boltT: 0 },
    shot: { shellEjected: false }
  }));
  const shell = sg.checks.find(c => c.name === D.CHECK.SHELL_EJECTION);
  assert.strictEqual(shell.pass, true);
  assert.ok(shell.note && shell.note.indexOf('泵动') >= 0);

  const sn = D.diagnoseShot(baseSnapshot({
    weapon: { id: 'sniper', name: 'SR-7 LONGBOW' },
    player: { pumpT: 0, boltT: 1.5 },
    shot: { shellEjected: false }
  }));
  const shell2 = sn.checks.find(c => c.name === D.CHECK.SHELL_EJECTION);
  assert.strictEqual(shell2.pass, true);
  assert.ok(shell2.note && shell2.note.indexOf('枪机') >= 0);
});

/* ---- 弹壳左右侧标签 ----------------------------------------------------- */
test('弹壳侧别：正=right、负=left、零=centered、null 保持 null', () => {
  const right = D.diagnoseShot(baseSnapshot({ shot: { shellSide: 0.2 } }));
  assert.strictEqual(right.feedback.shellSideLabel, 'right');
  const left = D.diagnoseShot(baseSnapshot({ shot: { shellSide: -0.15 } }));
  assert.strictEqual(left.feedback.shellSideLabel, 'left');
  const center = D.diagnoseShot(baseSnapshot({ shot: { shellSide: 0 } }));
  assert.strictEqual(center.feedback.shellSideLabel, 'centered');
  const none = D.diagnoseShot(baseSnapshot({ shot: { shellSide: null } }));
  assert.strictEqual(none.feedback.shellSideLabel, null);
});

/* ---- 其余冷却门槛各自生效 ----------------------------------------------- */
test('reloadT / fireCooldown > 0 各自独立阻断开火', () => {
  const reloading = D.diagnoseShot(baseSnapshot({
    player: { reloadT: 1.2 },
    shot: { fired: false, crosshairOnEnemy: false, hitRecorded: false,
            muzzleFlash: false, shellEjected: false }
  }));
  assert.strictEqual(reloading.firing.canFire, false);
  assert.strictEqual(reloading.checks.find(c => c.name === D.CHECK.RELOAD_LOCK).pass, false);

  const cooling = D.diagnoseShot(baseSnapshot({
    player: { fireCooldown: 0.1 },
    shot: { fired: false, crosshairOnEnemy: false, hitRecorded: false,
            muzzleFlash: false, shellEjected: false }
  }));
  assert.strictEqual(cooling.firing.canFire, false);
  assert.strictEqual(cooling.checks.find(c => c.name === D.CHECK.FIRE_COOLDOWN).pass, false);
});

/* ---- 反馈通道异常 ------------------------------------------------------- */
test('开火却无枪口闪光 => 枪口闪光检查失败并给原因', () => {
  const r = D.diagnoseShot(baseSnapshot({ shot: { muzzleFlash: false } }));
  const flash = r.checks.find(c => c.name === D.CHECK.MUZZLE_FLASH);
  assert.strictEqual(flash.pass, false);
  assert.ok(flash.reason.length > 0);
});

/* ---- 畸形输入不抛异常 --------------------------------------------------- */
test('畸形/缺失输入不抛异常，且结果仍可 JSON 序列化', () => {
  for (const bad of [undefined, null, {}, { weapon: null }, { shot: { fired: 'yes' } },
                     { player: { adsEase: NaN } }, [], 'nope', 42]) {
    let r;
    assert.doesNotThrow(() => { r = D.diagnoseShot(bad); });
    assert.strictEqual(r.diagnosable, true, '纯模块对畸形输入走归一化而非不可诊断');
    assert.doesNotThrow(() => JSON.stringify(r));
  }
});

/* ---- notDiagnosable 辅助 ------------------------------------------------ */
test('notDiagnosable：玩家死亡/对局结束场景返回结构化结果且可序列化', () => {
  const r = D.notDiagnosable('玩家已死亡');
  assert.strictEqual(r.diagnosable, false);
  assert.strictEqual(r.verdict, D.VERDICT.NOT_DIAGNOSABLE);
  assert.strictEqual(r.validHit, false);
  assert.strictEqual(r.reason, '玩家已死亡');
  assert.ok(Array.isArray(r.checks));
  assert.doesNotThrow(() => JSON.stringify(r));
});

/* ---- 检查项结构契约 ----------------------------------------------------- */
test('每个检查项都含 name / label / pass，且失败必有原因、原因不含对象', () => {
  const r = D.diagnoseShot(baseSnapshot({ shot: { hitRecorded: false } }));
  for (const c of r.checks) {
    assert.strictEqual(typeof c.name, 'string');
    assert.strictEqual(typeof c.label, 'string');
    assert.strictEqual(typeof c.pass, 'boolean');
    if (!c.pass) {
      assert.strictEqual(typeof c.reason, 'string');
      assert.ok(c.reason.length > 0);
    } else {
      assert.strictEqual(c.reason, null);
    }
    assert.ok(c.note === null || typeof c.note === 'string');
  }
});

/* ---- harness 集成：仅语法与结构检查（无浏览器环境，不执行） -------------- */
test('test-harness.js 语法有效且 H.diagnose 已接入，既有方法签名保持不变', () => {
  const src = fs.readFileSync(path.join(__dirname, 'test-harness.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(src), 'test-harness.js 必须可被 JS 引擎解析');
  for (const m of ['place', 'frame', 'lane', 'fidelity', 'accuracy', 'wtest', 'state',
                   'diagnose']) {
    assert.ok(new RegExp('(?:async\\s+)?' + m + '\\s*[(:]').test(src),
      'window.H 应包含方法 ' + m);
  }
  /* diagnose 只读：不得在该方法内调用会改变状态的 fireWeapon/startReload/setADS */
  const body = src.slice(src.indexOf('diagnose(obs)'), src.indexOf('resume(){'));
  assert.ok(!/\bfireWeapon\s*\(/.test(body), 'diagnose 不得调用 fireWeapon');
  assert.ok(!/\bstartReload\s*\(/.test(body), 'diagnose 不得调用 startReload');
  assert.ok(!/\bsetADS\s*\(/.test(body), 'diagnose 不得调用 setADS');
  assert.ok(body.indexOf('player.dead') >= 0 && body.indexOf('G.over') >= 0,
    '死亡/对局结束时应返回不可诊断');

  const diagSrc = fs.readFileSync(path.join(__dirname, 'weapon-diagnostics.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(diagSrc), 'weapon-diagnostics.js 必须可被 JS 引擎解析');
});

/* ---- index.html 游戏逻辑未被改动（harness/diag 均不被其引用） ------------ */
test('index.html 未引用 tools/ 下的开发工具', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('test-harness') === -1);
  assert.ok(html.indexOf('weapon-diagnostics') === -1);
  assert.ok(html.indexOf('autoplay-bot') === -1);
});

console.log('\n' + passed + ' 个测试通过' + (process.exitCode ? '，存在失败用例' : ''));
