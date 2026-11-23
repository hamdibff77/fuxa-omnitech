// Web client for the integrated OPC UA → PostgreSQL tool.
// Calls the FUXA REST API at /api/opcua2pg/*
const BASE = '/api/opcua2pg/';

async function api(action, body) {
    const options = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetch(BASE + action, options);
    return response.json();
}

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const state = {
    pg: null, databases: [], database: null, tables: [], table: null, columns: [],
    opcuaConnected: false, genConfig: { tags: [] }, genSettings: {},
    allVariables: new Map(), selected: new Map(), mappings: [], checkboxes: new Map(),
    lastLogSeq: 0
};

function setMsg(id, text, cls = '') { const e = $(id); e.textContent = text || ''; e.className = 'msg ' + cls; }
function log(level, message) {
    const line = document.createElement('div');
    line.className = 'log-line ' + level;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    $('logBox').appendChild(line);
    $('logBox').scrollTop = $('logBox').scrollHeight;
}
function setPill(id, connected, label) {
    const e = $(id);
    e.textContent = label + ': ' + (connected ? 'connected' : 'disconnected');
    e.className = 'pill ' + (connected ? 'pill-green' : 'pill-gray');
}
function readPg() {
    return { host: $('pgHost').value.trim() || 'localhost', port: Number($('pgPort').value) || 5432,
        user: $('pgUser').value.trim(), password: $('pgPassword').value, ssl: $('pgSsl').checked };
}
function readOpcua() {
    return { endpointUrl: $('opcUrl').value.trim(), securityMode: $('opcSecMode').value,
        securityPolicy: $('opcSecPolicy').value || 'None', user: $('opcUser').value.trim(), password: $('opcPassword').value };
}

