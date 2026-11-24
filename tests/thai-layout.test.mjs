import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script id="thai-layout">([\s\S]+?)<\/script>/)?.[1];
assert.ok(script, 'ไม่พบสคริปต์จัดวางภาษาไทยใน index.html');

function loadLayout(useSegmenter = true) {
  const context = createContext(useSegmenter ? {} : { Intl: {} });
  runInContext(script, context, { filename: 'index.html#thai-layout' });
  return context.ThaiLayout;
}

const layout = loadLayout();
const [cluster] = layout.clusters('เกี๊ยะ');
const plain = value => JSON.parse(JSON.stringify(value));
const texts = line => Array.from(line, item => item.text).join('');
const linesOf = lines => Array.from(lines, texts);
const measure = () => 1;

test('สระหน้าทั้งห้าอยู่ในกลุ่มเดียวกับพยัญชนะที่ตามมา', () => {
  for (const letter of 'เแโใไ') {
    const part = layout.clusters(letter + 'ก')[0];
    assert.equal(part.front, letter);
    assert.equal(part.base, 'ก');
    assert.equal(part.text, letter + 'ก');
  }
});

test('สระหน้าที่ยืนลำพังยังอยู่ และตัวตามหลังแบบไม่ใช่เครื่องหมายแยกได้', () => {
  assert.deepEqual(Array.from(layout.clusters('เ กา'), item => item.text), ['เ', ' ', 'ก', 'า']);
  assert.equal(layout.clusters('Aเ9').map(item => item.text).join(''), 'Aเ9');
});

test('เกี๊ยะ จัด เ, ก, ี และ ๊ ในกลุ่มเดียวตามลำดับเดิม', () => {
  assert.deepEqual(plain(cluster), {
    front: 'เ', base: 'ก', upper: ['ี'], lower: [], tone: ['๊'], after: '', text: 'เกี๊'
  });
});

test('สระบน สระล่าง วรรณยุกต์ และเครื่องหมาย เข้ากลุ่มตามโซน', () => {
  for (const [zone, letters] of Object.entries({ upper: 'ัิีึื็ํ', lower: 'ฺุู', tone: '่้๊๋์๎' })) {
    for (const letter of letters) {
      assert.equal(layout.zone(letter), zone);
      assert.deepEqual(Array.from(layout.clusters('ก' + letter)[0][zone]), [letter]);
    }
  }
  assert.equal(layout.zone('า'), 'base');
  const mark = layout.clusters('กุ้')[0];
  assert.deepEqual(Array.from(mark.lower), ['ุ']);
  assert.deepEqual(Array.from(mark.tone), ['้']);
});

test('สระอำแยกส่วนเป็นนิคหิตและสระอา รวมวรรณยุกต์เดิม', () => {
  const [part] = layout.clusters('น้ำ');
  assert.equal(part.base, 'น');
  assert.equal(part.after, 'า');
  assert.equal(part.text, 'น้ำ');
  assert.deepEqual(Array.from(part.upper), ['ํ']);
  assert.deepEqual(Array.from(part.tone), ['้']);
  const [nikhahit, tail] = layout.markLayout(part, 22, 30);
  assert.equal(nikhahit.letter, 'ํ');
  assert.equal(tail.letter, '้');
  assert.ok(tail.y < nikhahit.y);
});

test('หลบส่วนสูงของ ป ฟ ฝ ฬ ทั้งสระบนและวรรณยุกต์', () => {
  const reference = layout.markLayout(layout.clusters('กิ่')[0], 20, 25);
  for (const tall of 'ปฟฝฬ') {
    const marks = layout.markLayout(layout.clusters(tall + 'ิ่')[0], 20, 25);
    assert.equal(marks.length, 2);
    for (const [index, mark] of marks.entries()) {
      assert.ok(mark.x > 0 && mark.x < reference[index].x);
      assert.ok(mark.y < reference[index].y);
      assert.ok(mark.em > 0);
    }
  }
});

test('สระล่างอยู่ต่ำกว่าเส้นฐาน และเลื่อนหลบส่วนล่างของ ญ ฐ', () => {
  const [regular] = layout.markLayout(layout.clusters('กุ')[0], 20, 25);
  for (const letter of 'ญฐ') {
    const [mark] = layout.markLayout(layout.clusters(letter + 'ุ')[0], 20, 25);
    assert.ok(mark.y > 0);
    assert.ok(mark.x > regular.x);
  }
});

test('ตัดระหว่างคำไทยเมื่อความกว้างพอดีคำ และคงเครื่องหมายกับพยัญชนะ', () => {
  assert.deepEqual(linesOf(layout.wrap('สวัสดีครับ', 4, measure)), ['สวัสดี', 'ครับ']);
  assert.deepEqual(linesOf(layout.wrap('เกี๊ยะ', 1, measure)), ['เกี๊', 'ย', 'ะ']);
});

test('เก็บช่องไฟภายในบรรทัดและบรรทัดว่างที่ผู้ใช้ป้อน', () => {
  const source = '  ข้อ 1\r\n\r\n  2 × 3 = 6  \n';
  assert.deepEqual(linesOf(layout.wrap(source, 40, measure)), ['ข้อ 1', '', '2 × 3 = 6', '']);
  assert.deepEqual(linesOf(layout.wrap('ก  ข', 4, measure)), ['ก  ข']);
  assert.deepEqual(linesOf(layout.wrap('ก  ข', 3, measure)), ['ก', 'ข']);
});

test('ข้อความผสมไทย อังกฤษ เลขไทย ตัวเลขและสัญลักษณ์คืนตัวอักษรครบ', () => {
  const source = 'เริ่มข้อ ๒: x + 4.5 = 10% (ได้ไหม?)';
  const parts = layout.clusters(source);
  assert.equal(parts.map(item => item.text).join(''), source);
  assert.ok(parts.some(item => item.base === '๒'));
  assert.ok(parts.some(item => item.base === '+'));
  const mixed = layout.clusters('e\u0301👩‍🔬');
  assert.deepEqual(Array.from(mixed, item => item.text), ['e\u0301', '👩‍🔬']);
});

test('วัดและห่อบรรทัดตามความกว้างจริงที่ผู้เรียกส่งมา', () => {
  const widths = item => item.text === 'A' ? 3 : 1;
  const lines = layout.wrap('A12 BC', 4, widths);
  assert.deepEqual(linesOf(lines), ['A1', '2 BC']);
  assert.ok(lines.every(line => line.reduce((sum, item) => sum + item.width, 0) <= 4));
});

test('ข้อความยาวในช่องแคบและโหมดไม่มี Intl.Segmenter ไม่แยกสระจากพยัญชนะ', () => {
  const fallback = loadLayout(false);
  const source = 'ฝึกรู้คำใหม่';
  assert.deepEqual(linesOf(fallback.wrap(source, 1, measure)), ['ฝึ', 'ก', 'รู้', 'คำ', 'ให', 'ม่']);
  assert.deepEqual(linesOf(fallback.wrap('ไทย ABC', 30, measure)), ['ไทย ABC']);
  assert.deepEqual(linesOf(fallback.wrap('', 30, measure)), ['']);
});
