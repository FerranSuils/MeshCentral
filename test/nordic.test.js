// Tests for nordic.js (Nordic Byte platform integration). Run with:  node --test test/
// Nothing here opens a socket or touches a data directory: the server is replaced by stubs.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const nordic = require('../nordic.js');

const NODE_A = 'node//' + 'A'.repeat(64), NODE_B = 'node//' + 'B'.repeat(64);
const MESH_1 = 'mesh//' + '1'.repeat(64), MESH_2 = 'mesh//' + '2'.repeat(64);
const UGRP = 'ugrp//acme';
const FULL = 0xFFFFFFFF;

// ---- Stubs ----------------------------------------------------------------------------------

function fakeRes() {
    const res = { statusCode: 200, headers: {}, body: null, done: null };
    res.finished = new Promise(function (r) { res.done = r; });
    res.status = function (c) { res.statusCode = c; return res; };
    res.set = function (k, v) { res.headers[k] = v; return res; };
    res.send = function (b) { res.body = b; res.json = JSON.parse(b); res.done(res); return res; };
    return res;
}

// A server with two device groups, one user group and a handful of accounts.
// The rights functions follow webserver.js: a link (direct or through a user group) makes a
// device visible, its rights are the union of the links.
function fakeServer(nordicConfig) {
    const records = {}, dispatched = [];
    const users = {
        'user//~oidc:100': { _id: 'user//~oidc:100', name: 'Ada', domain: '', links: { [MESH_1]: { rights: FULL } } },          // Administers group 1
        'user//~oidc:200': { _id: 'user//~oidc:200', name: 'Bo', domain: '', links: { [UGRP]: { rights: 1 } } },                 // Sees group 1 through the user group, view only
        'user//~oidc:300': { _id: 'user//~oidc:300', name: 'Cy', domain: '', links: {} },                                        // Sees nothing
        'user//~oidc:400': { _id: 'user//~oidc:400', name: 'Di', domain: '', siteadmin: 32, links: { [MESH_1]: { rights: FULL } } }, // Locked
        'user//~oidc:500': { _id: 'user//~oidc:500', name: 'Ed', domain: '', links: { [NODE_B]: { rights: 8 } } },               // One device of group 2, directly
        'user//admin': { _id: 'user//admin', name: 'admin', domain: '', siteadmin: FULL, links: {} },
        'user//plain': { _id: 'user//plain', name: 'plain', domain: '', links: {} }
    };
    const meshes = {
        [MESH_1]: { _id: MESH_1, name: 'Acme', desc: 'Acme office', mtype: 2, links: { 'user//~oidc:100': { rights: FULL }, [UGRP]: { rights: 256 } } },
        [MESH_2]: { _id: MESH_2, name: 'Other', mtype: 2, links: {} }
    };
    const userGroups = { [UGRP]: { _id: UGRP, name: 'Acme team', links: { 'user//~oidc:200': { rights: 1 }, [MESH_1]: { rights: 256 } } } };
    records[NODE_A] = { _id: NODE_A, type: 'node', name: 'PC-RECEPTION', meshid: MESH_1, domain: '', osdesc: 'Windows 11 Pro' };
    records[NODE_B] = { _id: NODE_B, type: 'node', name: 'SRV-BACKUP', meshid: MESH_2, domain: '', osdesc: 'Debian 12' };
    records['lc' + NODE_B] = { _id: 'lc' + NODE_B, time: Date.UTC(2026, 10, 16, 14, 28, 11) };

    function rightsOn(user, node) {
        var rights = 0, visible = false;
        const add = function (l) { if (l != null) { rights |= l.rights; visible = true; } };
        add(user.links[node._id]); add(user.links[node.meshid]);
        for (var i in user.links) { if (i.startsWith('ugrp/') && userGroups[i]) { add(userGroups[i].links[node.meshid]); add(userGroups[i].links[node._id]); } }
        return { rights: rights >>> 0, visible: visible };
    }
    const parent = {
        config: { settings: {}, domains: { '': { id: '', url: '/', dns: null } } },
        args: { port: 443 },
        certificates: { CommonName: 'mesh.example.com' },
        connectivity: { [NODE_A]: { connectivity: 1 } },
        dispatched: dispatched,
        records: records,
        debug: function () { },
        AddEventDispatch: function (ids, target) { parent.listener = target; },
        DispatchEvent: function (ids, source, event) { dispatched.push(event); },
        GetConnectivityState: function (nodeid) { return parent.connectivity[nodeid]; },
        db: {
            Get: function (id, func) { func(null, (records[id] != null) ? [records[id]] : []); },
            Set: function (doc, func) { records[doc._id] = JSON.parse(JSON.stringify(doc)); if (func) { func(); } },
            SetUser: function (user) { records[user._id] = JSON.parse(JSON.stringify(user)); },
            GetAllTypeNoTypeFieldMeshFiltered: function (meshIds, extra, domain, type, id, skip, limit, func) {
                func(null, Object.keys(records).map(function (k) { return records[k]; }).filter(function (r) { return (r.type == 'node') && (meshIds.indexOf(r.meshid) >= 0); }));
            }
        },
        webserver: {
            users: users, meshes: meshes, userGroups: userGroups,
            GetNodeWithRights: function (domain, user, nodeid, func) {
                const node = records[nodeid];
                if ((user == null) || (node == null) || (node.type != 'node')) { func(null, 0, false); return; }
                const r = rightsOn(user, node);
                if (r.visible) { func(node, r.rights, true); } else { func(null, 0, false); }
            },
            IsMeshViewable: function (user, mesh) {
                if (user.links[mesh._id] != null) { return true; }
                for (var i in user.links) { if (i.startsWith('ugrp/') && userGroups[i] && (userGroups[i].links[mesh._id] != null)) { return true; } }
                return false;
            },
            GetAllMeshIdWithRights: function (user) {
                const r = [];
                for (var i in user.links) {
                    if (i.startsWith('mesh/')) { r.push(i); }
                    if (i.startsWith('ugrp/') && userGroups[i]) { for (var j in userGroups[i].links) { if (j.startsWith('mesh/')) { r.push(j); } } }
                }
                return r;
            },
            CloneSafeUser: function (u) { return JSON.parse(JSON.stringify(u)); },
            CreateMeshDispatchTargets: function (mesh, added) { return ['*', mesh._id].concat(added || []); },
            InvalidateNodeCache: function () { },
            FlushGetNodeRightsCache: function () { }
        }
    };
    if (nordicConfig !== undefined) { parent.config.domains[''].nordic = nordicConfig; }
    return parent;
}