/* ---------------- generator ---------------- */
const GEN_TYPES = ['Boolean', 'Float', 'String', 'Integer'];
function renderGenTags() {
    const body = $('genTagsBody'); body.innerHTML = '';
    (state.genConfig.tags || []).forEach((tag, index) => {
        const row = document.createElement('tr');
        const fields = [
            { key: 'nom', type: 'text' }, { key: 'type', type: 'select', options: GEN_TYPES },
            { key: 'group', type: 'text' }, { key: 'identifiant', type: 'text' }, { key: 'description', type: 'text' }
        ];
        fields.forEach(field => {
            const cell = document.createElement('td');
            let input;
            if (field.type === 'select') {
                input = document.createElement('select');
                field.options.forEach(o => { const op = document.createElement('option'); op.value = o; op.textContent = o; input.appendChild(op); });
                input.value = tag[field.key] || 'String';
            } else { input = document.createElement('input'); input.type = 'text'; input.value = tag[field.key] || ''; }
            input.addEventListener('change', () => { tag[field.key] = input.value; });
            cell.appendChild(input); row.appendChild(cell);
        });
        const rc = document.createElement('td');
        const rm = document.createElement('button'); rm.className = 'remove-row'; rm.textContent = '×'; rm.title = 'Remove';
        rm.addEventListener('click', () => { state.genConfig.tags.splice(index, 1); renderGenTags(); });
        rc.appendChild(rm); row.appendChild(rc); body.appendChild(row);
    });
}
function genEndpointUrl() {
    const s = state.genSettings || {};
    let rp = s.resourcePath || '/example'; if (!rp.startsWith('/')) rp = '/' + rp;
    return `opc.tcp://${s.ip || '127.0.0.1'}:${s.port || 4000}${rp}`;
}
async function loadGenerator() {
    const r = await api('generator/load');
    if (!r.ok) { setMsg('genMsg', r.error, 'error'); return; }
    state.genConfig = r.config || { tags: [] }; state.genSettings = r.settings || {};
    $('genUrl').textContent = genEndpointUrl(); renderGenTags();
    const st = await api('generator/status');
    if (st.ok && st.running) { $('genStatus').textContent = 'running'; $('genStatus').style.color = 'var(--green)';
        $('btnGenStart').disabled = true; $('btnGenStop').disabled = false; }
}
$('btnGenAddTag').addEventListener('click', () => { state.genConfig.tags.push({ nom:'', type:'Float', group:'', identifiant:'', description:'' }); renderGenTags(); });
$('btnGenImportExcel').addEventListener('click', () => $('genExcelFile').click());
$('genExcelFile').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setMsg('genMsg', 'Importing Excel…');
    const reader = new FileReader();
    reader.onload = async () => {
        const result = await api('generator/importExcel', { name: file.name, data: reader.result });
        if (!result.ok) { setMsg('genMsg', result.error, 'error'); log('error', 'Excel import failed: ' + result.error); return; }
        state.genConfig.tags = result.tags;
        renderGenTags();
        setMsg('genMsg', `Imported ${result.count} tag(s) from ${result.sheet}`, 'ok');
        log('ok', `Excel import: ${result.count} tag(s) from sheet ${result.sheet}`);
    };
    reader.onerror = () => { setMsg('genMsg', 'Could not read the file', 'error'); };
    reader.readAsDataURL(file);
    event.target.value = '';
});
$('btnGenSave').addEventListener('click', async () => {
    const r = await api('generator/save', { config: state.genConfig });
    setMsg('genMsg', r.ok ? 'Tags saved' : r.error, r.ok ? 'ok' : 'error');
    if (r.ok) log('ok', 'Generator tag configuration saved');
});
$('btnGenReload').addEventListener('click', async () => { await loadGenerator(); setMsg('genMsg', 'Reloaded from file', 'ok'); });
$('btnGenUseUrl').addEventListener('click', () => { $('opcUrl').value = genEndpointUrl(); setMsg('genMsg', 'Endpoint copied to OPC UA connection', 'ok'); });
$('btnGenStart').addEventListener('click', async () => {
    setMsg('genMsg', 'Starting generator…');
    // Save latest tag edits first
    await api('generator/save', { config: state.genConfig });
    const r = await api('generator/start', {});
    if (!r.ok) { setMsg('genMsg', r.error, 'error'); return; }
    setMsg('genMsg', `${r.count} tag(s) running`, 'ok');
    $('genStatus').textContent = 'running'; $('genStatus').style.color = 'var(--green)';
    $('btnGenStart').disabled = true; $('btnGenStop').disabled = false;
    $('opcUrl').value = r.url;
});
$('btnGenStop').addEventListener('click', async () => {
    const r = await api('generator/stop', {});
    if (!r.ok) { setMsg('genMsg', r.error, 'error'); return; }
    setMsg('genMsg', 'Generator stopped', 'ok');
    $('genStatus').textContent = 'stopped'; $('genStatus').style.color = '';
    $('btnGenStart').disabled = false; $('btnGenStop').disabled = true;
});

