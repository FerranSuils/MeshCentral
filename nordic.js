/**
* @description Nordic Byte platform integration for MeshByte (signed events, link cards, space membership, Talk commands)
* @license Apache-2.0
*
* This file is not part of upstream MeshCentral. It is loaded by meshcentral.js only when a
* "nordic" section exists in the configuration (domain level, or settings level for the default
* domain), and everything in it is inert otherwise. The wire format is the Nordic Byte
* integration contract v1 (product id "meshbyte"); see docs/nordic-integration.md.
*/

'use strict';

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');

const PRODUCT = 'meshbyte';
const EVENT_TYPES = ['device.online', 'device.offline', 'device.help_requested', 'session.started', 'session.ended'];
const RETRY_DELAYS = [2, 10, 60];       // Seconds to wait before each retry
const SIGNATURE_TOLERANCE = 300;        // Seconds
const POST_TIMEOUT = 10000;             // Milliseconds
const MAX_BODY = 65536;                 // Largest request body accepted by the receivers
const MAX_SUBSCRIPTIONS = 20;
const MESHRIGHT_ADMIN = 0xFFFFFFFF;
const MESHRIGHT_REMOTECONTROL = 0x00000008;
const MESHRIGHT_REMOTEVIEWONLY = 0x00000100;
const SITERIGHT_LOCKED = 0x00000020;

// Relay session log messages (msgid of the 'relaylog' events) and the kind of session they describe
const SESSION_START = { 13: 'relay', 14: 'terminal', 15: 'desktop', 16: 'files', 162: 'messenger', 120: 'relay' };
const SESSION_END = { 9: 'relay', 10: 'terminal', 11: 'desktop', 12: 'files', 112: 'messenger', 121: 'relay' };
const HELP_REQUEST_MSGID = 98;


// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for the tests)
// ---------------------------------------------------------------------------------------------

// Compare two strings without leaking where they differ, whatever their lengths.
function safeEqual(a, b) {
    if ((typeof a != 'string') || (typeof b != 'string')) { return false; }
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// 'sha256=<hex HMAC_SHA256(secret, "<timestamp>.<raw body>")>'
function signature(secret, timestamp, body) {
    return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(String(timestamp) + '.' + body).digest('hex');
}

// Headers of the common signed envelope
function sign(secret, body, timestamp) {
    const ts = (timestamp == null) ? Math.floor(Date.now() / 1000) : Math.floor(Number(timestamp));
    return { 'X-Nordic-Timestamp': String(ts), 'X-Nordic-Signature': signature(secret, ts, body) };
}

// What a receiver does: refuse stale timestamps, compare in constant time. Also used for the
// Talk command signature, which has the same shape under other header names.
function verify(secret, body, timestamp, sig, nowSeconds, tolerance) {
    if ((typeof secret != 'string') || (secret.length == 0)) { return false; }
    if ((typeof sig != 'string') || (sig.length == 0)) { return false; }
    if ((typeof timestamp != 'string') || (/^[0-9]{1,12}$/.test(timestamp) == false)) { return false; }
    const now = (nowSeconds == null) ? (Date.now() / 1000) : nowSeconds;
    if (Math.abs(now - parseInt(timestamp, 10)) > ((tolerance == null) ? SIGNATURE_TOLERANCE : tolerance)) { return false; }
    return safeEqual(signature(secret, timestamp, body), sig);
}

function isoSeconds(ms) {
    if (ms == null) { return null; }
    const d = new Date(ms);
    if (isNaN(d.getTime())) { return null; }
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The one envelope every Nordic Byte product sends
function envelope(type, parts) {
    parts = parts || {};
    return {
        id: crypto.randomBytes(16).toString('hex'),
        type: type,
        product: PRODUCT,
        space: parts.space || null,
        actor: parts.actor || null,
        object: parts.object || null,
        data: parts.data || {},
        at: isoSeconds((parts.at == null) ? Date.now() : parts.at)
    };
}

// Networks a webhook may never be sent to
const blockedNetworks = new net.BlockList();
[['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]].forEach(function (n) { blockedNetworks.addSubnet(n[0], n[1], 'ipv4'); });
[['::', 127], ['64:ff9b::', 96], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]].forEach(function (n) { blockedNetworks.addSubnet(n[0], n[1], 'ipv6'); });

function isPrivateAddress(address) {
    if (typeof address != 'string') { return true; }
    const family = net.isIP(address);
    if (family == 4) { return blockedNetworks.check(address, 'ipv4'); }
    if (family != 6) { return true; } // Not an address at all
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
    if (mapped != null) { return isPrivateAddress(mapped[1]); }
    if (/^::ffff:/i.test(address) || /^(0+:){5}ffff:/i.test(address)) { return true; } // IPv4-mapped in another spelling
    return blockedNetworks.check(address, 'ipv6');
}

// Check a webhook destination: https only, resolved before sending, never a private network.
// Resolves to { url, address, family } so the request can be pinned to the address that was checked.
function checkDestination(url, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
        var parsed = null;
        try { parsed = new URL(String(url).trim()); } catch (ex) { }
        if ((parsed == null) || ((parsed.protocol != 'https:') && (parsed.protocol != 'http:')) || (parsed.hostname == '')) { reject(new Error('The URL must be https')); return; }
        if ((parsed.protocol == 'http:') && (options.allowPrivate !== true)) { reject(new Error('The URL must be https')); return; }
        if ((parsed.username != '') || (parsed.password != '')) { reject(new Error('The URL must not carry credentials')); return; }
        const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
        const lookup = options.lookup || dns.lookup;
        lookup(hostname, { all: true }, function (err, addresses) {
            if ((err != null) || (Array.isArray(addresses) == false) || (addresses.length == 0)) { reject(new Error('The destination cannot be resolved')); return; }
            if (options.allowPrivate !== true) {
                for (var i in addresses) { if (isPrivateAddress(addresses[i].address)) { reject(new Error('The destination cannot be a private network')); return; } }
            }
            resolve({ url: parsed, address: addresses[0].address, family: addresses[0].family || net.isIP(addresses[0].address) });
        });
    });
}

// POST the body to a checked destination. The connection goes to the address that passed the
// check (no second DNS answer), redirects are not followed.
function post(target, body, headers) {
    return new Promise(function (resolve, reject) {
        const secure = (target.url.protocol == 'https:');
        const options = {
            method: 'POST',
            hostname: target.url.hostname.replace(/^\[|\]$/g, ''),
            port: target.url.port || (secure ? 443 : 80),
            path: target.url.pathname + target.url.search,
            headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'MeshByte-Webhooks/1' }, headers),
            timeout: POST_TIMEOUT,
            lookup: function (hostname, opts, cb) {
                if (typeof opts == 'function') { cb = opts; opts = {}; }
                if (opts && opts.all) { cb(null, [{ address: target.address, family: target.family }]); } else { cb(null, target.address, target.family); }
            }
        };
        const req = require(secure ? 'https' : 'http').request(options, function (res) {
            res.on('data', function () { });
            res.on('end', function () { resolve(res.statusCode); });
            res.on('error', reject);
        });
        req.on('timeout', function () { req.destroy(new Error('timeout')); });
        req.on('error', reject);
        req.end(body);
    });
}

