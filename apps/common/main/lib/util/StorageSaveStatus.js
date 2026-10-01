/*
 * Copyright (C) 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
define([], function () {
    'use strict';

    // States:
    //   clean       — nothing has changed in this editor since the document was
    //                 opened, so the copy in storage is the copy on screen.
    //                 Renders no caption; a freshly opened document is not a
    //                 warning.
    //   unconfirmed — the document has changed (here or by a collaborator) and
    //                 no storage receipt covers those changes yet.
    //   pending     — a storage save that covers the current work has started.
    //   confirmed   — storage acknowledged a save of the current work.
    //   failed      — storage refused or timed out; stays until a matching
    //                 receipt recovers it.
    function StorageSaveStatus(api, changed, labels) {
        this.state = 'clean';
        this.time = -1;
        this.type = null;
        this.api = api;
        this.warnings = {};
        this.generation = 0;
        this.attemptGeneration = -1;
        this.labels = labels;
        this.changed = changed;
        var me = this;
        api.asc_registerCallback('asc_onStorageSave', function (data) { me.onResult(data); });
        api.asc_registerCallback('asc_onDocumentModifiedChanged', function () {
            if (api.isDocumentModified()) me.invalidate(true);
        });
        api.asc_registerCallback('asc_onCoAuthoringDisconnect', function () { me.invalidate(); });
        api.asc_registerCallback('asc_onCollaborativeChanges', function () { me.invalidate(); });
        api.asc_registerCallback('asc_onStartAction', function (type, id) {
            if (id === Asc.c_oAscAsyncAction.Open || id === Asc.c_oAscAsyncAction.RefreshFile) {
                me.reset();
            } else if (id === Asc.c_oAscAsyncAction.Disconnect || id === Asc.c_oAscAsyncAction.Save) {
                me.invalidate();
            }
        });
        api.asc_registerCallback('asc_onError', function (id, level, data) {
            if (id === Asc.c_oAscError.ID.ForceSaveButton || id === Asc.c_oAscError.ID.ForceSaveTimeout ||
                    id === Asc.c_oAscError.ID.ConvertationSaveError) {
                var stamp = data && data.storageSave;
                if (stamp && (stamp.documentKey !== me.documentKey() || stamp.time < me.time)) return;
                if (stamp && me.state === 'confirmed' && stamp.time === me.time && stamp.type === me.type) return;
                // An uncorrelated error cannot be cleared by an earlier in-flight receipt.
                if (!stamp || stamp.time !== me.time || stamp.type !== me.type) me.attemptGeneration = -1;
                me.state = 'failed';
                me.changed();
            }
        });
    }

    // A freshly opened document owes storage nothing until this editor changes it.
    StorageSaveStatus.prototype.reset = function () {
        ++this.generation;
        this.state = 'clean';
        this.time = -1;
        this.type = null;
        this.attemptGeneration = -1;
        this.changed();
    };

    // Any in-flight receipt no longer covers the current work. A local edit
    // always dirties the document; a remote change or a disconnect only
    // withdraws a receipt that was already claimed (confirmed/pending) — a clean
    // editor that has typed nothing has nothing of its own at risk.
    StorageSaveStatus.prototype.invalidate = function (localEdit) {
        ++this.generation;
        if (this.state !== 'failed' && (localEdit || this.state !== 'clean')) this.state = 'unconfirmed';
        this.changed();
    };

    StorageSaveStatus.prototype.documentKey = function () {
        return this.api.asc_getStorageSaveDocumentKey ? this.api.asc_getStorageSaveDocumentKey() : null;
    };

    StorageSaveStatus.prototype.onResult = function (data) {
        var types = AscCommon.c_oAscForceSaveTypes;
        if (!data || (data.type !== types.Button && data.type !== types.Timeout) ||
                typeof data.time !== 'number' || !isFinite(data.time) || data.time < 0 ||
                data.time < this.time ||
                (data.documentKey !== undefined && data.documentKey !== this.documentKey()) ||
                (data.time === this.time && this.type !== null && data.type !== this.type)) return;
        if (data.start === true) {
            // A repeated start cannot reclassify edits made after this snapshot began.
            if (data.time > this.time) {
                this.time = data.time;
                this.type = data.type;
                this.attemptGeneration = this.generation;
            }
            if (this.state !== 'failed') this.state = 'pending';
        } else if (data.success === false) {
            if (data.time > this.time) this.attemptGeneration = -1;
            this.time = data.time;
            this.type = data.type;
            this.state = 'failed';
        } else if (data.success === true) {
            // No observed start, or newer edits/disconnect: storage of current work is unconfirmed.
            if (data.time !== this.time || this.attemptGeneration !== this.generation) return;
            this.state = 'confirmed';
            for (var id in this.warnings) {
                var warning = this.warnings[id];
                if (warning.time === data.time && warning.type === data.type &&
                        warning.documentKey === data.documentKey) {
                    delete this.warnings[id];
                    if (warning.dialog.isVisible()) warning.dialog.close();
                }
            }
        } else {
            return;
        }
        this.changed();
    };

    // Own only correlated force-save warnings. Other errors keep their normal lifecycle.
    StorageSaveStatus.prototype.showWarning = function (id, data, config) {
        var errors = Asc.c_oAscError.ID, types = AscCommon.c_oAscForceSaveTypes;
        var expected = id === errors.ForceSaveButton ? types.Button :
            (id === errors.ForceSaveTimeout ? types.Timeout : null);
        var stamp = data && data.storageSave;
        if (expected === null || config.iconCls !== 'warn' || !stamp || stamp.type !== expected ||
                typeof stamp.time !== 'number' || !isFinite(stamp.time) || stamp.time < 0 ||
                typeof stamp.documentKey !== 'string') return false;
        if (stamp.documentKey !== this.documentKey() || stamp.time < this.time) return true;
        if (stamp.time !== this.time || stamp.type !== this.type) return false;
        if (this.state === 'confirmed') return true; // Includes deferred Sheets alerts.
        var warning = this.warnings[id];
        var dialog = warning && warning.dialog.isVisible() ? warning.dialog : Common.UI.alert(config);
        dialog.$window.attr('data-value', id);
        this.warnings[id] = { dialog: dialog, time: stamp.time, type: stamp.type, documentKey: stamp.documentKey };
        return true;
    };

    StorageSaveStatus.prototype.caption = function (other) {
        if (this.state === 'failed') return this.labels.failed;
        return other || this.labels[this.state] || '';
    };

    Common.Utils.StorageSaveStatus = StorageSaveStatus;
    return StorageSaveStatus;
});