/* ---------------- PostgreSQL ---------------- */
function selectDatabase(db) {
    state.database = db; state.table = null; state.columns = [];
    $('tableTitle').textContent = 'selected table';
    $('tableList').innerHTML = '<span class="muted">Loading tables…</span>';
    $('columnList').innerHTML = '<span class="muted">Select a table</span>';
    renderChips('dbList', state.databases.map(d => ({ label:d, value:d })), state.database, selectDatabase);
    loadTables();
}
$('btnPgDiscover').addEventListener('click', async () => {
    state.pg = readPg(); setMsg('pgMsg', 'Discovering…');
    const r = await api('pg/discover', { pg: state.pg });
    if (!r.ok) { setMsg('pgMsg', r.error, 'error'); setPill('pgStatus', false, 'PostgreSQL'); return; }
    state.databases = r.databases || [];
    renderChips('dbList', state.databases.map(db => ({ label:db, value:db })), state.database, selectDatabase);
    // also fill the Create-destination database selector
    const sel = $('existingDbSelect'); sel.innerHTML = '<option value="">— select existing —</option>';
    state.databases.forEach(db => { const o=document.createElement('option'); o.value=db; o.textContent=db; sel.appendChild(o); });
    const dl = $('dbNames'); dl.innerHTML='';
    state.databases.forEach(db => { const o=document.createElement('option'); o.value=db; dl.appendChild(o); });
    setMsg('pgMsg', `${state.databases.length} database(s) found`, 'ok');
    log('info', `PostgreSQL databases: ${state.databases.join(', ')}`);
});
function renderChips(containerId, items, active, onClick) {
    const c = $(containerId); c.classList.remove('empty'); c.innerHTML = '';
    if (!items.length) { c.textContent = 'None found'; return; }
    items.forEach(item => {
        const chip = document.createElement('button');
        chip.className = 'chip' + (item.value === active ? ' active' : '');
        chip.textContent = item.label; chip.addEventListener('click', () => onClick(item.value)); c.appendChild(chip);
    });
}
async function loadTables() {
    const r = await api('pg/tables', { pg: state.pg, database: state.database });
    if (!r.ok) { setMsg('pgMsg', r.error, 'error'); return; }
    state.tables = r.tables || [];
    renderChips('tableList', state.tables.map(t => ({ label:`${t.schema}.${t.name}${t.kind === 'VIEW' ? ' (view)' : ''}`, value:t })),
        state.table ? `${state.table.schema}.${state.table.name}` : null, t => { state.table = t; loadColumns(); });
}
async function loadColumns() {
    const r = await api('pg/columns', { pg: state.pg, database: state.database, table: state.table });
    if (!r.ok) { setMsg('pgMsg', r.error, 'error'); return; }
    state.columns = r.columns || [];
    $('tableTitle').textContent = `${state.database}.${state.table.schema}.${state.table.name}`;
    const list = $('columnList'); list.classList.remove('empty'); list.innerHTML = '';
    state.columns.forEach(col => { const s = document.createElement('span'); s.className = 'colitem';
        s.innerHTML = `<b>${esc(col.name)}</b> ${esc(col.type)}`; list.appendChild(s); });
    const fill = (id, empty, sel) => { const e = $(id); e.innerHTML = `<option value="">${empty}</option>`;
        state.columns.forEach(c => { const o = document.createElement('option'); o.value = c.name; o.textContent = `${c.name} (${c.type})`; e.appendChild(o); });
        if (sel) e.value = sel; };
    const auto = state.columns.find(c => c.name === 'Date et heure');
    const tsDef = auto ? auto.name : ((state.columns.find(c => String(c.type).includes('timestamp')) || {}).name || '');
    fill('timestampColumn', 'None', $('timestampColumn').value || tsDef);
    fill('keyColumn', 'Select…', $('keyColumn').value || (state.columns[0] || {}).name || '');
    fill('pairColumn', '— select a column —', '');
    state.mappings.forEach(m => { if (!state.columns.some(c => c.name === m.column)) {
        m.column = (state.columns[0] || {}).name || ''; m.columnType = (state.columns[0] || {}).type || ''; } });
    renderMapping(); refreshPairSelectors();
    log('info', `Loaded ${state.columns.length} column(s) from ${state.table.schema}.${state.table.name}`);
}
$('btnAddTsColumn').addEventListener('click', async () => {
    if (!state.pg || !state.database || !state.table) { setMsg('pgMsg', 'Select a database and table first', 'error'); return; }
    const name = $('newTsColumn').value.trim(); if (!name) return;
    const r = await api('pg/addColumn', { pg:state.pg, database:state.database, table:state.table, column:name, type:'timestamp with time zone' });
    if (!r.ok) { setMsg('pgMsg', r.error, 'error'); return; }
    setMsg('pgMsg', `Column "${name}" created`, 'ok'); $('timestampColumn').value = name; await loadColumns();
});

