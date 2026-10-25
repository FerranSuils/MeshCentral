/*
 * MeshByte dashboard (modern UI, page #p7). Loaded from the <head> on every
 * page by generateCustomJSTags; everything is a no-op unless the modern UI
 * globals (go, nodes, meshes) exist. Data comes from the live session.
 */
(function () {
    'use strict';
    var VIEW = 7;
    var STR = {
        en: {
            title: 'Dashboard', sub: 'Live overview of your mesh', online: 'Devices online', of: 'of', upNow: 'Agents connected right now',
            up: '% up', noData: 'No data', groups: 'Device groups', managed: 'Managed groups', createFirst: 'Create your first device group',
            active: 'Active', empty: 'Empty', sessions: 'Remote sessions', open: 'open', sessionsSub: 'Desktop, terminal and file sessions',
            inProgress: 'In progress', idle: 'Idle', offline: 'Offline devices', limitedNoAgent: 'reachable without agent', noContact: 'No agent contact',
            review: 'Review', allGood: 'All good', topology: 'Topology map', server: 'Server', agent: 'Agent', limited: 'Limited',
            alerts: 'Alerts & activity', latest: 'latest', noAlerts: 'No recent alerts. Everything is quiet.', health: 'Device health',
            devices: 'devices', addDevice: 'Add a device to see your topology.', recent: 'Recent devices', viewAll: 'View all devices →',
            device: 'Device', group: 'Group', status: 'Status', system: 'System', ip: 'IP', noDevices: 'No devices yet.',
            statusOn: 'Online', statusLimited: 'Limited', statusOff: 'Offline', footer: 'online', footerLimited: 'limited', footerOff: 'offline'
        },
        es: {
            title: 'Panel', sub: 'Resumen en vivo de tu malla', online: 'Dispositivos en línea', of: 'de', upNow: 'Agentes conectados ahora',
            up: '% activos', noData: 'Sin datos', groups: 'Grupos de dispositivos', managed: 'Grupos gestionados', createFirst: 'Crea tu primer grupo de dispositivos',
            active: 'Activo', empty: 'Vacío', sessions: 'Sesiones remotas', open: 'abiertas', sessionsSub: 'Sesiones de escritorio, terminal y archivos',
            inProgress: 'En curso', idle: 'Sin uso', offline: 'Dispositivos sin conexión', limitedNoAgent: 'accesibles sin agente', noContact: 'Sin contacto del agente',
            review: 'Revisar', allGood: 'Todo correcto', topology: 'Mapa de topología', server: 'Servidor', agent: 'Agente', limited: 'Limitado',
            alerts: 'Alertas y actividad', latest: 'recientes', noAlerts: 'No hay alertas recientes. Todo tranquilo.', health: 'Estado de los dispositivos',
            devices: 'dispositivos', addDevice: 'Añade un dispositivo para ver tu topología.', recent: 'Dispositivos recientes', viewAll: 'Ver todos los dispositivos →',
            device: 'Dispositivo', group: 'Grupo', status: 'Estado', system: 'Sistema', ip: 'IP', noDevices: 'Todavía no hay dispositivos.',
            statusOn: 'En línea', statusLimited: 'Limitado', statusOff: 'Sin conexión', footer: 'en línea', footerLimited: 'limitados', footerOff: 'sin conexión'
        }
    };
    var lang = (((navigator.language || 'en') + '').slice(0, 2) === 'es') ? 'es' : 'en';
    function t(k) { return STR[lang][k] || STR.en[k] || k; }

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function q(id) { return document.getElementById(id); }
    function list() { try { return (typeof nodes !== 'undefined' && Array.isArray(nodes)) ? nodes : []; } catch (e) { return []; } }
    function groups() { try { return (typeof meshes !== 'undefined' && meshes) ? meshes : {}; } catch (e) { return {}; } }
    function evts() { try { return (typeof events !== 'undefined' && Array.isArray(events)) ? events : []; } catch (e) { return []; } }
    function state(n) { var c = n.conn | 0; if (c & 1) return 'ok'; if (c) return 'warn'; return 'off'; }
    function ago(time) {
        var s = Math.max(0, Math.round((Date.now() - new Date(time).getTime()) / 1000));
        if (isNaN(s)) return '';
        if (s < 60) return s + ' s'; if (s < 3600) return Math.round(s / 60) + ' min'; if (s < 86400) return Math.round(s / 3600) + ' h'; return Math.round(s / 86400) + ' d';
    }
    function badge(kind, text) { return '<span class="mbp-badge mbp-' + kind + '">' + esc(text) + '</span>'; }
    function barColor(kind) { return kind === 'ok' ? 'var(--mb-ok)' : kind === 'warn' ? 'var(--mb-warn)' : kind === 'bad' ? 'var(--mb-danger)' : 'var(--mb-accent)'; }
    function metric(label, value, unit, sub, kind, badgeText, pct) {
        pct = Math.max(0, Math.min(100, pct || 0));
        return '<div class="mbp-card mbp-metric"><div class="mbp-label"><span>' + esc(label) + '</span>' + badge(kind, badgeText) + '</div>' +
            '<div class="mbp-value">' + esc(value) + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div><div class="mbp-sub">' + esc(sub) + '</div>' +
            '<div class="mbp-bar"><i style="width:' + pct + '%;background:' + barColor(kind) + '"></i></div></div>';
    }
    function mapSvg(all) {
        var cx = 380, cy = 205, shown = all.slice().sort(function (a, b) { return (state(a) === 'off') - (state(b) === 'off') || String(a.name).localeCompare(String(b.name)); }).slice(0, 10);
        var links = '', slabs = '';
        var slab = function (x, y, w, name, st) {
            var h = w * 70 / 96; var op = st === 'ok' ? '' : ' opacity="0.6"';
            var label = String(name || '');
            return '<g><use href="#mbSlabP" x="' + (x - w / 2) + '" y="' + (y - h / 2) + '" width="' + w + '" height="' + h + '"' + op + '/>' +
                '<text x="' + x + '" y="' + (y + h / 2 + 14) + '" text-anchor="middle" font-size="11" fill="var(--mb-text-2)" font-family="var(--mb-font)">' + esc(label.length > 18 ? label.slice(0, 17) + '…' : label) + '</text></g>';
        };
        shown.forEach(function (n, i) {
            var a = (-90 + (360 / Math.max(shown.length, 1)) * i) * Math.PI / 180, x = cx + 290 * Math.cos(a), y = cy + 135 * Math.sin(a), st = state(n);
            var col = st === 'ok' ? 'var(--mb-ok)' : st === 'warn' ? 'var(--mb-warn)' : 'var(--mb-border-strong)';
            links += '<line x1="' + cx + '" y1="' + cy + '" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="' + col + '" stroke-width="' + (st === 'off' ? 1 : 1.6) + '"' + (st === 'off' ? ' stroke-dasharray="4 4"' : '') + '/>';
            slabs += slab(x, y, 84, n.name, st);
        });
        slabs += slab(cx, cy, 138, 'MeshByte', 'ok');
        return '<svg viewBox="0 0 760 410" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + esc(t('topology')) + '"><defs><symbol id="mbSlabP" viewBox="0 0 96 70"><path d="M48 4 92 26 48 48 4 26Z" fill="#2B3440" stroke="#3E4958"/><path d="M4 26 48 48V60L4 38Z" fill="#1A2028"/><path d="M92 26 48 48V60L92 38Z" fill="#12161C"/><path d="M26 22 48 33l22-11" stroke="#4A5668" fill="none" stroke-linecap="round"/></symbol></defs>' + links + slabs + '</svg>';
    }
    function render() {
        var host = q('p' + VIEW); if (!host) return;
        var all = list(), g = groups(), total = all.length;
        var online = all.filter(function (n) { return state(n) === 'ok'; }).length;
        var limited = all.filter(function (n) { return state(n) === 'warn'; }).length;
        var offline = total - online - limited;
        var gcount = Object.keys(g).length;
        var sessions = all.reduce(function (a, n) { return a + ((n.sessions && typeof n.sessions === 'object') ? Object.keys(n.sessions).length : 0); }, 0);
        var pct = total ? Math.round(online * 100 / total) : 0;
        var html = '<div class="mbp-head"><div><h2>' + esc(t('title')) + '</h2><p>' + esc(t('sub')) + '</p></div></div>';
        html += '<div class="mbp-grid mbp-metrics">' +
            metric(t('online'), online, t('of') + ' ' + total, t('upNow'), online === total && total ? 'ok' : (online ? 'info' : 'off'), total ? pct + t('up') : t('noData'), pct) +
            metric(t('groups'), gcount, '', gcount ? t('managed') : t('createFirst'), 'info', gcount ? t('active') : t('empty'), Math.min(100, gcount * 20)) +
            metric(t('sessions'), sessions, t('open'), t('sessionsSub'), sessions ? 'info' : 'off', sessions ? t('inProgress') : t('idle'), Math.min(100, sessions * 25)) +
            metric(t('offline'), offline, '', limited ? limited + ' ' + t('limitedNoAgent') : t('noContact'), offline ? 'warn' : 'ok', offline ? t('review') : t('allGood'), total ? offline * 100 / total : 0) + '</div>';
        var feed = evts().filter(function (e) { return e && e.msg && e.action !== 'servertimelinestats'; }).slice(0, 4).map(function (e) {
            var m = String(e.msg || ''), bad = /disconnect|offline|lost|fail|denied/i.test(m);
            var who = e.nodeid ? ((all.filter(function (n) { return n._id === e.nodeid; })[0] || {}).name || '') : (e.username || '');
            return '<div class="mbp-alert' + (bad ? ' bad' : '') + '"><div><b>' + esc(who) + '</b><span>' + esc(m) + '</span></div><time>' + esc(ago(e.time)) + '</time></div>';
        }).join('') || '<div class="mbp-empty">' + esc(t('noAlerts')) + '</div>';
        var cells = all.slice(0, 240).map(function (n) { var s = state(n); return '<i class="' + (s === 'ok' ? '' : s) + '" title="' + esc(n.name) + '"></i>'; }).join('');
        html += '<div class="mbp-grid mbp-mid"><div class="mbp-card"><header><span>' + esc(t('topology')) + '</span><span class="mbp-legend"><span><i style="color:var(--mb-accent)"></i>' + esc(t('server')) + '</span><span><i style="color:var(--mb-ok)"></i>' + esc(t('agent')) + '</span><span><i style="color:var(--mb-warn)"></i>' + esc(t('limited')) + '</span></span></header>' +
            '<div class="mbp-map">' + (total ? mapSvg(all) : '<div class="mbp-empty" style="padding-top:150px">' + esc(t('addDevice')) + '</div>') + '</div></div>' +
            '<div class="mbp-side"><div class="mbp-card"><header><span>' + esc(t('alerts')) + '</span><small>' + esc(t('latest')) + '</small></header>' + feed + '</div>' +
            '<div class="mbp-card"><header><span>' + esc(t('health')) + '</span><small>' + total + ' ' + esc(t('devices')) + '</small></header><div class="mbp-matrix">' + cells + '</div><div class="mbp-foot">' + online + ' ' + esc(t('footer')) + ' · ' + limited + ' ' + esc(t('footerLimited')) + ' · ' + offline + ' ' + esc(t('footerOff')) + '</div></div></div></div>';
        var rows = all.slice().sort(function (a, b) { return (state(a) === 'off') - (state(b) === 'off') || String(a.name).localeCompare(String(b.name)); }).slice(0, 8).map(function (n) {
            var s = state(n), gm = g[n.meshid] || {};
            var kind = s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : 'off';
            var label = s === 'ok' ? t('statusOn') : s === 'warn' ? t('statusLimited') : t('statusOff');
            return '<tr data-id="' + esc(n._id) + '"><td>' + esc(n.name) + '</td><td>' + esc(gm.name || '') + '</td><td>' + badge(kind, label) + '</td><td>' + esc(n.osdesc || '') + '</td><td style="font-family:var(--mb-mono);font-size:13px">' + esc(n.ip || n.host || '') + '</td></tr>';
        }).join('');
        html += '<div class="mbp-card"><header><span>' + esc(t('recent')) + '</span><a href="#" onclick="go(1,event);return false">' + esc(t('viewAll')) + '</a></header>' +
            '<table class="mbp-table"><thead><tr><th>' + esc(t('device')) + '</th><th>' + esc(t('group')) + '</th><th>' + esc(t('status')) + '</th><th>' + esc(t('system')) + '</th><th>' + esc(t('ip')) + '</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="mbp-empty">' + esc(t('noDevices')) + '</td></tr>') + '</tbody></table></div>';
        host.innerHTML = html;
    }
    window.mbRender = render;
    function current() { try { return typeof xxcurrentView !== 'undefined' ? xxcurrentView : null; } catch (e) { return null; } }
    function sync(x) {
        var a = q('LeftMenuMyPanel'); if (!a) return;
        var on = (x === VIEW);
        a.classList.toggle('mb-active', on);
        if (on) { var sel = document.querySelectorAll('#page_leftbar .lbbuttonsel, #page_leftbar .lbbuttonsel2'); for (var i = 0; i < sel.length; i++) { sel[i].classList.remove('lbbuttonsel', 'lbbuttonsel2'); } render(); }
    }
    function install() {
        if (typeof window.go !== 'function' || !q('p' + VIEW)) return false;
        if (window.__mbInstalled) return true; window.__mbInstalled = true;
        var og = window.go;
        window.go = function (x) { var r = og.apply(this, arguments); try { sync(x); } catch (e) { } return r; };
        if (typeof window.mainUpdate === 'function') { var om = window.mainUpdate; window.mainUpdate = function () { var r = om.apply(this, arguments); try { if (current() === VIEW) render(); } catch (e) { } return r; }; }
        document.addEventListener('click', function (e) {
            var tr = e.target.closest && e.target.closest('#p' + VIEW + ' [data-id]'); if (!tr) return;
            var id = tr.getAttribute('data-id'); if (id && typeof gotoDevice === 'function') { gotoDevice(id); }
        });
        setInterval(function () { try { if (current() === VIEW) render(); } catch (e) { } }, 30000);
        return true;
    }
    var tries = 0, timer = setInterval(function () { if (install() || ++tries > 120) { clearInterval(timer); } }, 500);
})();
