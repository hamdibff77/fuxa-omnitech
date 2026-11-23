/**
 * api/opcua2pg: OPC UA → PostgreSQL transfer tool integrated into FUXA.
 * Reuses FUXA's bundled node-opcua and pg libraries.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const XLSX = require('xlsx');

let opcua;
// Emplacement historique (plugin FUXA), puis dependance locale du serveur.
try { opcua = require('../../_pkg/runtime/node_modules/node-opcua'); } catch (e) { }
if (!opcua) {
    try { opcua = require('node-opcua'); } catch (e) { }
}

let runtime;
let secureFnc;

/* ------------------------- state ------------------------- */
const opcuaState = { client: null, session: null };
const generator = { server: null, nodes: [], timer: null };
const transfer = { timer: null, busy: false, config: null, lastWrites: {} };
const logs = [];
let logSeq = 0;

const UI_DIR = path.join(__dirname, 'web');
const GEN_DIR = path.join(__dirname, 'generator');

function sendLog(level, message) {
    logs.push({ seq: ++logSeq, level: String(level), message: String(message) });
    if (logs.length > 500) logs.shift();
    if (runtime && runtime.logger) {
        try { runtime.logger.info('[opcua2pg] ' + message); } catch (_) { }
    }
}
function nowText() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ------------------------- helpers ------------------------- */
function pgClient(pg, database) {
    return new Client({
        host: pg.host || 'localhost',
        port: Number(pg.port) || 5432,
        user: pg.user,
        password: pg.password,
        database: database || 'postgres',
        connectionTimeoutMillis: 5000,
        ssl: pg.ssl ? { rejectUnauthorized: false } : undefined
    });
}
function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function tableRef(table) { return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`; }
function isVariable(nc) { return Number(nc) === 2 || String(nc).toLowerCase().includes('variable'); }
function unwrapVariant(value) {
    if (value === undefined || value === null) return null;
    if (Object.prototype.hasOwnProperty.call(value, 'value') &&
        (value.dataType !== undefined || value.arrayType !== undefined)) {
        return value.value === undefined ? null : value.value;
    }
    return value;
}
function convertValue(value, dataType) {
    if (value === undefined || value === null) return null;
    const type = String(dataType || '').toLowerCase();
    if (type.includes('timestamp') || type === 'date') return new Date(value);
    if (type.includes('numeric') || type.includes('int') || type.includes('double') ||
        type.includes('real') || type.includes('decimal') || type.includes('float')) {
        const n = Number(value); return Number.isFinite(n) ? n : null;
    }
    if (type === 'boolean') return Boolean(value);
    if (type === 'json' || type === 'jsonb') return JSON.stringify(value);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}
function opcuaDataType(type) {
    if (!opcua) return null;
    switch (String(type || '').toLowerCase()) {
        case 'boolean': return opcua.DataType.Boolean;
        case 'int': case 'int32': case 'integer': return opcua.DataType.Int32;
        case 'float': case 'double': case 'real': return opcua.DataType.Double;
        default: return opcua.DataType.String;
    }
}
function genPaths() {
    return { config: path.join(GEN_DIR, 'config.json'), settings: path.join(GEN_DIR, 'settings.json') };
}
function readGen() {
    const p = genPaths();
    return {
        config: JSON.parse(fs.readFileSync(p.config, 'utf8')),
        settings: JSON.parse(fs.readFileSync(p.settings, 'utf8'))
    };
}
function endpointUrl(settings) {
    let rp = settings.resourcePath || '/example';
    if (!rp.startsWith('/')) rp = '/' + rp;
    return `opc.tcp://${settings.ip || '127.0.0.1'}:${settings.port || 4000}${rp}`;
}