/* ---------------- designer ---------------- */
const COLUMN_TYPES = ['timestamp with time zone','timestamp without time zone','date','integer','bigint','smallint','double precision','real','numeric(18,4)','boolean','text','varchar(255)','jsonb'];
function addDesignerColumn(name='', type='double precision') {
    const c = $('designerColumns'); const row = document.createElement('div'); row.className = 'designer-row';
    const nl = document.createElement('label'); nl.textContent='Column name'; const ni=document.createElement('input'); ni.type='text'; ni.value=name; ni.placeholder='e.g. Temperature'; nl.appendChild(ni);
    const tl = document.createElement('label'); tl.textContent='Type'; const ts=document.createElement('select');
    COLUMN_TYPES.forEach(t => { const o=document.createElement('option'); o.value=t; o.textContent=t; ts.appendChild(o); }); ts.value=type; tl.appendChild(ts);
    const rm=document.createElement('button'); rm.className='remove-row'; rm.textContent='×'; rm.title='Remove'; rm.addEventListener('click',()=>row.remove());
    row.appendChild(nl); row.appendChild(tl); row.appendChild(rm); c.appendChild(row);
}
function collectDesignerColumns() {
    return Array.from($('designerColumns').children).map(r => ({ name:r.querySelector('input[type="text"]').value.trim(), type:r.querySelector('select').value })).filter(c=>c.name);
}
$('btnAddDesignerColumn').addEventListener('click', () => addDesignerColumn());

// Fill the database dropdown + datalist from PostgreSQL
async function refreshDesignerDatabases() {
    const pg = state.pg || readPg();
    if (!pg.user) { setMsg('designerMsg', 'Enter the PostgreSQL user first (connection card)', 'error'); return; }
    setMsg('designerMsg', 'Reading databases…');
    const r = await api('pg/discover', { pg });
    if (!r.ok) { setMsg('designerMsg', r.error, 'error'); return; }
    state.pg = pg;
    state.databases = r.databases || [];
    // dropdown
    const sel = $('existingDbSelect');
    sel.innerHTML = '<option value="">— select existing —</option>';
    state.databases.forEach(db => { const o=document.createElement('option'); o.value=db; o.textContent=db; sel.appendChild(o); });
    if (state.database) sel.value = state.database;
    // datalist
    const dl = $('dbNames'); dl.innerHTML='';
    state.databases.forEach(db => { const o=document.createElement('option'); o.value=db; dl.appendChild(o); });
    setMsg('designerMsg', `${state.databases.length} database(s) found`, 'ok');
}

// Fill the table datalist from the selected database
async function refreshDesignerTables() {
    const database = $('newDbName').value.trim() || $('existingDbSelect').value;
    if (!database) { setMsg('designerMsg', 'Select or enter a database first', 'error'); return; }
    const pg = state.pg || readPg();
    const r = await api('pg/tables', { pg, database });
    if (!r.ok) { setMsg('designerMsg', r.error, 'error'); return; }
    const schema = $('newSchema').value.trim() || 'public';
    const tables = (r.tables || []).filter(t => t.schema === schema).map(t => `${schema}.${t.name}`);
    const dl = $('tableNames'); dl.innerHTML='';
    tables.forEach(t => { const o=document.createElement('option'); o.value=t.split('.').pop(); dl.appendChild(o); });
    setMsg('designerMsg', `${tables.length} table(s) found in ${database}`, 'ok');
    return tables;
}

$('btnRefreshDbList').addEventListener('click', refreshDesignerDatabases);
$('btnRefreshTables').addEventListener('click', refreshDesignerTables);
$('existingDbSelect').addEventListener('change', () => {
    const db = $('existingDbSelect').value;
    if (db) { $('newDbName').value = db; refreshDesignerTables(); }
});
$('newDbName').addEventListener('change', () => { if ($('newDbName').value.trim()) refreshDesignerTables(); });

// Auto-load databases on page start only if credentials are already present
(async () => { if (readPg().user) await refreshDesignerDatabases(); })();