// Deliver one event to one subscription, retrying with growing waits. Never throws.
// hooks: { check, post, sleep, allowPrivate, retryDelays } so the tests can run it without a network.
function deliver(sub, body, hooks) {
    hooks = hooks || {};
    const delays = hooks.retryDelays || RETRY_DELAYS;
    const doCheck = hooks.check || checkDestination;
    const doPost = hooks.post || post;
    const doSleep = hooks.sleep || function (seconds) { return new Promise(function (r) { const t = setTimeout(r, seconds * 1000); if (t.unref) { t.unref(); } }); };
    var attempt = 0, last = null;
    function once() {
        return doCheck(sub.url, { allowPrivate: hooks.allowPrivate === true }).then(function (target) {
            return doPost(target, body, sign(sub.secret, body)); // Signed again on every attempt, the timestamp must stay fresh
        }).then(function (status) { last = status; return (status >= 200) && (status < 300); }, function (err) { last = (err && err.message) ? err.message : 'error'; return false; });
    }
    function loop() {
        return once().then(function (ok) {
            if (ok) { return { ok: true, status: last, attempts: attempt + 1 }; }
            if (attempt >= delays.length) { return { ok: false, status: last, attempts: attempt + 1 }; }
            return doSleep(delays[attempt++]).then(loop);
        });
    }
    return loop();
}

// Device connectivity with a grace period: a device that drops and comes back within graceMs
// produces no event at all. Devices that connect during the first quietMs after start are
// recorded but not announced, so a server restart does not announce the whole fleet.
function createPresenceTracker(options) {
    const now = options.now || Date.now;
    const setTimer = options.setTimer || function (f, ms) { const t = setTimeout(f, ms); if (t.unref) { t.unref(); } return t; };
    const clearTimer = options.clearTimer || clearTimeout;
    const graceMs = (typeof options.graceMs == 'number') ? options.graceMs : 60000;
    const quietUntil = now() + ((typeof options.quietMs == 'number') ? options.quietMs : 0);
    const online = {}, pending = {};
    return {
        update: function (nodeid, connected, info) {
            if (connected) {
                if (pending[nodeid] != null) { clearTimer(pending[nodeid]); delete pending[nodeid]; return 'kept'; } // Came back in time
                if (online[nodeid] === true) { return 'same'; }
                online[nodeid] = true;
                if (now() < quietUntil) { return 'quiet'; }
                options.emit('device.online', nodeid, info);
                return 'online';
            }
            if ((online[nodeid] !== true) || (pending[nodeid] != null)) { return 'same'; }
            const since = now();
            const fire = function () { delete pending[nodeid]; delete online[nodeid]; options.emit('device.offline', nodeid, Object.assign({}, info, { since: since })); };
            if (graceMs <= 0) { fire(); return 'offline'; }
            pending[nodeid] = setTimer(fire, graceMs);
            return 'pending';
        },
        isOnline: function (nodeid) { return online[nodeid] === true; },
        pendingCount: function () { return Object.keys(pending).length; },
        stop: function () { for (var i in pending) { clearTimer(pending[i]); delete pending[i]; } }
    };
}

// Remembers ids for a while so a repeated delivery is applied once
function createSeenCache(ttlMs, max) {
    const seen = new Map();
    ttlMs = ttlMs || 900000; max = max || 5000;
    return {
        check: function (id, now) { // Returns true when the id was already seen
            now = (now == null) ? Date.now() : now;
            if (seen.size >= max) { for (const [k, t] of seen) { if ((now - t) > ttlMs) { seen.delete(k); } } }
            if (seen.size >= max) { seen.delete(seen.keys().next().value); }
            const t = seen.get(id);
            if ((t != null) && ((now - t) <= ttlMs)) { return true; }
            seen.set(id, now);
            return false;
        }
    };
}

