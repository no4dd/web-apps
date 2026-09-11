/*
 * (c) Copyright Ascensio System SIA 2010-2024
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect
 * that Ascensio System SIA expressly excludes the warranty of non-infringement
 * of any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */
/**
 *  ExternalPanels.js
 *
 *  Host-owned side panels, declared by the integrating application through
 *  `editorConfig.customization.sidePanels`.
 *
 *  The editor owns nothing but the control. A click is reported through
 *  Common.Gateway.requestSidePanel({id, active}); the host draws whatever
 *  panel it likes, in its own page, on its own origin. The host pushes state
 *  back with setSidePanelState({id, active}).
 *
 *  Two placements share this registry: 'header' (a captioned button beside
 *  Share) and 'rail' (an icon toggle in the right-hand menu). This file holds
 *  everything neither host should have to repeat.
 *
 */
define([
    'underscore',
    'common/main/lib/component/BaseView'
], function (_) {
    'use strict';

    Common.UI.ExternalPanels = new(function () {
        var _panels = [],
            _listening = false,
            _supportsMask;

        /**
         *  Icons arrive as URLs from the integrator's configuration and are
         *  rendered into the editor's own document. Only http(s) and data:
         *  images are accepted, so a hostile config cannot reach javascript:
         *  through the src or url() it lands in.
         */
        var _readIcon = function (url) {
            if (typeof url !== 'string') return undefined;
            var trimmed = url.trim();
            return /^(https?:\/\/|data:image\/)/i.test(trimmed) ? trimmed : undefined;
        };

        var _listen = function () {
            if (_listening) return;
            _listening = true;

            Common.Gateway.on('setsidepanelstate', function (data) {
                var panel = data && _.findWhere(_panels, {id: data.id});
                panel && panel.button.toggle(!!data.active, true);
            });

            // A control can become unreachable without being removed — the
            // right-hand rail can be switched off in View. Re-announce so the
            // host knows whether its own fallback control is still needed.
            Common.NotificationCenter.on('layout:changed', function () {
                _panels.forEach(function (panel) { _announce(panel); });
            });
        };

        var _announce = function (panel, force) {
            var visible = !!panel.button.cmpEl && panel.button.cmpEl.is(':visible');
            if (!force && visible === panel.announcedVisible) return;
            panel.announcedVisible = visible;
            Common.Gateway.requestSidePanel({
                id: panel.id,
                active: !!panel.button.pressed,
                installed: true,
                visible: visible
            });
        };

        return {
            /**
             *  Validated panel configs for one placement. A rail control is
             *  icon-only so it must have an icon; a header button carries its
             *  caption, so there an icon is optional.
             */
            read: function (list, placement) {
                if (!_.isArray(list)) return [];
                var seen = {};
                return list.reduce(function (result, config) {
                    if (!config || typeof config.id !== 'string' || !config.id.length) return result;
                    if (seen[config.id]) return result;
                    if ((config.placement || 'rail') !== placement) return result;

                    var icon = _readIcon(config.icon),
                        title = typeof config.title === 'string' ? config.title.trim() : '';
                    if (placement === 'rail' && !icon) return result;
                    if (placement === 'header' && !title) return result;

                    seen[config.id] = true;
                    result.push({
                        id: config.id,
                        title: title || config.id,
                        icon: icon,
                        active: !!config.active
                    });
                    return result;
                }, []);
            },

            /**
             *  Icons are painted as a mask so the editor's own theme colours
             *  them, in every theme and every state, exactly as the sprite
             *  icons beside them are coloured. An <img> would carry one fixed
             *  colour into all of them; it stays the fallback where masking is
             *  unavailable, and is what dropdown menus draw.
             */
            supportsMask: function () {
                if (undefined === _supportsMask) {
                    _supportsMask = !!(window.CSS && CSS.supports &&
                        (CSS.supports('mask-image', 'url("data:,")') ||
                         CSS.supports('-webkit-mask-image', 'url("data:,")')));
                }
                return _supportsMask;
            },

            applyMask: function (button, selector, icon) {
                // url() is inert against script injection, and the source was
                // validated to http(s)/data: when the config was read.
                var url = 'url("' + icon.replace(/["\\]/g, encodeURIComponent) + '")';
                button.cmpEl.find(selector).css({
                    '-webkit-mask-image': url,
                    'mask-image': url
                });
                // Dropdown menus build their own items and have no mask; give
                // them the plain image to draw instead.
                button.options.iconImg = icon;
            },

            /**
             *  Registers a rendered control: reports its clicks, answers the
             *  host's setSidePanelState, and announces that it exists.
             */
            attach: function (panel, button) {
                _listen();

                var entry = {id: panel.id, button: button};
                _panels.push(entry);

                button.on('click', function () {
                    Common.Gateway.requestSidePanel({id: entry.id, active: !!button.pressed});
                });

                panel.active && button.toggle(true, true);
                _announce(entry, true);
                return entry;
            },

            announce: function (entry) {
                _announce(entry);
            }
        };
    })();

    return Common.UI.ExternalPanels;
});