$('btnCreateDestination').addEventListener('click', async () => {
    const pg = state.pg || readPg();
    const database = $('newDbName').value.trim(); const schema = $('newSchema').value.trim() || 'public';
    const table = $('newTableName').value.trim(); const columns = collectDesignerColumns();
    if (!pg.user || !database || !table) { setMsg('designerMsg','Enter PostgreSQL user, database name and table name','error'); return; }
    if (columns.length===0 && !$('designerAddId').checked) { setMsg('designerMsg','Define at least one column','error'); return; }
    setMsg('designerMsg','Creating…');
    const dr = await api('pg/createDatabase', { pg, database });
    if (!dr.ok) { setMsg('designerMsg', dr.error, 'error'); return; }
    state.pg = pg; log('info', dr.message);
    const tr = await api('pg/createTable', { pg, database, schema, table, columns, addId:$('designerAddId').checked });
    if (!tr.ok) { setMsg('designerMsg', tr.error, 'error'); return; }
    log('ok', tr.message); setMsg('designerMsg', tr.message, 'ok');
    if (!state.databases.includes(database)) state.databases.push(database);
    state.database = database; state.table = null; state.columns = [];
    renderChips('dbList', state.databases.map(d=>({label:d,value:d})), state.database, selectDatabase);
    const lr = await api('pg/tables', { pg, database });
    if (lr.ok) {
        state.tables = lr.tables || [];
        const nt = state.tables.find(t => t.name===table && t.schema===schema);
        if (nt) { state.table = nt;
            renderChips('tableList', state.tables.map(t=>({label:`${t.schema}.${t.name}`,value:t})), `${schema}.${table}`, t=>{state.table=t;loadColumns();});
            await loadColumns(); log('info', `New destination selected: ${database}.${schema}.${table}`); }
    }
});
addDesignerColumn('Date et heure','timestamp with time zone');
addDesignerColumn('value','double precision');
addDesignerColumn('variable','text');

/* ---------------- OPC UA ---------------- */
$('btnOpcConnect').addEventListener('click', async () => {
    const cfg = readOpcua(); if (!cfg.endpointUrl) { setMsg('opcMsg','Enter the endpoint URL','error'); return; }
    setMsg('opcMsg','Connecting…'); const r = await api('opcua/connect', { cfg });
    if (!r.ok) { setMsg('opcMsg', r.error, 'error'); return; }
    state.opcuaConnected = true; state.allVariables.clear();
    $('btnOpcBrowse').disabled=false; $('btnOpcFindAll').disabled=false;
    setMsg('opcMsg', r.message, 'ok'); log('info', r.message);
});
$('btnOpcBrowse').addEventListener('click', async () => {
    const r = await api('opcua/browse', { nodeId:'i=85' });
    if (!r.ok) { setMsg('opcMsg', r.error, 'error'); return; }
    const tree = $('opcTree'); tree.classList.remove('empty'); tree.innerHTML='';
    renderNodes(r.nodes || [], tree); setMsg('opcMsg', `${r.nodes.length} node(s) at root`, 'ok');
});
$('btnOpcFindAll').addEventListener('click', async () => {
    setMsg('opcMsg','Scanning all OPC UA nodes…');
    const r = await api('opcua/browseAll', { options:{ maxDepth:6, maxNodes:3000 } });
    if (!r.ok) { setMsg('opcMsg', r.error, 'error'); return; }
    (r.variables||[]).forEach(v => state.allVariables.set(v.nodeId, { nodeId:v.nodeId, name:v.name }));
    refreshPairSelectors(); setMsg('opcMsg', `${state.allVariables.size} variable(s) found`, 'ok');
    log('info', `OPC UA scan: ${r.variables.length} variables found in ${r.visited} nodes`);
});
function renderNodes(nodes, container) {
    container.innerHTML='';
    nodes.forEach(node => {
        const row=document.createElement('div'); row.className='tree-row';
        if (!node.isVariable) {
            const exp=document.createElement('button'); exp.className='tree-expand'; exp.textContent='+'; exp.title='Expand';
            const children=document.createElement('div'); children.className='tree-node'; children.style.display='none';
            exp.addEventListener('click', async () => {
                if (children.style.display==='none') {
                    if (!children.dataset.loaded) {
                        const r=await api('opcua/browse', { nodeId:node.nodeId });
                        if (r.ok) { renderNodes(r.nodes||[], children); children.dataset.loaded='1'; }
                        else { children.textContent=r.error; return; }
                    }
                    children.style.display='block'; exp.textContent='−';
                } else { children.style.display='none'; exp.textContent='+'; }
            });
            row.appendChild(exp); container.appendChild(row); container.appendChild(children);
            const label=document.createElement('label');
            label.innerHTML=`<span class="node-name">${esc(node.name)}</span> <span class="node-tag">object · ${esc(node.nodeId)}</span>`;
            row.appendChild(label);
        } else {
            state.allVariables.set(node.nodeId, { nodeId:node.nodeId, name:node.name });
            const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=state.selected.has(node.nodeId);
            cb.addEventListener('change', () => {
                if (cb.checked) { state.selected.set(node.nodeId, { nodeId:node.nodeId, name:node.name });
                    state.mappings.push({ nodeId:node.nodeId, name:node.name, column:(state.columns[0]||{}).name||'', columnType:(state.columns[0]||{}).type||'', intervalMs:Number($('intervalMs').value)||2000 }); }
                else { state.selected.delete(node.nodeId); state.mappings=state.mappings.filter(m=>m.nodeId!==node.nodeId); }
                renderMapping(); refreshPairSelectors();
            });
            state.checkboxes.set(node.nodeId, cb); row.appendChild(cb);
            const label=document.createElement('label');
            label.innerHTML=`<span class="node-name">${esc(node.name)}</span> <span class="node-tag">variable · ${esc(node.nodeId)}</span>`;
            row.appendChild(label); container.appendChild(row);
        }
    });
}