const CONFIG = function () {
    return {
        resolvetoken: 'resolve-token-for-tests', eventssecret: 'events-secret-for-tests', talkbotsecret: 'bot-secret-for-tests',
        graceseconds: 0, startupquietseconds: 0,
        webhooks: [{ url: 'https://hooks.example.com/in', secret: 'whsec-for-tests' }, { url: 'https://only-help.example.com/in', secret: 'other', events: ['device.help_requested'] }],
        spaces: [{ id: 'space-1', usergroup: 'Acme team', meshes: ['Acme'] }]
    };
};

function setup(cfg) {
    const parent = fakeServer((cfg === undefined) ? CONFIG() : cfg);
    const mod = nordic.CreateNordic(parent);
    const sent = [];
    mod.deliver = function (sub, body) { sent.push({ sub: sub, body: JSON.parse(body), raw: body }); return Promise.resolve({ ok: true, status: 200, attempts: 1 }); };
    return { parent: parent, mod: mod, sent: sent, domain: parent.config.domains[''] };
}

function resolveReq(url, user, token) {
    const headers = { host: 'mesh.example.com' };
    if (token !== null) { headers.authorization = 'Bearer ' + ((token === undefined) ? 'resolve-token-for-tests' : token); }
    if (user != null) { headers['x-nordic-user'] = user; }
    return { headers: headers, query: { url: url } };
}
const DEVICE_A = 'https://mesh.example.com/?viewmode=10&gotonode=' + 'A'.repeat(64);
const DEVICE_B = 'https://mesh.example.com/?viewmode=10&gotonode=' + 'B'.repeat(64);
const GROUP_1 = 'https://mesh.example.com/?viewmode=20&gotomesh=' + '1'.repeat(64);

async function resolve(t, url, user, token) { const res = fakeRes(); t.mod.handleResolve(resolveReq(url, user, token), res, t.domain); return res.finished; }

function signedReq(secret, payload, names, opts) {
    opts = opts || {};
    const body = (typeof payload == 'string') ? payload : JSON.stringify(payload);
    const ts = String(opts.timestamp || Math.floor(Date.now() / 1000));
    const headers = {};
    headers[names[0]] = ts;
    headers[names[1]] = opts.signature || nordic.signature(secret, ts, body);
    return { headers: headers, rawBody: opts.body || body };
}
const NORDIC_HEADERS = ['x-nordic-timestamp', 'x-nordic-signature'], TALK_HEADERS = ['x-talk-timestamp', 'x-talk-signature'];
var eventCounter = 0;
function spaceEvent(type, member, spaceId) { return { id: 'evt-' + (++eventCounter), type: type, product: 'talk', space: { id: spaceId || 'space-1' }, actor: null, object: null, data: { member: member }, at: '2026-11-17T10:00:00Z' }; }
async function postEvent(t, payload, opts) { const res = fakeRes(); t.mod.handleEvents(signedReq('events-secret-for-tests', payload, NORDIC_HEADERS, opts), res, t.domain); return res.finished; }
async function postCommand(t, payload, opts) { const res = fakeRes(); t.mod.handleCommands(signedReq('bot-secret-for-tests', payload, TALK_HEADERS, opts), res, t.domain); return res.finished; }
function command(userId, args, spaceId) { return { type: 'command', id: 'c1', command: 'mesh', args: args, space: { id: spaceId || 'space-1' }, channel: { id: '9' }, user: { id: userId, handle: 'x', name: 'X' }, at: '2026-11-17T10:00:00Z' }; }
const tick = function () { return new Promise(function (r) { setImmediate(r); }); };

// ---- Signing and envelope -------------------------------------------------------------------

test('signature is HMAC-SHA256 of "<timestamp>.<body>" in hex', function () {
    const body = '{"id":"1"}';
    const expected = 'sha256=' + crypto.createHmac('sha256', 'secret').update('1794836219.' + body).digest('hex');
    assert.strictEqual(nordic.signature('secret', 1794836219, body), expected);
    assert.deepStrictEqual(nordic.sign('secret', body, 1794836219), { 'X-Nordic-Timestamp': '1794836219', 'X-Nordic-Signature': expected });
});

test('verify accepts a fresh signature and refuses anything else', function () {
    const body = '{"a":1}', now = 1794836219, sig = nordic.signature('secret', now, body);
    assert.strictEqual(nordic.verify('secret', body, String(now), sig, now), true);
    assert.strictEqual(nordic.verify('secret', body, String(now), sig, now + 300), true);
    assert.strictEqual(nordic.verify('secret', body, String(now), sig, now + 301), false, 'stale');
    assert.strictEqual(nordic.verify('secret', body, String(now), sig, now - 301), false, 'from the future');
    assert.strictEqual(nordic.verify('other', body, String(now), sig, now), false, 'wrong secret');
    assert.strictEqual(nordic.verify('secret', body + ' ', String(now), sig, now), false, 'changed body');
    assert.strictEqual(nordic.verify('secret', body, String(now + 1), sig, now), false, 'changed timestamp');
    assert.strictEqual(nordic.verify('secret', body, 'abc', sig, now), false);
    assert.strictEqual(nordic.verify('secret', body, String(now), '', now), false);
    assert.strictEqual(nordic.verify('', body, String(now), nordic.signature('', now, body), now), false, 'no secret configured');
    assert.strictEqual(nordic.verify('secret', body, undefined, undefined, now), false);
});

test('envelope has every field of the contract', function () {
    const e = nordic.envelope('device.online', { object: { type: 'device', id: 'x', url: 'https://m/', title: 'PC' }, at: Date.UTC(2026, 10, 17, 10, 0, 0, 500) });
    assert.deepStrictEqual(Object.keys(e), ['id', 'type', 'product', 'space', 'actor', 'object', 'data', 'at']);
    assert.strictEqual(e.product, 'meshbyte');
    assert.strictEqual(e.space, null);
    assert.strictEqual(e.actor, null);
    assert.deepStrictEqual(e.data, {});
    assert.strictEqual(e.at, '2026-11-17T10:00:00Z');
    assert.match(e.id, /^[0-9a-f]{32}$/);
    assert.notStrictEqual(nordic.envelope('device.online').id, e.id);
});

// ---- Grace period ---------------------------------------------------------------------------

function fakeClock() {
    const c = { t: 1000000, timers: [] };
    c.now = function () { return c.t; };
    c.setTimer = function (f, ms) { const h = { f: f, at: c.t + ms }; c.timers.push(h); return h; };
    c.clearTimer = function (h) { c.timers = c.timers.filter(function (x) { return x !== h; }); };
    c.advance = function (ms) { c.t += ms; const due = c.timers.filter(function (x) { return x.at <= c.t; }); c.timers = c.timers.filter(function (x) { return x.at > c.t; }); due.forEach(function (x) { x.f(); }); };
    return c;
}

