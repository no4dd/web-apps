/* Copyright (C) 2026 Euro-Office contributors; SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../../..');
const sdk = path.resolve(root, '../sdkjs');
const types = { Button: 1, Timeout: 2, Command: 0, Form: 3, Internal: 4 };
const errors = { ForceSaveButton: -331, ForceSaveTimeout: -332, ConvertationSaveError: -83 };
const actions = { Save: 1, ForceSaveButton: 2, Disconnect: 3, ApplyChanges: 4, Open: 5 };
const labels = {
    unconfirmed: 'Storage save not yet confirmed', pending: 'Saving document to storage…',
    failed: 'Storage save failed. Keep this document open.', confirmed: 'Last document snapshot saved'
};
function context() {
    const ctx = {
        Common: { Utils: {} }, AscCommon: { c_oAscForceSaveTypes: types },
        Asc: { c_oAscError: { ID: errors }, c_oAscAsyncAction: actions,
            c_oAscAsyncActionType: { Information: 1, BlockInteraction: 2 } },
        define: (deps, factory) => factory(),
        _: { extend: Object.assign, bind: (fn, owner) => fn.bind(owner) },
        Backbone: { Controller: { extend: value => value } },
        DE: { Controllers: {} }, PE: { Controllers: {} }, SSE: { Controllers: {} }, PDFE: { Controllers: {} }
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'apps/common/main/lib/util/StorageSaveStatus.js'), 'utf8'), ctx);
    return ctx;
}
function api() {
    const callbacks = new Map();
    return {
        modified: false,
        asc_registerCallback(name, fn) {
            if (!callbacks.has(name)) callbacks.set(name, []);
            callbacks.get(name).push(fn);
        },
        isDocumentModified() { return this.modified; },
        asc_isDocumentModified() { return this.modified; },
        emit(name, ...args) { for (const fn of callbacks.get(name) || []) fn(...args); }
    };
}
function fixture() {
    const ctx = context(), client = api();
    const model = new ctx.Common.Utils.StorageSaveStatus(client, () => {}, labels);
    const result = (time, value, type = types.Timeout) => client.emit('asc_onStorageSave', { type, time, ...value });
    return { ctx, client, model, result };
}
test('action end, NotModified, missing and malformed results never confirm storage', () => {
    const f = fixture();
    f.client.emit('asc_onEndAction', 1, actions.Save);
    for (const value of [undefined, {}, { time: 1, success: 'true' }, { time: NaN, success: true },
        { time: Infinity, success: true }, { time: -1, success: true }, { time: '1', success: true },
        { time: 1, refuse: true }, { time: 1, success: true }]) {
        f.client.emit('asc_onStorageSave', value && { type: types.Timeout, ...value });
        assert.equal(f.model.caption(''), labels.unconfirmed);
    }
});
test('failure survives synchronization and action end; matching positive retry recovers', () => {
    const f = fixture();
    f.result(100, { start: true });
    f.result(100, { success: false });
    f.client.emit('asc_onDocumentModifiedChanged'); // local dirty flag is now false
    f.client.emit('asc_onEndAction', 1, actions.ForceSaveButton);
    assert.equal(f.model.caption('All changes saved'), labels.failed);
    f.result(100, { start: true });
    assert.equal(f.model.caption(''), labels.failed);
    f.result(100, { success: true });
    assert.equal(f.model.caption(''), labels.confirmed);
});
test('older acknowledgment cannot clear a newer pending save or newer failure', () => {
    const f = fixture();
    f.result(100, { start: true });
    f.result(101, { start: true });
    f.result(100, { success: true });
    assert.equal(f.model.caption(''), labels.pending);
    f.result(101, { success: false });
    f.result(100, { success: true });
    assert.equal(f.model.caption(''), labels.failed);
    f.result(101, { success: true });
    assert.equal(f.model.caption(''), labels.confirmed);
});
test('new local/remote edits and disconnect invalidate earlier in-flight acknowledgments', () => {
    for (const event of ['asc_onDocumentModifiedChanged', 'asc_onCollaborativeChanges',
        'asc_onCoAuthoringDisconnect', 'asc_onStartAction']) {
        const f = fixture();
        f.result(100, { start: true });
        f.client.modified = true;
        f.client.emit(event, 1, actions.Disconnect);
        f.result(100, { start: true }); // duplicate start must not erase intervening work
        f.result(100, { success: true });
        assert.notEqual(f.model.caption(''), labels.confirmed, event);
        f.result(101, { start: true });
        f.result(101, { success: true });
        assert.equal(f.model.caption(''), labels.confirmed, event);
    }
});
test('timeout stays failed until a matching positive result, not another action ending', () => {
    const f = fixture();
    f.result(100, { start: true });
    f.client.emit('asc_onError', errors.ForceSaveTimeout);
    f.client.emit('asc_onEndAction', 1, actions.Save);
    assert.equal(f.model.caption(''), labels.failed);
    f.result(100, { success: true });
    assert.equal(f.model.caption(''), labels.confirmed);
});
test('opening another document resets receipt state and cannot inherit an old success', () => {
    const f = fixture();
    f.result(100, { start: true });
    f.result(100, { success: true });
    f.client.emit('asc_onStartAction', 2, actions.Open);
    f.result(100, { success: true });
    assert.equal(f.model.caption(''), labels.unconfirmed);
    f.result(101, { start: true });
    f.result(101, { success: true });
    assert.equal(f.model.caption(''), labels.confirmed);
});
test('document state is isolated; both collaborators can consume room timeout acknowledgments', () => {
    const owner = fixture(), editor = fixture(), otherDocument = fixture();
    for (const f of [owner, editor]) {
        f.result(100, { start: true });
        f.result(100, { success: false });
        assert.equal(f.model.caption(''), labels.failed);
        f.result(100, { success: true });
        assert.equal(f.model.caption(''), labels.confirmed);
    }
    assert.equal(otherDocument.model.caption(''), labels.unconfirmed);
});
for (const [editor, ns] of [['documenteditor', 'DE'], ['spreadsheeteditor', 'SSE'],
    ['presentationeditor', 'PE'], ['pdfeditor', 'PDFE']]) {
    test(`${editor}: actual status controller does not render a false saved caption`, () => {
        const ctx = context(), client = api();
        const dir = path.join(root, `apps/${editor}/main/app`);
        vm.runInContext(fs.readFileSync(path.join(dir, 'controller/Statusbar.js'), 'utf8'), ctx);
        const controller = Object.create(ctx[ns].Controllers.Statusbar);
        let visible = '';
        controller.statusbar = { showStatusMessage: text => { visible = text; },
            clearStatusMessage: () => { visible = ''; } };
        controller.setStorageSaveApi(client, { isEdit: true, isOffline: false });
        assert.equal(visible, labels.unconfirmed);
        client.emit('asc_onStorageSave', { type: types.Timeout, time: 100, start: true });
        client.emit('asc_onStorageSave', { type: types.Timeout, time: 100, success: false });
        controller.setStatusCaption('', false, 3000); // actual Save/ForceSaveButton completion path
        assert.equal(visible, labels.failed);
        client.emit('asc_onStorageSave', { type: types.Timeout, time: 100, success: true });
        assert.equal(visible, labels.confirmed);
        client.modified = true;
        client.emit('asc_onDocumentModifiedChanged');
        assert.equal(visible, labels.unconfirmed);
        const main = fs.readFileSync(path.join(dir, 'controller/Main.js'), 'utf8');
        const endSource = main.match(/onLongActionEnd: (function[\s\S]*?\n            \}),/);
        assert.ok(endSource);
        ctx.appHeader = null;
        const delayed = [];
        ctx.setTimeout = fn => { delayed.push(fn); return 1; };
        const end = vm.runInContext('(' + endSource[1] + ')', ctx);
        const mainController = {
            stackLongActions: { pop() {}, get() {} }, api: client,
            appOptions: { isEdit: true, isOffline: false }, _state: { fastCoauth: true, usersCount: 2 },
            updateWindowTitle() {}, synchronizeChanges() {},
            getApplication: () => ({ getController: name => name === 'Statusbar' ? controller : {
                isPreviewChangesMode: () => false, synchronizeChanges() {}
            } })
        };
        client.emit('asc_onStorageSave', { type: types.Timeout, time: 101, start: true });
        end.call(mainController, 1, actions.Save);
        client.emit('asc_onStorageSave', { type: types.Timeout, time: 101, success: false });
        for (const fn of delayed) fn();
        assert.equal(visible, labels.failed, 'delayed legacy action completion cannot overwrite an error');
        client.emit('asc_onStorageSave', { type: types.Timeout, time: 101, success: true });
        assert.equal(visible, labels.confirmed);
        assert.ok(main.includes("setStorageSaveApi(this.api, this.appOptions)"));
        assert.ok(!main.includes('setStatusCaption(me.textChangesSaved'));
        const template = fs.readFileSync(path.join(dir, 'template/StatusBar.template'), 'utf8');
        assert.match(template, /role="status" aria-live="polite" aria-atomic="true"/);
        const offline = Object.create(ctx[ns].Controllers.Statusbar);
        offline.setStorageSaveApi(client, { isEdit: true, isOffline: true });
        assert.equal(offline.storageSaveStatus, undefined);
        const viewer = Object.create(ctx[ns].Controllers.Statusbar);
        viewer.setStorageSaveApi(client, { isEdit: false });
        assert.equal(viewer.storageSaveStatus, undefined);
    });
}
test('actual SDK wire handler forwards storage result independently of local button matching', () => {
    const ctx = context();
    Object.assign(ctx.AscCommon, { ConnectionState: {}, c_oEditorId: {}, c_oCloseCode: {},
        c_oAscServerCommandErrors: { NoError: 0, NotModified: 4 } });
    ctx.window = ctx;
    vm.runInContext(fs.readFileSync(path.join(sdk, 'common/docscoapi.js'), 'utf8'), ctx);
    const coApi = new ctx.AscCommon.CDocsCoApi(), raw = coApi._CoAuthoringApi;
    const storage = [], legacy = [];
    coApi.onStorageSave = value => storage.push(value);
    coApi.onForceSave = value => legacy.push(value);
    raw.isRightURL = () => true;
    raw.init = () => {}; // retain the real wrapper initialization without opening a socket
    coApi.init();
    raw._onForceSaveStart({ code: 0, time: 100 });
    raw._onForceSave({ type: types.Button, time: 101, success: false });
    assert.equal(storage[0].time, 100);
    assert.equal(storage[0].start, true);
    assert.equal(storage[1].time, 101);
    assert.equal(storage[1].success, false);
    assert.equal(legacy.length, 1); // unrelated local button completion correctly still filtered
    raw._onForceSaveStart({ code: 4 });
    assert.equal(storage.length, 2); // NotModified is not a durable-storage receipt
    const source = fs.readFileSync(path.join(sdk, 'common/apiBase.js'), 'utf8');
    const bridge = source.match(/this\.CoAuthoringApi\.onStorageSave = (function\(data\) \{[\s\S]*?\n        \});/);
    assert.ok(bridge);
    const received = [];
    ctx.t = { sendEvent: (...args) => received.push(args) };
    const call = vm.runInContext('(' + bridge[1] + ')', ctx);
    const payload = { type: types.Timeout, time: 102, success: true };
    call(payload);
    assert.equal(received[0][0], 'asc_onStorageSave');
    assert.equal(received[0][1], payload);
});
