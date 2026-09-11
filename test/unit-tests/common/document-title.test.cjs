'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function gateway() {
  const events = [];
  let receive;
  const Common = {};
  const context = {
    Common, JSON,
    $: () => ({ trigger: (type, data) => events.push({ type, data }) }),
    window: {
      Common, JSON, parentOrigin: 'https://app.example.test',
      location: { origin: 'https://office.example.test' },
      addEventListener: (type, callback) => { receive = callback; },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../apps/common/Gateway.js'), 'utf8'), context);
  return { events, send: (origin, title) => receive({ origin, data: JSON.stringify({ command: 'setDocumentTitle', data: { title } }) }) };
}

test('authorised host metadata updates the title event without opening or saving a document', () => {
  const f = gateway();
  f.send('https://app.example.test', 'Renamed plan.docx');
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, 'setdocumenttitle');
  assert.equal(f.events[0].data.title, 'Renamed plan.docx');
});

test('untrusted origins cannot inject metadata and malformed titles are ignored', () => {
  const f = gateway();
  f.send('https://attacker.example.test', 'Spoof.docx');
  for (const title of [null, {}, '', 'x'.repeat(1025)]) f.send('https://app.example.test', title);
  assert.equal(f.events.length, 0);
});