test('a device that reconnects within the grace period produces no event', function () {
    const c = fakeClock(), out = [];
    const tr = nordic.createPresenceTracker({ graceMs: 60000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, emit: function (type, id) { out.push(type + ' ' + id); } });
    assert.strictEqual(tr.update('n1', true), 'online');
    assert.strictEqual(tr.update('n1', true), 'same', 'a power state change is not a new connection');
    assert.strictEqual(tr.update('n1', false), 'pending');
    assert.strictEqual(tr.update('n1', false), 'same');
    c.advance(59000);
    assert.strictEqual(tr.update('n1', true), 'kept');
    c.advance(120000);
    assert.deepStrictEqual(out, ['device.online n1']);
    assert.strictEqual(tr.pendingCount(), 0);
});

test('a device that stays away is reported offline once, after the grace period', function () {
    const c = fakeClock(), out = [];
    const tr = nordic.createPresenceTracker({ graceMs: 60000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, emit: function (type, id, info) { out.push([type, id, info && info.since]); } });
    tr.update('n1', true);
    const dropped = c.t;
    tr.update('n1', false);
    c.advance(59999);
    assert.strictEqual(out.length, 1);
    c.advance(1);
    assert.deepStrictEqual(out[1], ['device.offline', 'n1', dropped]);
    assert.strictEqual(tr.update('n1', false), 'same', 'already offline');
    assert.strictEqual(tr.update('n1', true), 'online');
    assert.strictEqual(out.length, 3);
});

test('devices connecting during the start-up quiet time are tracked but not announced', function () {
    const c = fakeClock(), out = [];
    const tr = nordic.createPresenceTracker({ graceMs: 1000, quietMs: 120000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, emit: function (type, id) { out.push(type + ' ' + id); } });
    assert.strictEqual(tr.update('n1', true), 'quiet');
    c.advance(130000);
    assert.strictEqual(tr.update('n2', true), 'online');
    tr.update('n1', false); c.advance(1000);
    assert.deepStrictEqual(out, ['device.online n2', 'device.offline n1']);
});

test('an unknown device going away is ignored, and a grace of 0 reports at once', function () {
    const out = [];
    const tr = nordic.createPresenceTracker({ graceMs: 0, emit: function (type, id) { out.push(type + ' ' + id); } });
    assert.strictEqual(tr.update('n9', false), 'same');
    tr.update('n1', true);
    assert.strictEqual(tr.update('n1', false), 'offline');
    assert.deepStrictEqual(out, ['device.online n1', 'device.offline n1']);
});

// ---- Destinations and delivery --------------------------------------------------------------

test('private, loopback and reserved addresses are recognised', function () {
    ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
        '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:a00:1', 'not-an-ip', ''].forEach(function (a) { assert.strictEqual(nordic.isPrivateAddress(a), true, a); });
    ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'].forEach(function (a) { assert.strictEqual(nordic.isPrivateAddress(a), false, a); });
});

test('a destination must be https and must not resolve to a private network', async function () {
    const to = function (address) { return function (host, opts, cb) { cb(null, [{ address: address, family: 4 }]); }; };
    const ok = await nordic.checkDestination('https://hooks.example.com/in?x=1', { lookup: to('93.184.216.34') });
    assert.strictEqual(ok.address, '93.184.216.34');
    assert.strictEqual(ok.url.pathname, '/in');
    await assert.rejects(nordic.checkDestination('http://hooks.example.com/in', { lookup: to('93.184.216.34') }), /https/);
    await assert.rejects(nordic.checkDestination('ftp://hooks.example.com/in', { lookup: to('93.184.216.34') }), /https/);
    await assert.rejects(nordic.checkDestination('not a url', { lookup: to('93.184.216.34') }), /https/);
    await assert.rejects(nordic.checkDestination('https://user:pw@hooks.example.com/', { lookup: to('93.184.216.34') }), /credentials/);
    await assert.rejects(nordic.checkDestination('https://intranet.example.com/', { lookup: to('10.0.0.5') }), /private/);
    await assert.rejects(nordic.checkDestination('https://mixed.example.com/', { lookup: function (h, o, cb) { cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]); } }), /private/);
    await assert.rejects(nordic.checkDestination('https://gone.example.com/', { lookup: function (h, o, cb) { cb(new Error('ENOTFOUND')); } }), /resolved/);
    await assert.rejects(nordic.checkDestination('https://127.0.0.1/'), /private/);
    await assert.rejects(nordic.checkDestination('https://[::1]/'), /private/);
    const testing = await nordic.checkDestination('http://127.0.0.1:9/x', { allowPrivate: true });
    assert.strictEqual(testing.address, '127.0.0.1');
});

test('delivery signs every attempt and retries after 2, 10 and 60 seconds', async function () {
    const waits = [], calls = [];
    var answers = [500, new Error('ECONNRESET'), 503, 204];
    const hooks = {
        check: function (url) { return Promise.resolve({ url: new URL(url), address: '93.184.216.34', family: 4 }); },
        post: function (target, body, headers) { calls.push(headers); const a = answers.shift(); return (a instanceof Error) ? Promise.reject(a) : Promise.resolve(a); },
        sleep: function (s) { waits.push(s); return Promise.resolve(); }
    };
    const r = await nordic.deliver({ url: 'https://hooks.example.com/in', secret: 's3' }, '{"id":"e"}', hooks);
    assert.deepStrictEqual(r, { ok: true, status: 204, attempts: 4 });
    assert.deepStrictEqual(waits, [2, 10, 60]);
    assert.strictEqual(calls.length, 4);
    calls.forEach(function (h) { assert.strictEqual(nordic.verify('s3', '{"id":"e"}', h['X-Nordic-Timestamp'], h['X-Nordic-Signature']), true); });

    answers = [500, 500, 500, 500, 200];
    const failed = await nordic.deliver({ url: 'https://hooks.example.com/in', secret: 's3' }, '{}', hooks);
    assert.deepStrictEqual(failed, { ok: false, status: 500, attempts: 4 }, 'gives up after the last wait');

    var posted = 0;
    const refused = await nordic.deliver({ url: 'https://intranet/', secret: 's3' }, '{}', { check: function () { return Promise.reject(new Error('The destination cannot be a private network')); }, post: function () { posted++; return Promise.resolve(200); }, sleep: function () { return Promise.resolve(); } });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(posted, 0, 'nothing is sent to a refused destination');
});