/* ---------------- mapping ---------------- */
function refreshPairSelectors() {
    const vs=$('pairVariable'); const cv=vs.value; vs.innerHTML='<option value="">— select a variable —</option>';
    Array.from(state.allVariables.values()).sort((a,b)=>a.name.localeCompare(b.name)).forEach(item=>{
        const o=document.createElement('option'); o.value=item.nodeId; o.textContent=`${item.name} (${item.nodeId})`; vs.appendChild(o); });
    if (cv && state.allVariables.has(cv)) vs.value=cv;
    const cs=$('pairColumn'); const cc=cs.value; cs.innerHTML='<option value="">— select a column —</option>';
    state.columns.forEach(col=>{ const o=document.createElement('option'); o.value=col.name; o.textContent=`${col.name} (${col.type})`; cs.appendChild(o); });
    if (cc && state.columns.some(c=>c.name===cc)) cs.value=cc;
}
$('btnAddPair').addEventListener('click', () => {
    const nodeId=$('pairVariable').value; const column=$('pairColumn').value;
    if (!nodeId) { log('error','Choose an OPC UA variable first — use "Find all variables" if the list is empty'); return; }
    if (!column) { log('error','Choose a PostgreSQL column first'); return; }
    const col=state.columns.find(c=>c.name===column);
    const existing=state.mappings.find(m=>m.nodeId===nodeId);
    if (existing) { existing.column=column; existing.columnType=col?col.type:''; log('info',`Pair updated: ${existing.name} → ${column}`); }
    else { const src=state.allVariables.get(nodeId); const name=src?src.name:nodeId;
        state.selected.set(nodeId, { nodeId, name }); const cb=state.checkboxes.get(nodeId); if (cb) cb.checked=true;
        state.mappings.push({ nodeId, name, column, columnType:col?col.type:'', intervalMs:Number($('intervalMs').value)||2000 });
        log('ok',`Pair added: ${name} → ${column}`); }
    renderMapping();
});
function renderMapping() {
    const body=$('mappingBody'); body.innerHTML='';
    $('mappingHint').classList.toggle('hidden', state.mappings.length>0);
    state.mappings.forEach((mapping,index)=>{
        const row=document.createElement('tr');
        const nc=document.createElement('td'); nc.className='varname'; nc.textContent=mapping.name; nc.title=mapping.nodeId; row.appendChild(nc);
        const cc=document.createElement('td'); const sel=document.createElement('select');
        sel.innerHTML='<option value="">— select —</option>';
        state.columns.forEach(col=>{ const o=document.createElement('option'); o.value=col.name; o.textContent=`${col.name} (${col.type})`; sel.appendChild(o); });
        sel.value=mapping.column||'';
        sel.addEventListener('change',()=>{ mapping.column=sel.value; const col=state.columns.find(c=>c.name===sel.value); mapping.columnType=col?col.type:''; row.children[2].textContent=col?col.type:''; });
        cc.appendChild(sel); row.appendChild(cc);
        const tc=document.createElement('td'); const col=state.columns.find(c=>c.name===mapping.column); tc.textContent=col?col.type:''; row.appendChild(tc);
        const ic=document.createElement('td'); const ii=document.createElement('input'); ii.type='number'; ii.min='200'; ii.step='100'; ii.style.width='75px';
        ii.value=mapping.intervalMs||$('intervalMs').value||2000;
        ii.addEventListener('change',()=>{ mapping.intervalMs=Math.max(200,Number(ii.value)||2000); ii.value=mapping.intervalMs; log('info',`${mapping.name} will be inserted every ${mapping.intervalMs} ms`); });
        mapping.intervalMs=Number(ii.value)||2000; ic.appendChild(ii); row.appendChild(ic);
        const vc=document.createElement('td'); vc.className='live-value'; vc.id='live_'+index; vc.textContent='—'; row.appendChild(vc);
        const rc=document.createElement('td'); const rm=document.createElement('button'); rm.className='remove-row'; rm.textContent='×'; rm.title='Remove';
        rm.addEventListener('click',()=>{ state.mappings.splice(index,1); state.selected.delete(mapping.nodeId); const cb=state.checkboxes.get(mapping.nodeId); if (cb) cb.checked=false; renderMapping(); });
        rc.appendChild(rm); row.appendChild(rc); body.appendChild(row);
    });
}
setInterval(async () => {
    if (!state.opcuaConnected || state.mappings.length===0) return;
    const r = await api('opcua/read', { nodeIds: state.mappings.map(m=>m.nodeId) });
    if (!r.ok || !r.values) return;
    r.values.forEach((v,i)=>{ const cell=$('live_'+i); if (cell) cell.textContent=v.good?String(v.value):'BAD'; });
}, 1500);

