// test/exam/aiFlags.test.js — run with:  node --test test/exam
//
// Both detectors once scored police vocabulary as evidence of ChatGPT, so the
// better the answer the more suspicious it looked. These tests pin the
// separation: honest answers stay clean, essay register still gets caught, and
// the behavioural signals keep firing at full strength.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.AIDETECT_DISABLE_ZEROGPT = 'true';
for (const k of ['SAPLING_API_KEY', 'GPTZERO_API_KEY', 'WINSTON_API_KEY', 'AIDETECT_URL', 'AIDETECT2_URL']) delete process.env[k];

const exam = require('../../server/lib/hpcExam');
const aiDetect = require('../../server/lib/aiDetect');

const HONEST = {
  plain: 'I would take cover behind my vehicle and call for immediate backup on the radio. I would draw my firearm and give clear commands to drop the weapon. If he complies I would detain him and wait for units to arrive.',
  onPhone: 'I would take cover behind my vehicle and call for immediate backup on the radio. I would give clear commands to drop the weapon. If he doesn’t comply I would act to protect myself and the public.',
  policeVocabulary: 'First I would try to de-escalate the situation by speaking calmly and keeping my distance. I would maintain professionalism at all times and call for backup. If he raises the revolver again I would respond with force proportionate to the threat.',
  markingScheme: 'My first priority would be to seek cover and assess the level of threat. I would request urgent backup over the radio and notify the control room of my location. I would give lawful commands for the suspect to drop the weapon. If it is safe to do so I would detain him, preserve the scene and request medical assistance for anyone injured.',
};

const AI = {
  connectives: 'In this scenario, it is important to note that officer safety must remain the paramount consideration. Furthermore, I would immediately seek cover and request urgent backup via the control room. Moreover, de-escalation techniques should be attempted where it is safe to do so. In conclusion, any use of force must be necessary, proportionate and reasonable in the circumstances.',
  enumerated: 'Firstly, I would prioritise my own safety and that of the public. Secondly, I would seek immediate cover and request backup. Thirdly, I would attempt verbal communication with the suspect. Lastly, force would only be applied where absolutely necessary.',
};

function typedHonestly(text) {
  return { perQuestion: { revolver: { keystrokes: text.length + 20, activeMs: 60000, pastedChars: 0 } }, totalMs: 15 * 60 * 1000 };
}
function flagsFor(text, detection) {
  return exam.computeFlags({ revolver: text }, detection || typedHonestly(text));
}

for (const [name, text] of Object.entries(HONEST)) {
  test('exam flags: an honest answer (' + name + ') is not called AI', () => {
    const ai = flagsFor(text).filter(f => f.code === 'ai_writing');
    assert.deepEqual(ai, [], 'honest answer flagged: ' + JSON.stringify(ai));
  });
}

test('exam flags: genuine essay register is still caught', () => {
  const ai = flagsFor(AI.connectives).filter(f => f.code === 'ai_writing');
  assert.equal(ai.length, 1);
  assert.equal(ai[0].severity, 'high');
});

test('exam flags: pasting is high severity', () => {
  const f = flagsFor(HONEST.plain, { perQuestion: { revolver: { pastedChars: 130, pasteCount: 1, keystrokes: 4, activeMs: 3000 } }, totalMs: 900000 });
  assert.ok(f.some(x => x.code === 'paste' && x.severity === 'high'));
});

test('exam flags: an answer with too few keystrokes is high severity', () => {
  const f = flagsFor(HONEST.plain, { perQuestion: { revolver: { keystrokes: 10, activeMs: 30000, pastedChars: 0 } }, totalMs: 900000 });
  assert.ok(f.some(x => x.code === 'autofill' && x.severity === 'high'));
});

test('exam flags: impossible typing speed is high severity', () => {
  const f = flagsFor(HONEST.plain, { perQuestion: { revolver: { keystrokes: 200, activeMs: 5000, pastedChars: 0 } }, totalMs: 900000 });
  assert.ok(f.some(x => x.code === 'superhuman_typing' && x.severity === 'high'));
});

test('exam flags: leaving the exam repeatedly, devtools and a fast finish all still fire', () => {
  const base = typedHonestly(HONEST.plain);
  assert.ok(flagsFor(HONEST.plain, { ...base, blurCount: 4, blurMs: 120000 }).some(f => f.code === 'tab_switch' && f.severity === 'high'));
  assert.ok(flagsFor(HONEST.plain, { ...base, devtoolsOpened: true }).some(f => f.code === 'devtools'));
  assert.ok(flagsFor(HONEST.plain, { perQuestion: base.perQuestion, totalMs: 40000 }).some(f => f.code === 'too_fast'));
});

test('exam flags: a phone keyboard alone never produces a flag', () => {
  const curly = 'I wouldn’t get closer while he’s pointing it at me — I’d stay behind the car and radio for backup.';
  assert.deepEqual(flagsFor(curly).filter(f => f.code === 'ai_writing'), []);
});

test('exam scoring: the pass mark is the stated percentage of the total', () => {
  assert.equal(exam.passMark(), Math.ceil(exam.totalPoints() * exam.PASS_PERCENT / 100));
  assert.ok(exam.totalPoints() > 0);
});

test('exam paper: every question is published with its points and type', () => {
  const paper = exam.publicPaper();
  assert.equal(paper.total, exam.totalPoints());
  assert.equal(paper.questions.length, exam.QUESTIONS.length);
  for (const q of paper.questions) {
    assert.ok(q.id && q.type && typeof q.points === 'number', 'incomplete question: ' + JSON.stringify(q));
    assert.equal(q.answer, undefined, 'the paper must not carry an answer key');
  }
});

for (const [name, text] of Object.entries(HONEST)) {
  test('scanner: an honest answer (' + name + ') scores low', async () => {
    const r = await aiDetect.detectText(text);
    assert.ok(r.overall <= 25, name + ' scored ' + r.overall);
  });
}

for (const [name, text] of Object.entries(AI)) {
  test('scanner: AI prose (' + name + ') scores high', async () => {
    const r = await aiDetect.detectText(text);
    assert.ok(r.overall >= 55, name + ' scored ' + r.overall);
  });
}

test('scanner: the honest ceiling sits well below the AI floor', async () => {
  const human = await Promise.all(Object.values(HONEST).map(t => aiDetect.detectText(t)));
  const robot = await Promise.all(Object.values(AI).map(t => aiDetect.detectText(t)));
  const worstHuman = Math.max(...human.map(r => r.overall));
  const bestRobot = Math.min(...robot.map(r => r.overall));
  assert.ok(bestRobot - worstHuman >= 30, 'separation too narrow: human ' + worstHuman + ' vs AI ' + bestRobot);
});