// ---- Links ----------------------------------------------------------------------------------

test('device and group links of the web UI are recognised, nothing else', function () {
    const hosts = ['mesh.example.com'];
    assert.deepStrictEqual(nordic.parseLink(DEVICE_A, hosts, '/'), { type: 'device', id: 'A'.repeat(64) });
    assert.deepStrictEqual(nordic.parseLink(GROUP_1, hosts, '/'), { type: 'group', id: '1'.repeat(64) });
    assert.deepStrictEqual(nordic.parseLink('https://MESH.example.com/?gotonode=' + 'A'.repeat(64) + '&viewmode=11&hide=16', hosts, '/'), { type: 'device', id: 'A'.repeat(64) });
    assert.deepStrictEqual(nordic.parseLink('https://mesh.example.com/customer?gotonode=' + 'A'.repeat(64), hosts, '/customer/'), { type: 'device', id: 'A'.repeat(64) });
    const hex = 'ab'.repeat(48);
    assert.strictEqual(nordic.parseLink('https://mesh.example.com/?gotonode=' + hex, hosts, '/').id, Buffer.from(hex, 'hex').toString('base64').replace(/\+/g, '@').replace(/\//g, '$'));
    assert.strictEqual(nordic.parseLink('https://mesh.example.com/?gotonode=' + encodeURIComponent('@$'.repeat(32)), hosts, '/').id, '@$'.repeat(32));
    assert.strictEqual(nordic.parseLink('https://evil.example.org/?gotonode=' + 'A'.repeat(64), hosts, '/'), null, 'another host');
    assert.strictEqual(nordic.parseLink('https://mesh.example.com/other/?gotonode=' + 'A'.repeat(64), hosts, '/'), null, 'another path');
    assert.strictEqual(nordic.parseLink('https://mesh.example.com/?gotonode=short', hosts, '/'), null);
    assert.strictEqual(nordic.parseLink('https://mesh.example.com/?gotonode=' + '../'.repeat(21) + 'x', hosts, '/'), null);
    assert.strictEqual(nordic.parseLink('https://mesh.example.com/', hosts, '/'), null);
    assert.strictEqual(nordic.parseLink('javascript:alert(1)', hosts, '/'), null);
    assert.strictEqual(nordic.parseLink(undefined, hosts, '/'), null);
});

// ---- Link cards: who sees what ---------------------------------------------------------------

test('resolve: 401 without the service token, also when no token is configured', async function () {
    const t = setup();
    assert.strictEqual((await resolve(t, DEVICE_A, '100', null)).statusCode, 401);
    assert.strictEqual((await resolve(t, DEVICE_A, '100', 'wrong')).statusCode, 401);
    assert.strictEqual((await resolve(t, DEVICE_A, '100', '')).statusCode, 401);
    const cfg = CONFIG(); delete cfg.resolvetoken;
    const saved = process.env.NORDIC_RESOLVE_TOKEN; delete process.env.NORDIC_RESOLVE_TOKEN;
    const none = setup(cfg);
    assert.strictEqual((await resolve(none, DEVICE_A, '100', '')).statusCode, 401);
    assert.strictEqual((await resolve(none, DEVICE_A, '100', 'undefined')).statusCode, 401);
    assert.strictEqual((await resolve(none, DEVICE_A, '100', 'null')).statusCode, 401);
    if (saved !== undefined) { process.env.NORDIC_RESOLVE_TOKEN = saved; }
});

test('resolve: 400 without a usable X-Nordic-User', async function () {
    const t = setup();
    assert.strictEqual((await resolve(t, DEVICE_A, null)).statusCode, 400);
    assert.strictEqual((await resolve(t, DEVICE_A, '   ')).statusCode, 400);
    assert.strictEqual((await resolve(t, DEVICE_A, 'a/b')).statusCode, 400);
    assert.strictEqual((await resolve(t, DEVICE_A, 'x'.repeat(300))).statusCode, 400);
});

test('resolve: permission matrix follows the rights of the user', async function () {
    const t = setup();
    const matrix = [
        // user, link, expected status
        ['100', DEVICE_A, 200],   // administers the group
        ['200', DEVICE_A, 200],   // through a user group
        ['300', DEVICE_A, 404],   // no rights
        ['400', DEVICE_A, 404],   // locked account
        ['999', DEVICE_A, 404],   // no such person
        ['500', DEVICE_A, 404],   // rights on another device only
        ['500', DEVICE_B, 200],   // direct device link
        ['100', DEVICE_B, 404],   // another group
        ['100', GROUP_1, 200],
        ['200', GROUP_1, 200],
        ['300', GROUP_1, 404],
        ['500', GROUP_1, 404],
        ['100', 'https://mesh.example.com/?viewmode=20&gotomesh=' + '2'.repeat(64), 404],
        ['100', 'https://mesh.example.com/?gotonode=' + 'Z'.repeat(64), 404],            // unknown device
        ['100', 'https://evil.example.org/?gotonode=' + 'A'.repeat(64), 404],            // another host
        ['100', 'https://mesh.example.com/login', 404],
        ['user//~oidc:100', DEVICE_A, 200],                                              // the product's own user id
        ['user/other/~oidc:100', DEVICE_A, 404]                                          // an id of another domain
    ];
    for (const [user, link, expected] of matrix) {
        const res = await resolve(t, link, user);
        assert.strictEqual(res.statusCode, expected, user + ' ' + link);
        if (expected == 404) { assert.deepStrictEqual(res.json, { error: 'not_found' }, 'a refusal says nothing about the object'); }
    }
});

test('resolve: device card content', async function () {
    const t = setup();
    const a = (await resolve(t, DEVICE_A, '100')).json;
    assert.strictEqual(a.product, 'meshbyte');
    assert.strictEqual(a.type, 'device');
    assert.strictEqual(a.id, 'A'.repeat(64));
    assert.strictEqual(a.url, DEVICE_A);
    assert.strictEqual(a.title, 'PC-RECEPTION');
    assert.strictEqual(a.subtitle, 'Acme · Online');
    assert.deepStrictEqual(a.status, { label: 'Online', tone: 'positive' });
    assert.deepStrictEqual(a.fields.map(function (f) { return f.label; }), ['Group', 'System', 'Last contact']);
    assert.strictEqual(a.fields[1].value, 'Windows 11 Pro');
    assert.deepStrictEqual(a.actions.map(function (x) { return x.id; }), ['open_session', 'open']);
    assert.strictEqual(a.actions[0].url, 'https://mesh.example.com/?viewmode=11&gotonode=' + 'A'.repeat(64));
    assert.match(a.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    const b = (await resolve(t, DEVICE_B, '500')).json;
    assert.deepStrictEqual(b.status, { label: 'Offline', tone: 'neutral' });
    assert.strictEqual(b.updatedAt, '2026-11-16T14:28:11Z', 'last contact of an offline device comes from the last-connect record');
    assert.strictEqual(b.fields[2].value, '2026-11-16T14:28:11Z');

    t.parent.webserver.userGroups[UGRP].links[MESH_1].rights = 4; // Something that is not remote control
    const noControl = (await resolve(t, DEVICE_A, '200')).json;
    assert.deepStrictEqual(noControl.actions.map(function (x) { return x.id; }), ['open'], 'no session action without remote control rights');
});

test('resolve: group card content', async function () {
    const t = setup();
    const g = (await resolve(t, GROUP_1, '100')).json;
    assert.strictEqual(g.type, 'group');
    assert.strictEqual(g.title, 'Acme');
    assert.strictEqual(g.subtitle, 'Acme office');
    assert.deepStrictEqual(g.status, { label: '1 of 1 online', tone: 'positive' });
    assert.deepStrictEqual(g.fields, [{ label: 'Devices', value: '1' }, { label: 'Online', value: '1' }]);
    assert.strictEqual(g.updatedAt, null);
});

// ---- Space membership ------------------------------------------------------------------------

test('events: signature, replay and unknown input', async function () {
    const t = setup();
    const member = { sub: '700', email: 'g@example.com', name: 'Gil', role: 'member' };
    assert.strictEqual((await postEvent(t, spaceEvent('space.member_added', member), { signature: 'sha256=' + '0'.repeat(64) })).statusCode, 401);
    assert.strictEqual((await postEvent(t, spaceEvent('space.member_added', member), { timestamp: Math.floor(Date.now() / 1000) - 301 })).statusCode, 401, 'old timestamp');
    const tampered = spaceEvent('space.member_added', member);
    assert.strictEqual((await postEvent(t, tampered, { body: JSON.stringify(tampered).replace('"member"', '"admin"') })).statusCode, 401, 'body changed after signing');
    assert.strictEqual(t.parent.webserver.users['user//~oidc:700'], undefined, 'nothing was applied');

    assert.strictEqual((await postEvent(t, 'not json')).statusCode, 400);
    assert.strictEqual((await postEvent(t, spaceEvent('space.member_added', member, 'space-unknown'))).statusCode, 202, 'unknown space');
    assert.strictEqual((await postEvent(t, { id: 'x1', type: 'message.posted', space: { id: 'space-1' }, data: {} })).statusCode, 202, 'another type');
    assert.strictEqual((await postEvent(t, spaceEvent('space.member_added', { sub: 'a/b', role: 'member' }))).statusCode, 400);

    const once = spaceEvent('space.member_added', member);
    assert.deepStrictEqual((await postEvent(t, once)).json, { ok: true, result: 'created' });
    assert.deepStrictEqual((await postEvent(t, once)).json, { ok: true, duplicate: true }, 'the same id is applied once');

    const cfg = CONFIG(); delete cfg.eventssecret;
    const saved = process.env.NORDIC_EVENTS_SECRET; delete process.env.NORDIC_EVENTS_SECRET;
    const none = setup(cfg);
    const res = fakeRes(); none.mod.handleEvents(signedReq('', spaceEvent('space.member_added', member), NORDIC_HEADERS), res, none.domain);
    assert.strictEqual((await res.finished).statusCode, 401, 'no secret configured');
    if (saved !== undefined) { process.env.NORDIC_EVENTS_SECRET = saved; }
});

test('events: member, admin, guest and removal map to the user group and the device groups', async function () {
    const t = setup(), w = t.parent.webserver, uid = 'user//~oidc:700';
    const member = function (role) { return { sub: '700', email: 'g@example.com', name: 'Gil', role: role }; };

    await postEvent(t, spaceEvent('space.member_added', member('member')));
    assert.deepStrictEqual(w.users[uid].links, { [UGRP]: { rights: 1 } }, 'a member gets the user group, so the rights of that group');
    assert.strictEqual(w.users[uid].name, 'Gil');
    assert.deepStrictEqual(w.userGroups[UGRP].links[uid], { userid: uid, name: 'Gil', rights: 1 });
    assert.strictEqual(w.meshes[MESH_1].links[uid], undefined);
    assert.strictEqual(t.parent.records[uid].links[UGRP].rights, 1, 'saved');

    await postEvent(t, spaceEvent('space.role_changed', member('admin')));
    assert.deepStrictEqual(w.users[uid].links[MESH_1], { rights: FULL, nordic: 1 }, 'an admin administers the device groups of the space');
    assert.deepStrictEqual(w.meshes[MESH_1].links[uid], { name: 'Gil', rights: FULL, nordic: 1 });
    assert.strictEqual(w.users[uid].links[MESH_2], undefined, 'and no other device group');
    assert.ok(w.users[uid].links[UGRP]);

    await postEvent(t, spaceEvent('space.role_changed', member('member')));
    assert.strictEqual(w.users[uid].links[MESH_1], undefined, 'demoted');
    assert.strictEqual(w.meshes[MESH_1].links[uid], undefined);
    assert.ok(w.users[uid].links[UGRP]);

    await postEvent(t, spaceEvent('space.role_changed', member('owner')));
    assert.strictEqual(w.users[uid].links[MESH_1].rights, FULL);

    await postEvent(t, spaceEvent('space.role_changed', member('guest')));
    assert.deepStrictEqual(w.users[uid].links, {}, 'a guest has nothing');
    assert.strictEqual(w.userGroups[UGRP].links[uid], undefined);
    assert.strictEqual(w.meshes[MESH_1].links[uid], undefined);

    await postEvent(t, spaceEvent('space.member_added', member('admin')));
    assert.deepStrictEqual((await postEvent(t, spaceEvent('space.member_removed', member('admin')))).json, { ok: true, result: 'changed' });
    assert.deepStrictEqual(w.users[uid].links, {});
    assert.ok(w.users[uid], 'the account itself is kept');

    assert.deepStrictEqual((await postEvent(t, spaceEvent('space.member_added', { sub: '800', name: 'Guest', role: 'guest' }))).json, { ok: true, result: 'no_account' });
    assert.strictEqual(w.users['user//~oidc:800'], undefined, 'no account is created for a guest');
});

test('events: links made by hand are never touched, and accounts are not created when provisioning is off', async function () {
    const t = setup(), w = t.parent.webserver;
    // Ada (100) administers group 1 by hand. Removing her from the space must leave that link.
    await postEvent(t, spaceEvent('space.member_added', { sub: '100', name: 'Ada', role: 'admin' }));
    assert.deepStrictEqual(w.users['user//~oidc:100'].links[MESH_1], { rights: FULL }, 'not re-marked');
    await postEvent(t, spaceEvent('space.member_removed', { sub: '100', name: 'Ada', role: 'admin' }));
    assert.deepStrictEqual(w.users['user//~oidc:100'].links[MESH_1], { rights: FULL });
    assert.deepStrictEqual(w.meshes[MESH_1].links['user//~oidc:100'], { rights: FULL });
    assert.strictEqual(w.users['user//~oidc:100'].links[UGRP], undefined);

    const cfg = CONFIG(); cfg.provisionusers = false;
    const off = setup(cfg);
    assert.deepStrictEqual((await postEvent(off, spaceEvent('space.member_added', { sub: '700', name: 'Gil', role: 'member' }))).json, { ok: true, result: 'no_account' });
    assert.strictEqual(off.parent.webserver.users['user//~oidc:700'], undefined);

    const missing = CONFIG(); missing.spaces[0].usergroup = 'No such group';
    const m = setup(missing);
    assert.deepStrictEqual((await postEvent(m, spaceEvent('space.member_added', { sub: '300', name: 'Cy', role: 'member' }))).json, { ok: true, result: 'usergroup_missing' });
});

// ---- Commands --------------------------------------------------------------------------------

test('commands: signature is checked with the Talk bot secret', async function () {
    const t = setup();
    assert.strictEqual((await postCommand(t, command('100', 'PC-RECEPTION'), { signature: 'sha256=bad' })).statusCode, 401);
    assert.strictEqual((await postCommand(t, command('100', 'PC-RECEPTION'), { timestamp: Math.floor(Date.now() / 1000) + 400 })).statusCode, 401);
    const res = fakeRes(); t.mod.handleCommands(signedReq('events-secret-for-tests', command('100', 'PC-RECEPTION'), TALK_HEADERS), res, t.domain);
    assert.strictEqual((await res.finished).statusCode, 401, 'the events secret does not sign commands');
    assert.strictEqual((await postCommand(t, 'not json')).statusCode, 400);
});

test('commands: /mesh answers with the device card and a session link, for devices the person can see', async function () {
    const t = setup();
    const ok = await postCommand(t, command('100', 'pc-reception'));
    assert.strictEqual(ok.statusCode, 200);
    assert.match(ok.json.text, /^PC-RECEPTION · Online\n/);
    assert.match(ok.json.text, /System: Windows 11 Pro/);
    assert.ok(ok.json.text.endsWith('Open remote session: https://mesh.example.com/?viewmode=11&gotonode=' + 'A'.repeat(64)));
    assert.strictEqual(ok.json.card.type, 'device');

    assert.match((await postCommand(t, command('200', ['pc-recep']))).json.text, /^PC-RECEPTION/, 'part of the name, through a user group');

    const none = 'No device named "PC-RECEPTION" that you can open in this space.';
    assert.strictEqual((await postCommand(t, command('300', 'PC-RECEPTION'))).json.text, none, 'no rights');
    assert.strictEqual((await postCommand(t, command('400', 'PC-RECEPTION'))).json.text.indexOf('no MeshByte account'), 9, 'locked account');
    assert.match((await postCommand(t, command('999', 'PC-RECEPTION'))).json.text, /no MeshByte account/);
    assert.strictEqual((await postCommand(t, command('100', 'NOPE'))).json.text, 'No device named "NOPE" that you can open in this space.');
    assert.strictEqual((await postCommand(t, command('500', 'SRV-BACKUP'))).json.text, 'No device named "SRV-BACKUP" that you can open in this space.', 'a device of a group outside this space is not shown here');
    assert.strictEqual((await postCommand(t, command('100', 'PC-RECEPTION', 'space-2'))).json.text, 'This space is not connected to MeshByte.');
    assert.strictEqual((await postCommand(t, command('100', ''))).json.text, 'Usage: /mesh <device>');
    const other = command('100', 'x'); other.command = 'vault';
    assert.match((await postCommand(t, other)).json.text, /Unknown command/);

    t.parent.records['node//' + 'C'.repeat(64)] = { _id: 'node//' + 'C'.repeat(64), type: 'node', name: 'PC-RECEPTION-2', meshid: MESH_1, domain: '' };
    assert.match((await postCommand(t, command('100', 'PC-RECEP'))).json.text, /^Several devices match: PC-RECEPTION, PC-RECEPTION-2\./);
    assert.match((await postCommand(t, command('100', 'PC-RECEPTION'))).json.text, /^PC-RECEPTION · Online/, 'an exact name wins');
});

// ---- Outbound events from the server's own event stream -------------------------------------

test('server events become signed envelopes for the subscriptions that want them', async function () {
    const t = setup();
    assert.strictEqual(t.parent.listener, t.mod, 'listens to the event dispatch');

    t.mod.HandleEvent(null, { action: 'nodeconnect', meshid: MESH_1, nodeid: NODE_A, domain: '', conn: 1, pwr: 1 });
    t.mod.HandleEvent(null, { action: 'nodeconnect', meshid: MESH_1, nodeid: NODE_A, domain: '', conn: 1, pwr: 2 }); // Power change only
    await tick();
    assert.strictEqual(t.sent.length, 1);
    const online = t.sent[0].body;
    assert.strictEqual(t.sent[0].sub.url, 'https://hooks.example.com/in', 'the subscription limited to help requests gets nothing');
    assert.strictEqual(online.type, 'device.online');
    assert.strictEqual(online.product, 'meshbyte');
    assert.deepStrictEqual(online.space, { id: 'space-1' }, 'space from the device group mapping');
    assert.strictEqual(online.actor, null);
    assert.deepStrictEqual(online.object, { type: 'device', id: 'A'.repeat(64), url: DEVICE_A, title: 'PC-RECEPTION' });
    assert.strictEqual(online.data.group, 'Acme');

    t.mod.HandleEvent(null, { action: 'nodeconnect', meshid: MESH_1, nodeid: NODE_A, domain: '', conn: 0, pwr: 0 });
    await tick();
    assert.strictEqual(t.sent[1].body.type, 'device.offline');
    assert.match(t.sent[1].body.data.since, /Z$/);

    t.mod.HandleEvent(null, { action: 'nodeconnect', meshid: MESH_2, nodeid: NODE_B, domain: '', conn: 1 });
    await tick();
    assert.strictEqual(t.sent[2].body.space, null, 'a device group without a space');

    t.sent.length = 0;
    t.mod.HandleEvent(null, { action: 'agentlog', nodeid: NODE_A, domain: '', msgid: 98, msgArgs: ['maria', 'The printer does not work'] });
    t.mod.HandleEvent(null, { action: 'agentlog', nodeid: NODE_A, domain: '', msgid: 5, msgArgs: [] });
    await tick();
    assert.deepStrictEqual(t.sent.map(function (s) { return s.sub.url; }).sort(), ['https://hooks.example.com/in', 'https://only-help.example.com/in']);
    assert.strictEqual(t.sent[0].body.type, 'device.help_requested');
    assert.deepStrictEqual(t.sent[0].body.data, { group: 'Acme', user: 'maria', message: 'The printer does not work' });
    assert.strictEqual(t.sent[0].raw, t.sent[1].raw, 'one event, the same id for every subscription');

    t.sent.length = 0;
    const relay = function (msgid, args) { return { etype: 'relay', action: 'relaylog', domain: '', userid: 'user//~oidc:100', username: 'Ada', msgid: msgid, msgArgs: args, nodeid: NODE_A }; };
    t.mod.HandleEvent(null, relay(15, ['sess1', '1.2.3.4', '5.6.7.8']));
    t.mod.HandleEvent(null, relay(11, ['sess1', '1.2.3.4', '5.6.7.8', 42]));
    t.mod.HandleEvent(null, relay(11, ['sess1', '5.6.7.8', '1.2.3.4', 42])); // The other side closing
    t.mod.HandleEvent(null, relay(999, ['sess1']));
    t.mod.HandleEvent(null, { action: 'relaylog', domain: '', msgid: 15, msgArgs: ['sess2'] }); // No device
    t.mod.HandleEvent(null, 'resubscribe');
    t.mod.HandleEvent(null, null);
    await tick();
    assert.deepStrictEqual(t.sent.map(function (s) { return s.body.type; }), ['session.started', 'session.ended']);
    assert.deepStrictEqual(t.sent[0].body.actor, { id: '100', name: 'Ada' }, 'the actor is the Talk sub');
    assert.deepStrictEqual(t.sent[0].body.data, { group: 'Acme', session: 'sess1', kind: 'desktop' });
    assert.deepStrictEqual(t.sent[1].body.data, { group: 'Acme', session: 'sess1', kind: 'desktop', seconds: 42 });
    assert.ok(JSON.stringify(t.sent).indexOf('1.2.3.4') < 0, 'addresses do not leave the server');
});

test('device.offline waits for the configured grace period', async function () {
    const cfg = CONFIG(); cfg.graceseconds = 3600;
    const t = setup(cfg);
    t.mod.HandleEvent(null, { action: 'nodeconnect', meshid: MESH_1, nodeid: NODE_A, domain: '', conn: 1 });
    t.mod.HandleEvent(null, { action: 'nodeconnect', meshid: MESH_1, nodeid: NODE_A, domain: '', conn: 0 });
    await tick();
    assert.deepStrictEqual(t.sent.map(function (s) { return s.body.type; }), ['device.online']);
    assert.strictEqual(t.mod.trackers[''].pendingCount(), 1);
    t.mod.HandleEvent(null, { action: 'nodeconnect', meshid: MESH_1, nodeid: NODE_A, domain: '', conn: 1 });
    await tick();
    assert.strictEqual(t.mod.trackers[''].pendingCount(), 0);
    assert.strictEqual(t.sent.length, 1, 'back within the grace period: nothing is sent');
    t.mod.stop();
});

// ---- Subscription API ------------------------------------------------------------------------

test('webhooks API: site administrators only, the secret is shown once', async function () {
    const t = setup();
    const call = async function (handler, req) { const res = fakeRes(); t.mod[handler](Object.assign({ headers: { host: 'mesh.example.com', 'content-type': 'application/json' } }, req), res, t.domain); return res.finished; };
    const admin = { userid: 'user//admin' };

    assert.strictEqual((await call('handleWebhooksList', {})).statusCode, 401);
    assert.strictEqual((await call('handleWebhooksList', { session: { userid: 'user//plain' } })).statusCode, 401);
    assert.strictEqual((await call('handleWebhooksCreate', { session: { userid: 'user//~oidc:100' }, rawBody: '{"url":"https://93.184.216.34/h"}' })).statusCode, 401, 'a device group administrator is not a site administrator');

    const before = (await call('handleWebhooksList', { session: admin })).json.webhooks;
    assert.strictEqual(before.length, 2);
    assert.strictEqual(JSON.stringify(before).indexOf('whsec-for-tests'), -1, 'config secrets are never listed');

    assert.strictEqual((await call('handleWebhooksCreate', { session: admin, rawBody: '{"url":"https://10.0.0.8/h"}' })).statusCode, 400, 'private destination');
    assert.strictEqual((await call('handleWebhooksCreate', { session: admin, rawBody: '{"url":"http://93.184.216.34/h"}' })).statusCode, 400, 'not https');
    assert.strictEqual((await call('handleWebhooksCreate', { session: admin, rawBody: '{"url":"https://93.184.216.34/h"}', headers: { host: 'mesh.example.com', 'content-type': 'application/json', origin: 'https://evil.example.org' } })).statusCode, 403, 'another origin');
    assert.strictEqual((await call('handleWebhooksCreate', { session: admin, rawBody: 'url=https://93.184.216.34/h', headers: { host: 'mesh.example.com', 'content-type': 'application/x-www-form-urlencoded' } })).statusCode, 403, 'a form post');

    const created = await call('handleWebhooksCreate', { session: admin, rawBody: JSON.stringify({ url: 'https://93.184.216.34/h', events: ['device.offline', 'nonsense'], name: 'Talk #support' }) });
    assert.strictEqual(created.statusCode, 201);
    assert.match(created.json.secret, /^mbw_[A-Za-z0-9_-]{43}$/);
    assert.deepStrictEqual(created.json.events, ['device.offline']);
    assert.strictEqual(created.json.name, 'Talk #support');
    assert.strictEqual(t.parent.records['nordicwebhooks/'].subs.length, 1, 'stored in the database');

    const after = (await call('handleWebhooksList', { session: admin })).json.webhooks;
    assert.strictEqual(after.length, 3);
    assert.strictEqual(JSON.stringify(after).indexOf(created.json.secret), -1, 'never again');

    t.mod.HandleEvent(null, { action: 'nodeconnect', meshid: MESH_1, nodeid: NODE_A, domain: '', conn: 1 });
    t.mod.HandleEvent(null, { action: 'nodeconnect', meshid: MESH_1, nodeid: NODE_A, domain: '', conn: 0 });
    await tick();
    const mine = t.sent.filter(function (s) { return s.sub.id == created.json.id; });
    assert.deepStrictEqual(mine.map(function (s) { return s.body.type; }), ['device.offline'], 'signed with its own secret, only the events it asked for');
    assert.strictEqual(mine[0].sub.secret, created.json.secret);

    assert.strictEqual((await call('handleWebhooksDelete', { session: admin, params: { id: 'nope' } })).statusCode, 404);
    assert.strictEqual((await call('handleWebhooksDelete', { session: { userid: 'user//plain' }, params: { id: created.json.id } })).statusCode, 401);
    assert.strictEqual((await call('handleWebhooksDelete', { session: admin, params: { id: created.json.id } })).statusCode, 200);
    assert.strictEqual((await call('handleWebhooksList', { session: admin })).json.webhooks.length, 2);

    const cfg = CONFIG(); cfg.webhooksapi = false;
    const off = setup(cfg);
    const res = fakeRes(); off.mod.handleWebhooksList({ headers: {}, session: admin }, res, off.domain);
    assert.strictEqual((await res.finished).statusCode, 404, 'switched off in the configuration');
});

// ---- Inert without configuration -------------------------------------------------------------

test('nothing is loaded or answered without a "nordic" section', async function () {
    assert.strictEqual(nordic.isConfigured({ settings: {}, domains: { '': { title: 'x' } } }), false);
    assert.strictEqual(nordic.isConfigured({ settings: {}, domains: { '': {}, customer: { nordic: {} } } }), true);
    assert.strictEqual(nordic.isConfigured({ settings: { nordic: {} }, domains: { '': {} } }), true);
    assert.strictEqual(nordic.isConfigured(null), false);

    // A second domain without the section stays silent even when the module is loaded for another one
    const t = setup();
    t.parent.config.domains.plain = { id: 'plain', url: '/plain/' };
    const routes = {};
    const app = { get: function (p, h) { routes['GET ' + p] = h; }, post: function (p, h) { routes['POST ' + p] = h; }, delete: function (p, h) { routes['DELETE ' + p] = h; } };
    t.mod.setupHttpHandlers({ app: app }, '/plain/', function () { return t.parent.config.domains.plain; });
    assert.deepStrictEqual(Object.keys(routes).sort(), ['DELETE /plain/api/webhooks/:id', 'GET /plain/.well-known/nordic/resolve', 'GET /plain/api/webhooks', 'POST /plain/.well-known/nordic/commands', 'POST /plain/.well-known/nordic/events', 'POST /plain/api/webhooks']);
    for (const r in routes) { const res = fakeRes(); routes[r](resolveReq(DEVICE_A, '100'), res); assert.strictEqual((await res.finished).statusCode, 404, r); }
    t.mod.HandleEvent(null, { action: 'nodeconnect', meshid: 'mesh/plain/x', nodeid: 'node/plain/x', domain: 'plain', conn: 1 });
    await tick();
    assert.strictEqual(t.sent.length, 0);
});

// ---- Through a real HTTP stack (express on a loopback port) ---------------------------------

test('the routes work through express: raw body, headers and status codes', async function (ctx) {
    var express = null;
    try { express = require('express'); } catch (ex) { ctx.skip('express is not installed'); return; }
    const t = setup(), app = express();
    t.mod.setupHttpHandlers({ app: app }, '/', function () { return t.domain; });
    const server = await new Promise(function (r) { const s = app.listen(0, '127.0.0.1', function () { r(s); }); });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        // Link card
        const card = await fetch(base + '/.well-known/nordic/resolve?url=' + encodeURIComponent(DEVICE_A), { headers: { authorization: 'Bearer resolve-token-for-tests', 'x-nordic-user': '100', host: 'mesh.example.com' } });
        assert.strictEqual(card.status, 200);
        assert.match(card.headers.get('content-type'), /^application\/json/);
        assert.strictEqual((await card.json()).title, 'PC-RECEPTION');
        assert.strictEqual((await fetch(base + '/.well-known/nordic/resolve?url=' + encodeURIComponent(DEVICE_A), { headers: { 'x-nordic-user': '100' } })).status, 401);
        assert.strictEqual((await fetch(base + '/.well-known/nordic/resolve?url=' + encodeURIComponent(DEVICE_A), { headers: { authorization: 'Bearer resolve-token-for-tests', 'x-nordic-user': '300' } })).status, 404);

        // Signed event, the signature covers the exact bytes that were sent
        const body = JSON.stringify(spaceEvent('space.member_added', { sub: '900', name: 'Zoë Ñandú', email: 'z@example.com', role: 'member' }));
        const good = await fetch(base + '/.well-known/nordic/events', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, nordic.sign('events-secret-for-tests', body)), body: body });
        assert.strictEqual(good.status, 200);
        assert.deepStrictEqual(await good.json(), { ok: true, result: 'created' });
        assert.strictEqual(t.parent.webserver.users['user//~oidc:900'].name, 'Zoë Ñandú');
        const bad = await fetch(base + '/.well-known/nordic/events', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, nordic.sign('events-secret-for-tests', body)), body: body + ' ' });
        assert.strictEqual(bad.status, 401);
        const unsigned = await fetch(base + '/.well-known/nordic/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body });
        assert.strictEqual(unsigned.status, 401);
        const huge = 'x'.repeat(70000);
        const big = await fetch(base + '/.well-known/nordic/events', { method: 'POST', headers: nordic.sign('events-secret-for-tests', huge), body: huge });
        assert.strictEqual(big.status, 413);

        // Talk command
        const cmd = JSON.stringify(command('100', 'PC-RECEPTION')), ts = String(Math.floor(Date.now() / 1000));
        const answer = await fetch(base + '/.well-known/nordic/commands', { method: 'POST', headers: { 'content-type': 'application/json', 'x-talk-timestamp': ts, 'x-talk-signature': nordic.signature('bot-secret-for-tests', ts, cmd) }, body: cmd });
        assert.strictEqual(answer.status, 200);
        assert.match((await answer.json()).text, /Open remote session: https:\/\/mesh\.example\.com\//);

        // Subscription API without a session
        assert.strictEqual((await fetch(base + '/api/webhooks')).status, 401);
        assert.strictEqual((await fetch(base + '/api/webhooks/abc', { method: 'DELETE' })).status, 401);
    } finally {
        server.closeAllConnections();
        await new Promise(function (r) { server.close(r); });
    }
});
