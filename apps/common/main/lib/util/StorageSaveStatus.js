/*
 * Copyright (C) 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
define([], function () {
    'use strict';

    function StorageSaveStatus(api, changed, labels) {
        this.state = 'unconfirmed';
        this.time = -1;
        this.generation = 0;
        this.attemptGeneration = -1;
        this.labels = labels;
        this.changed = changed;
        var me = this;
        api.asc_registerCallback('asc_onStorageSave', function (data) { me.onResult(data); });
        api.asc_registerCallback('asc_onDocumentModifiedChanged', function () {
            if (api.isDocumentModified()) me.invalidate();
        });
        api.asc_registerCallback('asc_onCoAuthoringDisconnect', function () { me.invalidate(); });
        api.asc_registerCallback('asc_onCollaborativeChanges', function () { me.invalidate(); });
        api.asc_registerCallback('asc_onStartAction', function (type, id) {
            if (id === Asc.c_oAscAsyncAction.Open || id === Asc.c_oAscAsyncAction.RefreshFile) {
                me.state = 'unconfirmed';
                me.time = -1;
                me.attemptGeneration = -1;
                me.invalidate();
            } else if (id === Asc.c_oAscAsyncAction.Disconnect || id === Asc.c_oAscAsyncAction.Save) {
                me.invalidate();
            }
        });
        api.asc_registerCallback('asc_onError', function (id) {
            if (id === Asc.c_oAscError.ID.ForceSaveButton || id === Asc.c_oAscError.ID.ForceSaveTimeout ||
                    id === Asc.c_oAscError.ID.ConvertationSaveError) {
                me.state = 'failed';
                me.changed();
            }
        });
    }

    StorageSaveStatus.prototype.invalidate = function () {
        ++this.generation;
        if (this.state !== 'failed') this.state = 'unconfirmed';
        this.changed();
    };

    StorageSaveStatus.prototype.onResult = function (data) {
        var types = AscCommon.c_oAscForceSaveTypes;
        if (!data || (data.type !== types.Button && data.type !== types.Timeout) ||
                typeof data.time !== 'number' || !isFinite(data.time) || data.time < 0 ||
                data.time < this.time) return;
        if (data.start === true) {
            // A repeated start cannot reclassify edits made after this snapshot began.
            if (data.time > this.time) {
                this.time = data.time;
                this.attemptGeneration = this.generation;
            }
            if (this.state !== 'failed') this.state = 'pending';
        } else if (data.success === false) {
            if (data.time > this.time) this.attemptGeneration = -1;
            this.time = data.time;
            this.state = 'failed';
        } else if (data.success === true) {
            // No observed start, or newer edits/disconnect: storage of current work is unconfirmed.
            if (data.time !== this.time || this.attemptGeneration !== this.generation) return;
            this.state = 'confirmed';
        } else {
            return;
        }
        this.changed();
    };

    StorageSaveStatus.prototype.caption = function (other) {
        if (this.state === 'failed') return this.labels.failed;
        return other || this.labels[this.state];
    };

    Common.Utils.StorageSaveStatus = StorageSaveStatus;
    return StorageSaveStatus;
});
