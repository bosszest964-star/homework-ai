import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script id="pen-input">([\s\S]+?)<\/script>/)?.[1];
assert.ok(script, 'ไม่พบสคริปต์จัดการปากกาใน index.html');
const context = createContext();
runInContext(script, context, { filename: 'index.html#pen-input' });
const { createPolicy, createSession, readPressure, strokeWidth, samples } = context.PenInput;

const pointer = (pointerId, pointerType, type = 'pointerdown', options = {}) =>
  ({ pointerId, pointerType, type, button: 0, ...options });

test('โหมดอัตโนมัติกรองฝ่ามือก่อนแตะปากกา ทั้งฝ่ามือที่ยังวางอยู่และยกไปแล้ว', () => {
  const policy = createPolicy();
  const session = createSession(policy);
  assert.equal(policy.mode, 'auto');
  assert.equal(policy.penReady, false);
  assert.equal(session.begin(pointer(1, 'touch')), false);
  assert.equal(session.tracks(pointer(1, 'touch', 'pointermove')), false);
  assert.equal(session.end(pointer(1, 'touch', 'pointerup')), false);
  assert.equal(session.activePointerId, null);
  assert.equal(session.begin(pointer(2, 'touch')), false);
  assert.equal(policy.observe('pen'), true);
  assert.equal(policy.penReady, true);
  assert.equal(session.begin(pointer(3, 'pen')), true);
  assert.equal(session.tracks(pointer(3, 'pen', 'pointermove')), true);
  assert.equal(session.tracks(pointer(2, 'touch', 'pointermove')), false);
  assert.equal(session.end(pointer(2, 'touch', 'pointercancel')), false);
  assert.equal(session.end(pointer(3, 'pen', 'pointerup')), true);
  assert.equal(session.begin(pointer(4, 'touch')), false);
});

test('โหมดอัตโนมัติเปิดการใช้งานด้วยเมาส์และแจ้งสถานะเมื่อพบปากกาครั้งแรก', () => {
  const policy = createPolicy('auto');
  assert.equal(policy.accepts('mouse'), true);
  assert.equal(policy.observe('mouse'), false);
  assert.equal(policy.observe('touch'), false);
  assert.equal(policy.penReady, false);
  assert.equal(policy.observe('pen'), true);
  assert.equal(policy.observe('pen'), false);
  assert.equal(policy.penReady, true);
  assert.equal(policy.accepts('mouse'), true);
});

test('โหมดเฉพาะปากกาเริ่มกรองทันทีและไม่รับเมาส์หรือนิ้ว', () => {
  const policy = createPolicy('pen');
  const session = createSession(policy);
  assert.equal(policy.penReady, true);
  assert.equal(session.begin(pointer(1, 'mouse')), false);
  assert.equal(session.begin(pointer(2, 'touch')), false);
  assert.equal(session.begin(pointer(3, 'pen')), true);
});

test('โหมดนิ้วมือ + ปากกายอมรับสัมผัสอีกครั้งและจำการพบปากกาเมื่อกลับมาโหมดอัตโนมัติ', () => {
  const policy = createPolicy('auto');
  policy.observe('pen');
  policy.setMode('mixed');
  assert.equal(policy.penReady, false);
  assert.equal(policy.accepts('touch'), true);
  assert.equal(policy.accepts('pen'), true);
  assert.equal(policy.accepts('mouse'), true);
  policy.setMode('auto');
  assert.equal(policy.penReady, true);
  assert.equal(policy.accepts('touch'), false);
});

test('กระดานหนึ่งผูกกับ pointer เดียว และเหตุการณ์จาก pointer อื่นปล่อยตัวที่กำลังเขียนไม่ได้', () => {
  const session = createSession(createPolicy('mixed'));
  assert.equal(session.begin(pointer(10, 'pen')), true);
  assert.equal(session.begin(pointer(9, 'touch')), false);
  assert.equal(session.tracks(pointer(9, 'touch', 'pointermove')), false);
  assert.equal(session.end(pointer(9, 'touch', 'pointercancel')), false);
  assert.equal(session.activePointerId, 10);
  assert.equal(session.end(pointer(10, 'pen', 'pointercancel')), true);
  assert.equal(session.activePointerId, null);
  assert.equal(session.begin(pointer(11, 'touch')), true);
});

test('รองรับจุดสั้น ๆ ต่อเนื่องหลัง pointerup, pointercancel และเสียการจับ pointer', () => {
  const session = createSession(createPolicy('auto'));
  for (const [id, endType] of ['pointerup', 'pointercancel', 'lostpointercapture'].entries()) {
    assert.equal(session.begin(pointer(id, 'pen')), true);
    assert.equal(session.end(pointer(id, 'pen', endType)), true);
    assert.equal(session.activePointerId, null);
  }
});

test('กระดานและใบงานใช้กติกาเดียวกันและแยกสถานะ pointer ที่กำลังใช้งาน', () => {
  const policy = createPolicy('mixed');
  const studio = createSession(policy);
  const worksheet = createSession(policy);
  assert.equal(studio.begin(pointer(1, 'touch')), true);
  assert.equal(worksheet.activePointerId, null);
  assert.equal(studio.end(), true);
  assert.equal(studio.end(), false);
  policy.setMode('pen');
  assert.equal(studio.begin(pointer(2, 'touch')), false);
  assert.equal(worksheet.begin(pointer(2, 'touch')), false);
  assert.equal(worksheet.begin(pointer(3, 'pen')), true);
});

test('ไม่รับคลิกขวาหรือประเภท pointer ที่ไม่รู้จัก และจัดการค่าที่บันทึกผิดรูปแบบ', () => {
  const policy = createPolicy('old-invalid-setting');
  const session = createSession(policy);
  assert.equal(policy.mode, 'auto');
  assert.equal(session.begin(pointer(1, 'pen', 'pointerdown', { button: 2 })), false);
  assert.equal(session.begin(pointer(2, '')), false);
  policy.setMode('invalid');
  assert.equal(policy.mode, 'auto');
});

test('แรงกดของปากกาเปลี่ยนความหนา แรงกดที่หายไปตอนยกปากกาใช้ค่าล่าสุด', () => {
  assert.equal(readPressure({ pressure: NaN }), .5);
  assert.equal(readPressure({ pressure: -1 }), 0);
  assert.equal(readPressure({ pressure: 2 }), 1);
  assert.equal(readPressure({ pressure: 0, type: 'pointerdown' }), 0);
  assert.equal(readPressure({ pressure: 0, type: 'pointerup' }, .67), .67);
  assert.equal(strokeWidth(5), 5);
  assert.ok(strokeWidth(5, .1) > 0);
  assert.ok(strokeWidth(5, .8) > strokeWidth(5, .1));
});

test('ใช้ตัวอย่าง coalesced ตามลำดับและสำรองด้วยเหตุการณ์เดิมเมื่อเบราว์เซอร์ไม่ส่งตัวอย่าง', () => {
  const events = [{ pressure: .2 }, { pressure: .8 }];
  assert.equal(samples({ getCoalescedEvents: () => events }), events);
  const empty = { getCoalescedEvents: () => [] };
  const unsupported = { pressure: .5 };
  assert.equal(samples(empty)[0], empty);
  assert.equal(samples(unsupported)[0], unsupported);
});