// A MeshCentral node or mesh id as it appears in a link: 64 characters of the server's base64
// variant ('@' and '$' instead of '+' and '/'), or 96 hexadecimal characters.
function normalizeShortId(value) {
    if (typeof value != 'string') { return null; }
    if (/^[0-9a-fA-F]{96}$/.test(value)) { return Buffer.from(value, 'hex').toString('base64').replace(/\+/g, '@').replace(/\//g, '$'); }
    if (/^[A-Za-z0-9@$]{64}$/.test(value)) { return value; }
    return null;
}

// Links the web UI itself produces:
//   device:  https://<server><domain url>?viewmode=10&gotonode=<node id>
//   group:   https://<server><domain url>?viewmode=20&gotomesh=<group id>
// Returns { type: 'device' | 'group', id } or null. Other hosts and other paths are not ours.
function parseLink(link, allowedHosts, domainUrl) {
    var parsed = null;
    try { parsed = new URL(String(link).trim()); } catch (ex) { return null; }
    if ((parsed.protocol != 'https:') && (parsed.protocol != 'http:')) { return null; }
    const hosts = (allowedHosts || []).filter(function (h) { return typeof h == 'string'; }).map(function (h) { return h.toLowerCase(); });
    if ((hosts.indexOf(parsed.host.toLowerCase()) < 0) && (hosts.indexOf(parsed.hostname.toLowerCase()) < 0)) { return null; }
    const base = (typeof domainUrl == 'string') ? domainUrl : '/';
    if ((parsed.pathname != base) && ((parsed.pathname + '/') != base)) { return null; }
    const node = parsed.searchParams.get('gotonode'), mesh = parsed.searchParams.get('gotomesh');
    if (node != null) { const id = normalizeShortId(node); return (id == null) ? null : { type: 'device', id: id }; }
    if (mesh != null) { const id = normalizeShortId(mesh); return (id == null) ? null : { type: 'group', id: id }; }
    return null;
}

// What a Talk role means here: [member of the space user group, administrator of its device groups]
function roleAccess(role) {
    if ((role == 'owner') || (role == 'admin')) { return { member: true, admin: true }; }
    if (role == 'member') { return { member: true, admin: false }; }
    return { member: false, admin: false }; // guest, unknown, removed
}

// The person in Nordic Byte terms: the Talk "sub" when the account came from the OIDC sign-in
function actorId(userid) {
    if (typeof userid != 'string') { return null; }
    const s = userid.split('/');
    if ((s.length >= 3) && (s[0] == 'user')) {
        const name = s.slice(2).join('/');
        return name.startsWith('~oidc:') ? name.substring(6) : userid;
    }
    return userid;
}

function validSub(sub) { return (typeof sub == 'string') && /^[^\s\/\u0000-\u001f]{1,128}$/.test(sub); }

function isConfigured(config) {
    if ((config == null) || (typeof config != 'object')) { return false; }
    if ((config.settings != null) && (typeof config.settings.nordic == 'object') && (config.settings.nordic != null)) { return true; }
    for (var i in config.domains) { if ((config.domains[i] != null) && (typeof config.domains[i].nordic == 'object') && (config.domains[i].nordic != null)) { return true; } }
    return false;
}


// ---------------------------------------------------------------------------------------------
// Server module
// ---------------------------------------------------------------------------------------------

module.exports.CreateNordic = function (parent) {
    const obj = {};
    obj.parent = parent;
    obj.trackers = {};                          // Presence tracker per domain
    obj.endedSessions = createSeenCache(600000, 2000);
    obj.seenEvents = createSeenCache(900000, 5000);
    obj.dbSubscriptions = {};                   // Subscriptions created over the API, per domain, once loaded
    obj.deliver = deliver;                      // Replaceable in tests
    obj.startTime = Date.now();

    function debug() { try { parent.debug.apply(parent, ['nordic'].concat(Array.prototype.slice.call(arguments))); } catch (ex) { } }
    function web() { return parent.webserver; }

    // The "nordic" section that applies to a domain, or null
    function getConfig(domainOrId) {
        const id = (typeof domainOrId == 'string') ? domainOrId : ((domainOrId != null) ? domainOrId.id : null);
        if (id == null) { return null; }
        const domain = parent.config.domains[id];
        if ((domain != null) && (typeof domain.nordic == 'object') && (domain.nordic != null)) { return domain.nordic; }
        if ((id == '') && (parent.config.settings != null) && (typeof parent.config.settings.nordic == 'object') && (parent.config.settings.nordic != null)) { return parent.config.settings.nordic; }
        return null;
    }
    obj.getConfig = getConfig;

    function secretOf(cfg, key, envName) {
        if ((typeof cfg[key] == 'string') && (cfg[key].length > 0)) { return cfg[key]; }
        if ((typeof process.env[envName] == 'string') && (process.env[envName].length > 0)) { return process.env[envName]; }
        return null;
    }

    // Public address of a domain, always ending with '/'
    function baseUrl(domain, cfg) {
        if ((typeof cfg.publicurl == 'string') && (cfg.publicurl.length > 0)) { return cfg.publicurl.replace(/\/+$/, '') + '/'; }
        const port = (parent.args.aliasport != null) ? parent.args.aliasport : parent.args.port;
        var origin = 'https://' + (domain.dns ? domain.dns : ((parent.certificates != null) ? parent.certificates.CommonName : 'localhost'));
        if ((port != null) && (port != 443)) { origin += ':' + port; }
        return origin + ((typeof domain.url == 'string') ? domain.url : '/');
    }
    function deviceUrl(domain, cfg, nodeid, viewmode) { return baseUrl(domain, cfg) + '?viewmode=' + (viewmode || 10) + '&gotonode=' + encodeURIComponent(nodeid.split('/')[2]); }
    function groupUrl(domain, cfg, meshid) { return baseUrl(domain, cfg) + '?viewmode=20&gotomesh=' + encodeURIComponent(meshid.split('/')[2]); }

    // Space bound to a device group: spaces: [{ id, usergroup, meshes: [ id | short id | name ] }]
    function spaceForMesh(cfg, meshid) {
        if ((Array.isArray(cfg.spaces) == false) || (typeof meshid != 'string')) { return null; }
        const mesh = (web() != null) ? web().meshes[meshid] : null;
        const shortId = meshid.split('/')[2];
        for (var i in cfg.spaces) {
            const s = cfg.spaces[i];
            if ((s == null) || (typeof s.id != 'string') || (Array.isArray(s.meshes) == false)) { continue; }
            for (var j in s.meshes) { if ((s.meshes[j] === meshid) || (s.meshes[j] === shortId) || ((mesh != null) && (s.meshes[j] === mesh.name))) { return s; } }
        }
        return null;
    }
    function spaceById(cfg, id) {
        if ((Array.isArray(cfg.spaces) == false) || (typeof id != 'string')) { return null; }
        for (var i in cfg.spaces) { if ((cfg.spaces[i] != null) && (cfg.spaces[i].id === id)) { return cfg.spaces[i]; } }
        return null;
    }
    // Device group ids of a space that exist in this domain
    function spaceMeshIds(domain, space) {
        const r = [];
        if ((space == null) || (Array.isArray(space.meshes) == false) || (web() == null)) { return r; }
        const prefix = 'mesh/' + domain.id + '/';
        for (var i in web().meshes) {
            const m = web().meshes[i];
            if ((m == null) || (m.deleted != null) || (i.startsWith(prefix) == false)) { continue; }
            if ((space.meshes.indexOf(i) >= 0) || (space.meshes.indexOf(i.split('/')[2]) >= 0) || (space.meshes.indexOf(m.name) >= 0)) { r.push(i); }
        }
        return r;
    }
    function spaceUserGroup(domain, space) {
        if ((space == null) || (typeof space.usergroup != 'string') || (web() == null)) { return null; }
        var id = space.usergroup;
        if (id.indexOf('/') < 0) { id = 'ugrp/' + domain.id + '/' + id; }
        if (web().userGroups[id] != null) { return web().userGroups[id]; }
        const prefix = 'ugrp/' + domain.id + '/';
        for (var i in web().userGroups) { if (i.startsWith(prefix) && (web().userGroups[i] != null) && (web().userGroups[i].name === space.usergroup)) { return web().userGroups[i]; } }
        return null;
    }


    // ---- Outbound events ----------------------------------------------------------------

    function configSubscriptions(cfg) {
        const r = [];
        if (Array.isArray(cfg.webhooks) == false) { return r; }
        for (var i in cfg.webhooks) {
            const w = cfg.webhooks[i];
            if ((w == null) || (typeof w.url != 'string') || (typeof w.secret != 'string') || (w.secret.length == 0)) { continue; }
            r.push({ id: 'config-' + i, name: (typeof w.name == 'string') ? w.name : '', url: w.url, secret: w.secret, events: Array.isArray(w.events) ? w.events : null, source: 'config' });
        }
        return r;
    }

    function loadDbSubscriptions(domainId, func) {
        if (obj.dbSubscriptions[domainId] != null) { func(obj.dbSubscriptions[domainId]); return; }
        try {
            parent.db.Get('nordicwebhooks/' + domainId, function (err, docs) {
                if (obj.dbSubscriptions[domainId] == null) { obj.dbSubscriptions[domainId] = ((docs != null) && (docs.length == 1) && Array.isArray(docs[0].subs)) ? docs[0].subs : []; }
                func(obj.dbSubscriptions[domainId]);
            });
        } catch (ex) { func([]); }
    }
    function saveDbSubscriptions(domainId, func) {
        parent.db.Set({ _id: 'nordicwebhooks/' + domainId, type: 'nordicwebhooks', domain: domainId, subs: obj.dbSubscriptions[domainId] || [] }, func);
    }

    function subscriptionsFor(domainId, cfg, type, func) {
        const wants = function (s) { return (Array.isArray(s.events) == false) || (s.events.length == 0) || (s.events.indexOf(type) >= 0); };
        const fromConfig = configSubscriptions(cfg).filter(wants);
        if (cfg.webhooksapi === false) { func(fromConfig); return; }
        loadDbSubscriptions(domainId, function (subs) { func(fromConfig.concat(subs.filter(wants))); });
    }

    // Send an event about a device to every subscription of its domain that wants it
    obj.emit = function (domainId, type, nodeid, parts) {
        const cfg = getConfig(domainId), domain = parent.config.domains[domainId];
        if ((cfg == null) || (domain == null) || (typeof nodeid != 'string')) { return; }
        subscriptionsFor(domainId, cfg, type, function (subs) {
            if (subs.length == 0) { return; }
            parent.db.Get(nodeid, function (err, nodes) {
                if ((nodes == null) || (nodes.length != 1)) { return; } // The device is gone
                const node = nodes[0], space = spaceForMesh(cfg, node.meshid);
                const body = JSON.stringify(envelope(type, {
                    space: (space != null) ? { id: space.id } : null,
                    actor: parts.actor || null,
                    object: { type: 'device', id: nodeid.split('/')[2], url: deviceUrl(domain, cfg, nodeid), title: node.name },
                    data: Object.assign({ group: groupName(node.meshid) }, parts.data || {}),
                    at: parts.at
                }));
                subs.forEach(function (sub) {
                    obj.deliver(sub, body, { allowPrivate: cfg.allowprivatedestinations === true }).then(function (r) {
                        sub.lastStatus = r.status; sub.lastAt = Date.now();
                        if (r.ok !== true) { debug('Webhook ' + sub.id + ' not delivered (' + type + '): ' + r.status); }
                    }).catch(function (ex) { debug('Webhook ' + sub.id + ' failed: ' + ex); });
                });
            });
        });
    };

    function groupName(meshid) { const m = (web() != null) ? web().meshes[meshid] : null; return (m != null) ? m.name : null; }

    function trackerFor(domainId, cfg) {
        if (obj.trackers[domainId] == null) {
            const grace = (typeof cfg.graceseconds == 'number') ? cfg.graceseconds : 60;
            const quiet = (typeof cfg.startupquietseconds == 'number') ? cfg.startupquietseconds : 120;
            obj.trackers[domainId] = createPresenceTracker({
                graceMs: grace * 1000,
                quietMs: Math.max(0, (obj.startTime + (quiet * 1000)) - Date.now()),
                emit: function (type, nodeid, info) {
                    const data = {};
                    if (type == 'device.offline') { data.since = isoSeconds(info.since); }
                    obj.emit(domainId, type, nodeid, { data: data });
                }
            });
        }
        return obj.trackers[domainId];
    }

    // Called by the server for every dispatched event ('*' target)
    obj.HandleEvent = function (source, event) {
        if ((event == null) || (typeof event != 'object') || (typeof event.action != 'string')) { return; }
        try {
            if (event.action == 'nodeconnect') {
                if ((typeof event.nodeid != 'string') || (typeof event.domain != 'string')) { return; }
                const cfg = getConfig(event.domain);
                if (cfg == null) { return; }
                trackerFor(event.domain, cfg).update(event.nodeid, (typeof event.conn == 'number') && (event.conn != 0), {});
            } else if (event.action == 'agentlog') {
                if ((event.msgid != HELP_REQUEST_MSGID) || (typeof event.nodeid != 'string') || (getConfig(event.domain) == null)) { return; }
                const args = Array.isArray(event.msgArgs) ? event.msgArgs : [];
                obj.emit(event.domain, 'device.help_requested', event.nodeid, { data: { user: (typeof args[0] == 'string') ? args[0].substring(0, 200) : null, message: (typeof args[1] == 'string') ? args[1].substring(0, 2000) : null } });
            } else if (event.action == 'relaylog') {
                if ((typeof event.nodeid != 'string') || (typeof event.domain != 'string') || (getConfig(event.domain) == null)) { return; }
                const started = SESSION_START[event.msgid], ended = SESSION_END[event.msgid];
                if ((started == null) && (ended == null)) { return; }
                const args = Array.isArray(event.msgArgs) ? event.msgArgs : [];
                const sessionId = (typeof args[0] == 'string') ? args[0] : null;
                const actor = { id: actorId(event.userid), name: (typeof event.username == 'string') ? event.username : null };
                const data = { session: sessionId, kind: started || ended };
                if (typeof event.guestname == 'string') { data.guest = event.guestname; }
                if (started != null) {
                    obj.emit(event.domain, 'session.started', event.nodeid, { actor: actor, data: data });
                } else {
                    if ((sessionId != null) && obj.endedSessions.check(event.domain + '/' + sessionId)) { return; } // Both sides closing is one end
                    if (typeof args[3] == 'number') { data.seconds = args[3]; }
                    obj.emit(event.domain, 'session.ended', event.nodeid, { actor: actor, data: data });
                }
            }
        } catch (ex) { debug('HandleEvent: ' + ex); }
    };


    // ---- HTTP plumbing -------------------------------------------------------------------

    function send(res, status, body) {
        res.status(status);
        res.set('Content-Type', 'application/json');
        res.set('Cache-Control', 'no-store');
        res.send(JSON.stringify(body));
    }
    function notFound(res) { send(res, 404, { error: 'not_found' }); }

    function readBody(req, func) {
        if (typeof req.rawBody == 'string') { func(null, req.rawBody); return; }
        var chunks = [], size = 0, done = false;
        req.on('data', function (chunk) {
            if (done) { return; }
            size += chunk.length;
            if (size > MAX_BODY) { done = true; func(new Error('too large')); return; }
            chunks.push(chunk);
        });
        req.on('end', function () { if (done) { return; } done = true; func(null, Buffer.concat(chunks).toString('utf8')); });
        req.on('error', function (err) { if (done) { return; } done = true; func(err); });
    }

    function header(req, name) { const v = (req.headers != null) ? req.headers[name] : null; return (typeof v == 'string') ? v : ''; }

    // The MeshByte account of a Nordic Byte person. Returns undefined for an unusable value,
    // null when there is no such (usable) account.
    function userFromSub(domain, value) {
        if ((typeof value != 'string') || (web() == null)) { return undefined; }
        value = value.trim();
        if ((value.length == 0) || (value.length > 256) || /[\u0000-\u001f]/.test(value)) { return undefined; }
        var user = null;
        if (value.startsWith('user/')) {
            if (value.startsWith('user/' + domain.id + '/')) { user = web().users[value]; } // The product's own user id is accepted too
        } else {
            if (validSub(value) == false) { return undefined; }
            user = web().users['user/' + domain.id + '/~oidc:' + value];
        }
        if (user == null) { return null; }
        if ((typeof user.siteadmin == 'number') && (user.siteadmin != MESHRIGHT_ADMIN) && ((user.siteadmin & SITERIGHT_LOCKED) != 0)) { return null; } // Locked account
        return user;
    }

    function allowedHosts(domain, cfg, req) {
        const hosts = [];
        try { const b = new URL(baseUrl(domain, cfg)); hosts.push(b.host, b.hostname); } catch (ex) { }
        if (typeof domain.dns == 'string') { hosts.push(domain.dns); }
        if ((parent.certificates != null) && (typeof parent.certificates.CommonName == 'string')) { hosts.push(parent.certificates.CommonName); }
        const h = header(req, 'host'); if (h != '') { hosts.push(h); }
        return hosts;
    }


    // ---- Link cards ----------------------------------------------------------------------

    function lastContact(nodeid, online, func) {
        if (online) { func(Date.now()); return; }
        try {
            parent.db.Get('lc' + nodeid, function (err, docs) { func(((docs != null) && (docs.length == 1) && (typeof docs[0].time == 'number')) ? docs[0].time : null); });
        } catch (ex) { func(null); }
    }

    function card(type, id, url, title, subtitle, status, fields, actions, updated) {
        return {
            product: PRODUCT, type: type, id: id, url: url, title: title, subtitle: subtitle || '', status: status || null,
            fields: fields.filter(function (f) { return (f[1] != null) && (f[1] !== ''); }).map(function (f) { return { label: f[0], value: String(f[1]) }; }),
            actions: actions, updatedAt: isoSeconds(updated)
        };
    }

    // Card of a device, only when MeshCentral itself would show that device to that user
    obj.deviceCard = function (domain, cfg, user, nodeid, func) {
        web().GetNodeWithRights(domain, user, nodeid, function (node, rights, visible) {
            if ((node == null) || (visible !== true)) { func(null); return; }
            const state = parent.GetConnectivityState(nodeid);
            const online = (state != null) && (typeof state.connectivity == 'number') && (state.connectivity != 0);
            lastContact(nodeid, online, function (contact) {
                const label = online ? 'Online' : 'Offline', group = groupName(node.meshid);
                const actions = [];
                if ((rights & (MESHRIGHT_REMOTECONTROL | MESHRIGHT_REMOTEVIEWONLY)) != 0) { actions.push({ id: 'open_session', label: 'Open session', url: deviceUrl(domain, cfg, nodeid, 11) }); }
                actions.push({ id: 'open', label: 'Open', url: deviceUrl(domain, cfg, nodeid, 10) });
                func(card('device', nodeid.split('/')[2], deviceUrl(domain, cfg, nodeid, 10), node.name, ((group != null) ? (group + ' · ') : '') + label,
                    { label: label, tone: online ? 'positive' : 'neutral' },
                    [['Group', group], ['System', node.osdesc], ['Last contact', isoSeconds(contact)]], actions, contact));
            });
        });
    };

    obj.groupCard = function (domain, cfg, user, meshid, func) {
        const mesh = web().meshes[meshid];
        if ((mesh == null) || (mesh.deleted != null) || (web().IsMeshViewable(user, mesh) !== true)) { func(null); return; }
        const finish = function (total, online) {
            func(card('group', meshid.split('/')[2], groupUrl(domain, cfg, meshid), mesh.name, (typeof mesh.desc == 'string') ? mesh.desc.substring(0, 140) : '',
                (total == null) ? null : { label: online + ' of ' + total + ' online', tone: (online > 0) ? 'positive' : 'neutral' },
                [['Devices', total], ['Online', online]], [{ id: 'open', label: 'Open', url: groupUrl(domain, cfg, meshid) }], null));
        };
        try {
            parent.db.GetAllTypeNoTypeFieldMeshFiltered([meshid], null, domain.id, 'node', null, 0, 0, function (err, docs) {
                if ((err != null) || (Array.isArray(docs) == false)) { finish(null, null); return; }
                var online = 0;
                for (var i in docs) { const s = parent.GetConnectivityState(docs[i]._id); if ((s != null) && (s.connectivity != 0)) { online++; } }
                finish(docs.length, online);
            });
        } catch (ex) { finish(null, null); }
    };

    // GET /.well-known/nordic/resolve?url=<link>
    obj.handleResolve = function (req, res, domain) {
        const cfg = getConfig(domain);
        if (cfg == null) { notFound(res); return; }
        const token = secretOf(cfg, 'resolvetoken', 'NORDIC_RESOLVE_TOKEN');
        if ((token == null) || (safeEqual(header(req, 'authorization'), 'Bearer ' + token) == false)) { send(res, 401, { error: 'unauthorized' }); return; }
        const user = userFromSub(domain, header(req, 'x-nordic-user'));
        if (user === undefined) { send(res, 400, { error: 'bad_user' }); return; }
        if (user == null) { notFound(res); return; }
        const link = parseLink((req.query != null) ? req.query.url : null, allowedHosts(domain, cfg, req), domain.url);
        if (link == null) { notFound(res); return; }
        const done = function (c) { if (c == null) { notFound(res); } else { send(res, 200, c); } };
        try {
            if (link.type == 'device') { obj.deviceCard(domain, cfg, user, 'node/' + domain.id + '/' + link.id, done); }
            else { obj.groupCard(domain, cfg, user, 'mesh/' + domain.id + '/' + link.id, done); }
        } catch (ex) { debug('resolve: ' + ex); notFound(res); }
    };


    // ---- Space membership (events from Talk) ---------------------------------------------

    function notifyUserChanged(domain, user, msg) {
        parent.db.SetUser(user);
        parent.DispatchEvent([user._id], obj, 'resubscribe');
        const event = { etype: 'user', userid: user._id, username: user.name, account: web().CloneSafeUser(user), action: 'accountchange', msg: msg, domain: domain.id };
        if (parent.db.changeStream) { event.noact = 1; }
        parent.DispatchEvent(['*', 'server-users', user._id], obj, event);
    }

    // Apply one membership to the user group and device groups of a space. Returns what was done.
    obj.applyMembership = function (domain, cfg, space, member, removed) {
        if ((member == null) || (validSub(member.sub) == false)) { return 'bad_member'; }
        const access = roleAccess(removed ? null : member.role);
        const userid = 'user/' + domain.id + '/~oidc:' + member.sub;
        var user = web().users[userid], changed = false, created = false;

        if ((user == null) && access.member && (cfg.provisionusers !== false)) {
            // Create the account the OIDC sign-in would create, so the person is not invited twice
            const now = Math.floor(Date.now() / 1000);
            user = { type: 'user', _id: userid, name: ((typeof member.name == 'string') && (member.name.length > 0)) ? member.name.substring(0, 128) : member.sub, creation: now, domain: domain.id, links: {} };
            if ((typeof member.email == 'string') && (member.email.length < 320)) { user.email = member.email; }
            web().users[userid] = user;
            created = true; changed = true;
        }
        if (user == null) { return 'no_account'; }
        if (user.links == null) { user.links = {}; }

        // User group of the space
        const group = spaceUserGroup(domain, space);
        var groupChanged = false, result = 'ok';
        if (group == null) {
            if (typeof space.usergroup == 'string') { result = 'usergroup_missing'; debug('User group "' + space.usergroup + '" of space ' + space.id + ' does not exist'); }
        } else if (group.membershipType == null) { // Externally managed groups are left alone
            if (group.links == null) { group.links = {}; }
            if (access.member && ((user.links[group._id] == null) || (group.links[userid] == null))) {
                user.links[group._id] = { rights: 1 };
                group.links[userid] = { userid: userid, name: user.name, rights: 1 };
                changed = true; groupChanged = true;
            } else if ((access.member == false) && ((user.links[group._id] != null) || (group.links[userid] != null))) {
                delete user.links[group._id];
                delete group.links[userid];
                changed = true; groupChanged = true;
            }
            if (groupChanged) {
                parent.db.Set(group);
                const event = { etype: 'ugrp', ugrpid: group._id, name: group.name, desc: group.desc, action: 'usergroupchange', links: group.links, msg: (access.member ? 'Added user ' : 'Removed user ') + user.name + (access.member ? ' to' : ' from') + ' user group ' + group.name, domain: domain.id };
                if (parent.db.changeStream) { event.noact = 1; }
                parent.DispatchEvent(['*', group._id, userid], obj, event);
            }
        }

        // Device groups of the space: owners and admins administer them. Only links this module
        // created (marked "nordic") are ever changed or removed; a link made by hand stays as it is.
        const meshIds = spaceMeshIds(domain, space);
        for (var i in meshIds) {
            const mesh = web().meshes[meshIds[i]];
            if (mesh.links == null) { mesh.links = {}; }
            const mine = (user.links[mesh._id] != null) && (user.links[mesh._id].nordic === 1) && (mesh.links[userid] != null) && (mesh.links[userid].nordic === 1); // Edited by hand since then: no longer ours
            var meshChanged = false;
            if (access.admin && (user.links[mesh._id] == null) && (mesh.links[userid] == null)) {
                user.links[mesh._id] = { rights: MESHRIGHT_ADMIN, nordic: 1 };
                mesh.links[userid] = { name: user.name, rights: MESHRIGHT_ADMIN, nordic: 1 };
                meshChanged = true;
            } else if ((access.admin == false) && mine) {
                delete user.links[mesh._id];
                delete mesh.links[userid];
                meshChanged = true;
            }
            if (meshChanged) {
                changed = true;
                parent.db.Set(mesh);
                const event = { etype: 'mesh', username: user.name, meshid: mesh._id, name: mesh.name, mtype: mesh.mtype, desc: mesh.desc, action: 'meshchange', links: mesh.links, msg: (access.admin ? 'Added user ' : 'Removed user ') + user.name + (access.admin ? ' to' : ' from') + ' device group ' + mesh.name, domain: domain.id, invite: mesh.invite };
                if (parent.db.changeStream) { event.noact = 1; }
                parent.DispatchEvent(web().CreateMeshDispatchTargets(mesh, [userid]), obj, event);
                try { web().InvalidateNodeCache(user, mesh); } catch (ex) { }
            }
        }

        if (created) {
            parent.db.SetUser(user);
            const event = { etype: 'user', userid: user._id, username: user.name, account: web().CloneSafeUser(user), action: 'accountcreate', msg: 'Account created, username is ' + user.name, domain: domain.id };
            if (parent.db.changeStream) { event.noact = 1; }
            parent.DispatchEvent(['*', 'server-users'], obj, event);
        } else if (changed) {
            notifyUserChanged(domain, user, 'Space membership changed: ' + user.name);
        }
        if (changed) { try { web().FlushGetNodeRightsCache(); } catch (ex) { } }
        return (result != 'ok') ? result : (created ? 'created' : (changed ? 'changed' : 'unchanged'));
    };

    // POST /.well-known/nordic/events
    obj.handleEvents = function (req, res, domain) {
        const cfg = getConfig(domain);
        if (cfg == null) { notFound(res); return; }
        const secret = secretOf(cfg, 'eventssecret', 'NORDIC_EVENTS_SECRET');
        readBody(req, function (err, body) {
            if (err != null) { send(res, 413, { error: 'too_large' }); return; }
            if ((secret == null) || (verify(secret, body, header(req, 'x-nordic-timestamp'), header(req, 'x-nordic-signature')) == false)) { send(res, 401, { error: 'unauthorized' }); return; }
            var event = null;
            try { event = JSON.parse(body); } catch (ex) { }
            if ((event == null) || (typeof event != 'object') || (typeof event.id != 'string') || (typeof event.type != 'string')) { send(res, 400, { error: 'bad_event' }); return; }
            if (obj.seenEvents.check(domain.id + '/' + event.id)) { send(res, 200, { ok: true, duplicate: true }); return; }
            if (['space.member_added', 'space.member_removed', 'space.role_changed'].indexOf(event.type) < 0) { send(res, 202, { ok: true, ignored: 'type' }); return; }
            const space = spaceById(cfg, (event.space != null) ? event.space.id : null);
            if (space == null) { send(res, 202, { ok: true, ignored: 'space' }); return; }
            var result;
            try { result = obj.applyMembership(domain, cfg, space, (event.data != null) ? event.data.member : null, event.type == 'space.member_removed'); }
            catch (ex) { debug('events: ' + ex); send(res, 500, { error: 'failed' }); return; }
            if (result == 'bad_member') { send(res, 400, { error: 'bad_member' }); return; }
            send(res, 200, { ok: true, result: result });
        });
    };


    // ---- Talk commands -------------------------------------------------------------------

    function reply(res, text, extra) { send(res, 200, Object.assign({ text: text }, extra || {})); }

    // Devices of the space's device groups that this user can see, by name
    function findDevices(domain, user, meshIds, name, func) {
        const visible = web().GetAllMeshIdWithRights(user);
        const ids = meshIds.filter(function (m) { return visible.indexOf(m) >= 0; });
        if (ids.length == 0) { func([]); return; }
        parent.db.GetAllTypeNoTypeFieldMeshFiltered(ids, null, domain.id, 'node', null, 0, 0, function (err, docs) {
            if ((err != null) || (Array.isArray(docs) == false)) { func([]); return; }
            const wanted = name.toLowerCase();
            const exact = docs.filter(function (d) { return (typeof d.name == 'string') && (d.name.toLowerCase() == wanted); });
            func((exact.length > 0) ? exact : docs.filter(function (d) { return (typeof d.name == 'string') && (d.name.toLowerCase().indexOf(wanted) >= 0); }));
        });
    }

    // POST /.well-known/nordic/commands   ("/mesh <device>")
    // Talk publishes the text of the answer in the channel where the command was typed, so the
    // search is limited to the device groups of that space and to what the person can see.
    obj.handleCommands = function (req, res, domain) {
        const cfg = getConfig(domain);
        if (cfg == null) { notFound(res); return; }
        const secret = secretOf(cfg, 'talkbotsecret', 'NORDIC_TALK_BOT_SECRET');
        readBody(req, function (err, body) {
            if (err != null) { send(res, 413, { error: 'too_large' }); return; }
            if ((secret == null) || (verify(secret, body, header(req, 'x-talk-timestamp'), header(req, 'x-talk-signature')) == false)) { send(res, 401, { error: 'unauthorized' }); return; }
            var cmd = null;
            try { cmd = JSON.parse(body); } catch (ex) { }
            if ((cmd == null) || (typeof cmd != 'object') || (typeof cmd.command != 'string')) { send(res, 400, { error: 'bad_command' }); return; }
            if (cmd.command.replace(/^\//, '').toLowerCase() != 'mesh') { reply(res, 'Unknown command. Use /mesh <device>.'); return; }
            const name = (Array.isArray(cmd.args) ? cmd.args.join(' ') : ((typeof cmd.args == 'string') ? cmd.args : '')).trim();
            if ((name.length == 0) || (name.length > 256)) { reply(res, 'Usage: /mesh <device>'); return; }
            const user = userFromSub(domain, ((cmd.user != null) && (cmd.user.id != null)) ? String(cmd.user.id) : null);
            if (user == null) { reply(res, 'You have no MeshByte account yet. Sign in to MeshByte with your Nordic Byte account first.'); return; }
            const space = spaceById(cfg, (cmd.space != null) ? String(cmd.space.id) : null);
            if (space == null) { reply(res, 'This space is not connected to MeshByte.'); return; }
            const none = 'No device named "' + name.substring(0, 80) + '" that you can open in this space.';
            try {
                findDevices(domain, user, spaceMeshIds(domain, space), name, function (found) {
                    if (found.length == 0) { reply(res, none); return; }
                    if (found.length > 1) { reply(res, 'Several devices match: ' + found.slice(0, 8).map(function (d) { return d.name; }).join(', ') + ((found.length > 8) ? ', …' : '') + '. Use the full name.'); return; }
                    obj.deviceCard(domain, cfg, user, found[0]._id, function (c) {
                        if (c == null) { reply(res, none); return; }
                        const lines = [c.title + ' · ' + c.status.label];
                        const details = c.fields.map(function (f) { return f.label + ': ' + f.value; });
                        if (details.length > 0) { lines.push(details.join(' · ')); }
                        const session = c.actions.filter(function (a) { return a.id == 'open_session'; })[0];
                        lines.push((session != null) ? ('Open remote session: ' + session.url) : ('Open: ' + c.url));
                        reply(res, lines.join('\n'), { card: c });
                    });
                });
            } catch (ex) { debug('commands: ' + ex); reply(res, none); }
        });
    };


    // ---- Subscription management for site administrators ---------------------------------

    function sessionAdmin(req, domain) {
        const userid = (req.session != null) ? req.session.userid : null;
        if ((typeof userid != 'string') || (web() == null)) { return null; }
        const user = web().users[userid];
        if ((user == null) || (user.domain !== domain.id) || (user.siteadmin !== MESHRIGHT_ADMIN)) { return null; }
        return user;
    }
    // A browser may only change things from the server's own pages
    function sameOrigin(req) {
        const origin = header(req, 'origin');
        if (origin == '') { return true; }
        try { return new URL(origin).host.toLowerCase() == header(req, 'host').toLowerCase(); } catch (ex) { return false; }
    }
    function publicSubscription(s) { return { id: s.id, name: s.name || '', url: s.url, events: (Array.isArray(s.events) && (s.events.length > 0)) ? s.events : EVENT_TYPES, source: s.source || 'api', createdAt: s.createdAt || null, lastStatus: (s.lastStatus == null) ? null : s.lastStatus, lastAt: isoSeconds(s.lastAt) }; }

    function webhooksGate(req, res, domain) {
        const cfg = getConfig(domain);
        if ((cfg == null) || (cfg.webhooksapi === false)) { notFound(res); return null; }
        if (sessionAdmin(req, domain) == null) { send(res, 401, { error: 'unauthorized' }); return null; }
        return cfg;
    }

    // GET /api/webhooks
    obj.handleWebhooksList = function (req, res, domain) {
        const cfg = webhooksGate(req, res, domain);
        if (cfg == null) { return; }
        loadDbSubscriptions(domain.id, function (subs) { send(res, 200, { webhooks: configSubscriptions(cfg).concat(subs).map(publicSubscription) }); });
    };

    // POST /api/webhooks { url, events?, name? }
    obj.handleWebhooksCreate = function (req, res, domain) {
        const cfg = webhooksGate(req, res, domain);
        if (cfg == null) { return; }
        if ((sameOrigin(req) == false) || (header(req, 'content-type').toLowerCase().indexOf('application/json') != 0)) { send(res, 403, { error: 'forbidden' }); return; }
        readBody(req, function (err, body) {
            var b = null;
            try { b = JSON.parse(body); } catch (ex) { }
            if ((err != null) || (b == null) || (typeof b != 'object') || (typeof b.url != 'string')) { send(res, 400, { error: 'bad_request' }); return; }
            checkDestination(b.url, { allowPrivate: cfg.allowprivatedestinations === true }).then(function (target) {
                loadDbSubscriptions(domain.id, function (subs) {
                    if (subs.length >= MAX_SUBSCRIPTIONS) { send(res, 400, { error: 'too_many' }); return; }
                    const events = Array.isArray(b.events) ? b.events.filter(function (e) { return EVENT_TYPES.indexOf(e) >= 0; }) : [];
                    const sub = { id: crypto.randomBytes(5).toString('hex'), name: (typeof b.name == 'string') ? b.name.trim().substring(0, 80) : '', url: target.url.href, events: (events.length > 0) ? events : EVENT_TYPES.slice(), secret: 'mbw_' + crypto.randomBytes(32).toString('base64url'), createdAt: isoSeconds(Date.now()), source: 'api' };
                    subs.push(sub);
                    saveDbSubscriptions(domain.id, function () { send(res, 201, Object.assign(publicSubscription(sub), { secret: sub.secret })); }); // The secret is shown this once
                });
            }, function (ex) { send(res, 400, { error: 'bad_url', message: ex.message }); });
        });
    };

    // DELETE /api/webhooks/<id>
    obj.handleWebhooksDelete = function (req, res, domain) {
        const cfg = webhooksGate(req, res, domain);
        if (cfg == null) { return; }
        if (sameOrigin(req) == false) { send(res, 403, { error: 'forbidden' }); return; }
        const id = (req.params != null) ? req.params.id : null;
        loadDbSubscriptions(domain.id, function (subs) {
            const index = subs.findIndex(function (s) { return s.id === id; });
            if (index < 0) { notFound(res); return; }
            subs.splice(index, 1);
            saveDbSubscriptions(domain.id, function () { send(res, 200, { ok: true }); });
        });
    };


    // ---- Wiring --------------------------------------------------------------------------

    // Called by webserver.js once per domain URL. getDomain(req) is the web server's own resolver.
    obj.setupHttpHandlers = function (webserver, url, getDomain) {
        const wrap = function (handler) {
            return function (req, res) {
                var domain = null;
                try { domain = getDomain(req); } catch (ex) { }
                if ((domain == null) || (getConfig(domain) == null)) { notFound(res); return; }
                try { handler(req, res, domain); } catch (ex) { debug('http: ' + ex); try { send(res, 500, { error: 'failed' }); } catch (ex2) { } }
            };
        };
        webserver.app.get(url + '.well-known/nordic/resolve', wrap(obj.handleResolve));
        webserver.app.post(url + '.well-known/nordic/events', wrap(obj.handleEvents));
        webserver.app.post(url + '.well-known/nordic/commands', wrap(obj.handleCommands));
        webserver.app.get(url + 'api/webhooks', wrap(obj.handleWebhooksList));
        webserver.app.post(url + 'api/webhooks', wrap(obj.handleWebhooksCreate));
        webserver.app.delete(url + 'api/webhooks/:id', wrap(obj.handleWebhooksDelete));
    };

    obj.stop = function () { for (var i in obj.trackers) { obj.trackers[i].stop(); } };

    // Listen to everything the server dispatches; HandleEvent picks the few events it needs
    parent.AddEventDispatch(['*'], obj);
    debug('Nordic Byte integration loaded');
    return obj;
};

module.exports.isConfigured = isConfigured;
module.exports.PRODUCT = PRODUCT;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.RETRY_DELAYS = RETRY_DELAYS;
module.exports.safeEqual = safeEqual;
module.exports.signature = signature;
module.exports.sign = sign;
module.exports.verify = verify;
module.exports.envelope = envelope;
module.exports.isoSeconds = isoSeconds;
module.exports.isPrivateAddress = isPrivateAddress;
module.exports.checkDestination = checkDestination;
module.exports.deliver = deliver;
module.exports.createPresenceTracker = createPresenceTracker;
module.exports.createSeenCache = createSeenCache;
module.exports.normalizeShortId = normalizeShortId;
module.exports.parseLink = parseLink;
module.exports.roleAccess = roleAccess;
module.exports.actorId = actorId;