/* ---------------- settings + run ---------------- */
document.querySelectorAll('input[name="mode"]').forEach(r=>r.addEventListener('change',()=>{
    const mode=document.querySelector('input[name="mode"]:checked').value;
    $('appendSettings').classList.toggle('hidden', mode!=='append');
    $('updateSettings').classList.toggle('hidden', mode!=='update');
}));
function buildConfig() {
    const mode=document.querySelector('input[name="mode"]:checked').value;
    if (!state.pg) state.pg=readPg();
    return { pg:state.pg, database:state.database, table:state.table, mode,
        timestampColumn: $('timestampColumn').value || (state.columns.some(c=>c.name==='Date et heure')?'Date et heure':''),
        keyColumn: mode==='update'?$('keyColumn').value:'', keyValue:$('keyValue').value.trim(),
        intervalMs:Number($('intervalMs').value)||2000,
        mappings: state.mappings.map(m=>({ nodeId:m.nodeId, name:m.name, column:m.column, columnType:m.columnType, intervalMs:m.intervalMs })) };
}
function validate() {
    if (!state.database||!state.table) { log('error','Select a database and table first'); return false; }
    if (!state.mappings.length) { log('error','Add at least one variable → column pair'); return false; }
    if (state.mappings.some(m=>!m.column)) { log('error','Every pair needs a target column'); return false; }
    const mode=document.querySelector('input[name="mode"]:checked').value;
    if (mode==='update'&&(!$('keyColumn').value||!$('keyValue').value.trim())) { log('error','Update mode needs a key column and key value'); return false; }
    return true;
}
$('btnStart').addEventListener('click', async () => {
    if (!validate()) return;
    const r=await api('transfer/start', { config:buildConfig() });
    if (!r.ok) { log('error',r.error); return; }
    $('btnStart').disabled=true; $('btnStop').disabled=false;
});
$('btnWriteOnce').addEventListener('click', async () => {
    if (!validate()) return;
    log('info','Writing one cycle now…');
    const r=await api('transfer/once', { config:buildConfig() });
    if (!r.ok) log('error',r.error);
});
$('btnCheckRows').addEventListener('click', async () => {
    if (!state.database||!state.table) { log('error','Select a database and table first'); return; }
    const r=await api('pg/count', { pg:state.pg||readPg(), database:state.database, table:state.table });
    if (!r.ok) { log('error',`Row count failed: ${r.error}`); return; }
    log('ok',`Database ${state.database}.${state.table.schema}.${state.table.name} currently has ${r.count} row(s)`);
});
$('btnStop').addEventListener('click', async () => { await api('transfer/stop', {}); $('btnStart').disabled=false; $('btnStop').disabled=true; });
$('btnSave').addEventListener('click', async () => {
    // store config in localStorage in the browser
    const config=buildConfig(); config.opcua=readOpcua();
    localStorage.setItem('opcua2pg-config', JSON.stringify(config));
    log('ok','Configuration saved (browser)');
});
$('btnLoad').addEventListener('click', async () => {
    const raw=localStorage.getItem('opcua2pg-config');
    if (!raw) { log('info','No saved configuration'); return; }
    const config=JSON.parse(raw);
    if (config.pg) { $('pgHost').value=config.pg.host||'localhost'; $('pgPort').value=config.pg.port||5432; $('pgUser').value=config.pg.user||''; $('pgPassword').value=config.pg.password||''; $('pgSsl').checked=!!config.pg.ssl; }
    if (config.opcua) { $('opcUrl').value=config.opcua.endpointUrl||''; $('opcSecMode').value=config.opcua.securityMode||'None'; $('opcUser').value=config.opcua.user||''; $('opcPassword').value=config.opcua.password||''; }
    if (config.database) { state.database=config.database; renderChips('dbList',state.databases.map(d=>({label:d,value:d})),state.database,selectDatabase); }
    state.table=config.table||null; state.mappings=config.mappings||[];
    state.selected=new Map(state.mappings.map(m=>[m.nodeId,{nodeId:m.nodeId,name:m.name}]));
    if (config.mode) { const radio=document.querySelector(`input[name="mode"][value="${config.mode}"]`); if (radio) radio.checked=true;
        $('appendSettings').classList.toggle('hidden',config.mode!=='append'); $('updateSettings').classList.toggle('hidden',config.mode!=='update'); }
    if (config.timestampColumn) $('timestampColumn').value=config.timestampColumn;
    if (config.keyColumn) $('keyColumn').value=config.keyColumn;
    if (config.keyValue) $('keyValue').value=config.keyValue;
    if (config.intervalMs) $('intervalMs').value=config.intervalMs;
    renderMapping(); refreshPairSelectors();
    log('info','Configuration loaded — reconnect to refresh databases, tables and columns');
});
$('btnClearLog').addEventListener('click',()=>{ $('logBox').innerHTML=''; });

/* ---------------- log polling ---------------- */
async function pollLogs() {
    try {
        const r = await api('logs?since=' + state.lastLogSeq);
        if (r.logs) { r.logs.forEach(l => { if (l.seq > state.lastLogSeq) { state.lastLogSeq = l.seq; log(l.level, l.message); } }); }
    } catch (_) { }
}
setInterval(pollLogs, 1000);

/* ---------------- init ---------------- */
loadGenerator();
pollLogs();
log('info', 'Ready. Start the embedded OPC UA generator or connect to a real OPC UA server.');