/* ------------------------- PG ------------------------- */
async function pgDiscover(pg) {
    let c;
    try {
        c = pgClient(pg, 'postgres'); await c.connect();
        const r = await c.query('SELECT datname FROM pg_database WHERE datistemplate=false AND datallowconn ORDER BY datname');
        return { ok: true, databases: r.rows.map(x => x.datname) };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { if (c) await c.end().catch(() => {}); }
}
async function pgTables(pg, database) {
    let c;
    try {
        c = pgClient(pg, database); await c.connect();
        const r = await c.query(`SELECT table_schema AS schema, table_name AS name, table_type AS kind
            FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')
            ORDER BY table_schema, table_name`);
        return { ok: true, tables: r.rows };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { if (c) await c.end().catch(() => {}); }
}
async function pgColumns(pg, database, table) {
    let c;
    try {
        c = pgClient(pg, database); await c.connect();
        const r = await c.query(`SELECT column_name AS name, data_type AS type, is_nullable AS nullable
            FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
            [table.schema, table.name]);
        return { ok: true, columns: r.rows };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { if (c) await c.end().catch(() => {}); }
}
async function pgCount(pg, database, table) {
    let c;
    try {
        c = pgClient(pg, database); await c.connect();
        const r = await c.query(`SELECT count(*)::int AS count FROM ${tableRef(table)}`);
        return { ok: true, count: r.rows[0].count };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { if (c) await c.end().catch(() => {}); }
}
async function pgCreateDatabase(pg, database) {
    let c;
    try {
        c = pgClient(pg, 'postgres'); await c.connect();
        const check = await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]);
        if (check.rowCount > 0) return { ok: true, existed: true, message: `Database "${database}" already exists` };
        await c.query(`CREATE DATABASE ${quoteIdent(database)}`);
        return { ok: true, existed: false, message: `Database "${database}" created` };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { if (c) await c.end().catch(() => {}); }
}
async function pgCreateTable(pg, database, schema, table, columns, addId) {
    let c;
    try {
        c = pgClient(pg, database); await c.connect();
        schema = schema || 'public';
        if (schema !== 'public') await c.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
        const defs = [];
        if (addId) defs.push('id SERIAL PRIMARY KEY');
        defs.push(`${quoteIdent('Date et heure')} timestamp with time zone`);
        const safe = ['timestamp with time zone', 'timestamp without time zone', 'date', 'integer', 'bigint',
            'smallint', 'double precision', 'real', 'numeric(18,4)', 'boolean', 'text', 'varchar(255)', 'jsonb'];
        for (const col of columns || []) {
            const name = String(col.name || '').trim();
            if (!name) continue;
            const lower = name.toLowerCase();
            if (lower === 'date et heure' || (addId && lower === 'id')) continue;
            defs.push(`${quoteIdent(name)} ${safe.includes(col.type) ? col.type : 'text'}`);
        }
        const t = { schema, name: table };
        await c.query(`CREATE TABLE IF NOT EXISTS ${tableRef(t)} (${defs.join(', ')})`);
        await c.query(`ALTER TABLE ${tableRef(t)} ADD COLUMN IF NOT EXISTS ${quoteIdent('Date et heure')} timestamp with time zone`);
        return { ok: true, message: `Table ${schema}.${table} is ready (with "Date et heure")` };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { if (c) await c.end().catch(() => {}); }
}
async function pgAddColumn(pg, database, table, column, type) {
    let c;
    try {
        c = pgClient(pg, database); await c.connect();
        await c.query(`ALTER TABLE ${tableRef(table)} ADD COLUMN IF NOT EXISTS ${quoteIdent(column)} ${type}`);
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { if (c) await c.end().catch(() => {}); }
}

/* ------------------------- OPC UA ------------------------- */
async function opcuaConnect(cfg) {
    try {
        if (!opcua) return { ok: false, error: 'node-opcua library not available' };
        if (opcuaState.session) { await opcuaState.session.close().catch(() => {}); opcuaState.session = null; }
        if (opcuaState.client) { await opcuaState.client.disconnect().catch(() => {}); opcuaState.client = null; }
        const securityMode = cfg.securityMode === 'SignAndEncrypt' ? opcua.MessageSecurityMode.SignAndEncrypt
            : cfg.securityMode === 'Sign' ? opcua.MessageSecurityMode.Sign : opcua.MessageSecurityMode.None;
        const client = opcua.OPCUAClient.create({
            endpointMustExist: false, securityMode,
            securityPolicy: cfg.securityPolicy || opcua.SecurityPolicy.None,
            requestedSessionTimeout: 60000,
            connectionStrategy: { maxRetry: 1, initialDelay: 100, maxDelay: 500 }
        });
        await client.connect(cfg.endpointUrl);
        const session = await client.createSession(cfg.user ? { userName: cfg.user, password: cfg.password || '' } : {});
        opcuaState.client = client; opcuaState.session = session;
        return { ok: true, message: 'Connected to ' + cfg.endpointUrl };
    } catch (e) { return { ok: false, error: e.message }; }
}
async function opcuaBrowse(nodeId) {
    try {
        if (!opcuaState.session) return { ok: false, error: 'Connect to the OPC UA server first' };
        const r = await opcuaState.session.browse(nodeId || 'i=85');
        const seen = new Set(); const nodes = [];
        for (const ref of r.references || []) {
            const id = ref.nodeId.toString();
            if (seen.has(id)) continue;
            seen.add(id);
            nodes.push({ nodeId: id, name: ref.displayName && ref.displayName.text ? ref.displayName.text : id,
                nodeClass: ref.nodeClass, isVariable: isVariable(ref.nodeClass) });
        }
        return { ok: true, nodes };
    } catch (e) { return { ok: false, error: e.message }; }
}
async function opcuaBrowseAll(options) {
    try {
        if (!opcuaState.session) return { ok: false, error: 'Connect to the OPC UA server first' };
        const maxDepth = (options && options.maxDepth) || 6;
        const maxNodes = (options && options.maxNodes) || 3000;
        const visited = new Set(); const variables = [];
        const queue = [{ nodeId: 'i=85', depth: 0 }];
        while (queue.length && visited.size < maxNodes) {
            const cur = queue.shift();
            if (visited.has(cur.nodeId)) continue;
            visited.add(cur.nodeId);
            let r; try { r = await opcuaState.session.browse(cur.nodeId); } catch (_) { continue; }
            for (const ref of r.references || []) {
                const id = ref.nodeId.toString();
                if (visited.has(id)) continue;
                const name = ref.displayName && ref.displayName.text ? ref.displayName.text : id;
                if (isVariable(ref.nodeClass)) variables.push({ nodeId: id, name });
                else if (cur.depth < maxDepth) queue.push({ nodeId: id, depth: cur.depth + 1 });
            }
        }
        return { ok: true, variables, visited: visited.size };
    } catch (e) { return { ok: false, error: e.message }; }
}
async function opcuaRead(nodeIds) {
    try {
        if (!opcuaState.session) return { ok: false, error: 'Not connected' };
        const values = await opcuaState.session.read((nodeIds || []).map(nodeId => ({ nodeId })));
        return { ok: true, values: values.map(v => ({
            value: unwrapVariant(v.value),
            good: !!(v.statusCode && v.statusCode.isGood ? v.statusCode.isGood() : true),
            time: v.sourceTimestamp ? v.sourceTimestamp.toISOString() : null
        })) };
    } catch (e) { return { ok: false, error: e.message }; }
}
async function opcuaDisconnect() {
    try {
        if (opcuaState.session) await opcuaState.session.close().catch(() => {});
        if (opcuaState.client) await opcuaState.client.disconnect().catch(() => {});
        opcuaState.session = null; opcuaState.client = null;
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
}

/* ------------------------- Generator ------------------------- */
async function generatorStart() {
    try {
        if (generator.timer) { clearInterval(generator.timer); generator.timer = null; }
        if (generator.server) { await generator.server.shutdown().catch(() => {}); generator.server = null; }
        if (!opcua) return { ok: false, error: 'node-opcua library not available' };
        const { config, settings } = readGen();
        const port = Number(settings.port) || 4000;
        const server = new opcua.OPCUAServer({ port, resourcePath: settings.resourcePath || '/example',
            buildInfo: { productName: 'Embedded OPC UA Generator', manufacturerName: 'OPCUA to PostgreSQL' } });
        await server.initialize();
        const addressSpace = server.engine.addressSpace;
        const namespace = addressSpace.getOwnNamespace();
        const root = namespace.addFolder(addressSpace.rootFolder.objects, { browseName: settings.rootFolderName || 'example' });
        const groups = {};
        generator.nodes = [];
        let tick = 0;
        for (const tag of config.tags || []) {
            const g = tag.group || 'default';
            if (!groups[g]) groups[g] = namespace.addFolder(root, { browseName: g });
            const dt = opcuaDataType(tag.type);
            let initial = dt === opcua.DataType.Boolean ? false : (dt === opcua.DataType.String ? '' : 0);
            const v = namespace.addVariable({ organizedBy: groups[g], browseName: tag.nom, displayName: tag.nom,
                description: tag.description || '',
                dataType: dt === opcua.DataType.Boolean ? 'Boolean' : dt === opcua.DataType.Double ? 'Double'
                    : dt === opcua.DataType.Int32 ? 'Int32' : 'String' });
            v.setValueFromSource({ dataType: dt, value: initial });
            generator.nodes.push({ variable: v, dataType: dt, tag });
        }
        await server.start();
        generator.server = server;
        generator.timer = setInterval(() => {
            tick++;
            for (const node of generator.nodes) {
                let value;
                if (node.dataType === opcua.DataType.Boolean) value = (tick % 10) < 5;
                else if (node.dataType === opcua.DataType.Double) value = Math.round((tick + (Number(node.tag.identifiant) % 7)) * 100) / 100;
                else if (node.dataType === opcua.DataType.Int32) value = tick + Number(node.tag.identifiant || 0);
                else value = tick % 3 === 0 ? 'OUVERTE' : 'FERMEE';
                try { node.variable.setValueFromSource({ dataType: node.dataType, value }); } catch (_) { }
            }
        }, 1000);
        const url = endpointUrl(settings);
        sendLog('ok', `OPC UA generator started with ${(config.tags || []).length} tags at ${url}`);
        return { ok: true, url, count: (config.tags || []).length };
    } catch (e) { return { ok: false, error: e.message }; }
}
async function generatorStop() {
    try {
        if (generator.timer) { clearInterval(generator.timer); generator.timer = null; }
        if (generator.server) { await generator.server.shutdown().catch(() => {}); generator.server = null; }
        generator.nodes = [];
        sendLog('info', 'OPC UA generator stopped');
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
}
function generatorStatus() {
    try {
        const settings = readGen().settings;
        return { ok: true, running: !!generator.server, count: generator.nodes.length, url: endpointUrl(settings) };
    } catch (e) { return { ok: false, error: e.message }; }
}

/* ------------------------- Transfer ------------------------- */
function mappingKey(m) { return String(m.nodeId) + '|' + String(m.column); }
function buildWrite(config, pairs, dateValue) {
    if (config.mode === 'update') {
        const sets = pairs.map((p, i) => `${quoteIdent(p.mapping.column)} = $${i + 1}`);
        const params = pairs.map(p => p.value);
        let index = pairs.length + 1;
        if (config.timestampColumn) { sets.push(`${quoteIdent(config.timestampColumn)} = $${index}`); params.push(dateValue); index++; }
        const sql = `UPDATE ${tableRef(config.table)} SET ${sets.join(', ')} WHERE ${quoteIdent(config.keyColumn)} = $${index}`;
        params.push(config.keyValue);
        return { sql, params };
    }
    const columns = pairs.map(p => quoteIdent(p.mapping.column));
    const placeholders = pairs.map((_, i) => `$${i + 1}`);
    const params = pairs.map(p => p.value);
    if (config.timestampColumn) { columns.push(quoteIdent(config.timestampColumn)); placeholders.push(`$${columns.length}`); params.push(dateValue); }
    return { sql: `INSERT INTO ${tableRef(config.table)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`, params };
}
async function executeWrite(config, pairs) {
    let c;
    try {
        c = pgClient(config.pg, config.database); await c.connect();
        const q = buildWrite(config, pairs, new Date());
        await c.query(q.sql, q.params);
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { if (c) await c.end().catch(() => {}); }
}
async function runCycle() {
    const config = transfer.config;
    if (!config || transfer.busy) return;
    if (!opcuaState.session) { sendLog('error', 'OPC UA session lost — stop and reconnect'); return; }
    transfer.busy = true;
    try {
        const mappings = config.mappings || [];
        if (!mappings.length) { sendLog('warn', 'No variables mapped'); return; }
        const values = await opcuaState.session.read(mappings.map(m => ({ nodeId: m.nodeId })));
        const pairs = values.map((v, i) => ({ mapping: mappings[i], value: convertValue(unwrapVariant(v && v.value), mappings[i].columnType) }));
        const r = await executeWrite(config, pairs);
        if (!r.ok) { sendLog('error', `[${nowText()}] Transfer error: ${r.error}`); return; }
        sendLog('ok', `[${nowText()}] Written to ${config.database}.${config.table.name}: ` +
            pairs.map(p => `${p.mapping.name}=${p.value}`).join(', '));
    } finally { transfer.busy = false; }
}
async function runDuePairs() {
    const config = transfer.config;
    if (!config || transfer.busy || !opcuaState.session) return;
    const now = Date.now();
    const due = (config.mappings || []).filter(m => {
        const interval = Math.max(200, Number(m.intervalMs) || 2000);
        return now - (transfer.lastWrites[mappingKey(m)] || 0) >= interval;
    });
    if (!due.length) return;
    transfer.busy = true;
    try {
        const values = await opcuaState.session.read(due.map(m => ({ nodeId: m.nodeId })));
        for (let i = 0; i < due.length; i++) {
            const m = due[i];
            const value = convertValue(unwrapVariant(values[i] && values[i].value), m.columnType);
            const r = await executeWrite(config, [{ mapping: m, value }]);
            if (r.ok) {
                transfer.lastWrites[mappingKey(m)] = Date.now();
                sendLog('ok', `[${nowText()}] ${m.name} (${m.intervalMs} ms) → ${config.database}.${config.table.name}.${m.column} = ${value}`);
            } else {
                sendLog('error', `[${nowText()}] ${m.name} error: ${r.error}`);
            }
        }
    } finally { transfer.busy = false; }
}
function transferStopInternal() {
    if (transfer.timer) { clearInterval(transfer.timer); transfer.timer = null; }
}
function transferStart(config) {
    transferStopInternal();
    transfer.config = config;
    transfer.lastWrites = {};
    transfer.timer = setInterval(runDuePairs, 200);
    sendLog('info', `Transfer started with per-tag intervals: ` +
        (config.mappings || []).map(m => `${m.name}=${m.intervalMs}ms`).join(', '));
    return { ok: true };
}

/* ------------------------- Routes ------------------------- */
function register(app) {
    const post = (route, fn) => app.post('/api/opcua2pg/' + route, async (req, res) => {
        try {
            const result = await fn(req.body || {});
            res.json(result);
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    post('pg/discover', b => pgDiscover(b.pg));
    post('pg/tables', b => pgTables(b.pg, b.database));
    post('pg/columns', b => pgColumns(b.pg, b.database, b.table));
    post('pg/count', b => pgCount(b.pg, b.database, b.table));
    post('pg/createDatabase', b => pgCreateDatabase(b.pg, b.database));
    post('pg/createTable', b => pgCreateTable(b.pg, b.database, b.schema, b.table, b.columns, b.addId));
    post('pg/addColumn', b => pgAddColumn(b.pg, b.database, b.table, b.column, b.type));

    post('opcua/connect', b => opcuaConnect(b.cfg));
    post('opcua/browse', b => opcuaBrowse(b.nodeId));
    post('opcua/browseAll', b => opcuaBrowseAll(b.options));
    post('opcua/read', b => opcuaRead(b.nodeIds));
    post('opcua/disconnect', () => opcuaDisconnect());

    // Import OPC UA tag definitions from an Excel (.xlsx) file.
    // Expected columns per the generator rules: nom, type, description, group, identifiant(optionnel)
    // The browser uploads the file as base64 (name + data).
    app.post('/api/opcua2pg/generator/importExcel', (req, res) => {
        try {
            const data = req.body && req.body.data;
            if (!data) return res.status(400).json({ ok:false, error:'No file data received' });
            const buffer = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
            const wb = XLSX.read(buffer, { type: 'buffer' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            if (!ws) return res.json({ ok:false, error:'No worksheet found' });

            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            // Locate the header row that contains "nom" and "type" (case-insensitive).
            let headerIndex = -1;
            for (let i = 0; i < Math.min(rows.length, 20); i++) {
                const cells = rows[i].map(c => String(c).trim().toLowerCase());
                if (cells.includes('nom') && cells.includes('type')) { headerIndex = i; break; }
            }
            if (headerIndex < 0) {
                return res.json({ ok:false, error:'Header row with "nom" and "type" columns not found' });
            }
            const header = rows[headerIndex].map(c => String(c).trim().toLowerCase());
            const col = name => header.findIndex(h => h.replace(/\s|\(.*\)/g, '').includes(name));
            const iNom = col('nom');
            const iType = col('type');
            const iDesc = col('description');
            const iGroup = col('group');
            const iId = (() => { const idx = header.findIndex(h => h.startsWith('identifiant')); return idx; })();

            const normalizeType = raw => {
                const t = String(raw || '').toLowerCase().replace(/\s/g, '');
                if (t.includes('bool')) return 'Boolean';
                if (t.includes('int')) return 'Integer';
                if (t.includes('double') || t.includes('float') || t.includes('numeric') || t.includes('real') || t.includes('decimal')) return 'Float';
                if (t.includes('string') || t.includes('text') || t.includes('char')) return 'String';
                return 'String';
            };

            const tags = [];
            for (let i = headerIndex + 1; i < rows.length; i++) {
                const r = rows[i];
                const nom = r[iNom] !== undefined ? String(r[iNom]).trim() : '';
                if (!nom) continue; // skip empty rows
                tags.push({
                    nom,
                    type: normalizeType(r[iType]),
                    description: iDesc >= 0 ? String(r[iDesc] || '').trim() : '',
                    group: iGroup >= 0 ? String(r[iGroup] || '').trim() : 'default',
                    identifiant: iId >= 0 && r[iId] !== undefined && r[iId] !== '' ? String(r[iId]).trim() : '',
                    source: ''
                });
            }
            if (!tags.length) return res.json({ ok:false, error:'No tag rows found in the sheet' });
            res.json({ ok:true, tags, count: tags.length, sheet: wb.SheetNames[0] });
        } catch (e) {
            res.status(500).json({ ok:false, error: e.message });
        }
    });

    post('generator/start', () => generatorStart());
    post('generator/stop', () => generatorStop());
    app.get('/api/opcua2pg/generator/status', (req, res) => res.json(generatorStatus()));
    app.get('/api/opcua2pg/generator/load', (req, res) => {
        try { const g = readGen(); res.json({ ok: true, config: g.config, settings: g.settings }); }
        catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });
    app.post('/api/opcua2pg/generator/save', (req, res) => {
        try {
            fs.writeFileSync(genPaths().config, JSON.stringify(req.body.config, null, 2), 'utf8');
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    post('transfer/start', b => transferStart(b.config));
    post('transfer/stop', () => { transferStopInternal(); sendLog('info', 'Transfer stopped'); return { ok: true }; });
    post('transfer/once', async b => {
        transfer.config = b.config;
        await runCycle();
        return { ok: true };
    });

    app.get('/api/opcua2pg/logs', (req, res) => {
        const since = Number(req.query.since) || 0;
        res.json({ logs: logs.filter(l => l.seq > since) });
    });

    // Serve the embedded web UI
    app.use('/opcua2pg', express.static(UI_DIR));
}

module.exports = {
    init: function (_runtime, _secureFnc) { runtime = _runtime; secureFnc = _secureFnc; },
    app: function () {
        const app = express();
        register(app);
        return app;
    },
    stop: function () {
        transferStopInternal();
        if (generator.timer) { clearInterval(generator.timer); generator.timer = null; }
        if (generator.server) { generator.server.shutdown().catch(() => {}); generator.server = null; }
    }
};
