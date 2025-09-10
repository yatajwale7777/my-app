// netlify/functions/api.js
// Robust Netlify function for Sheet11 / userid operations

const { getSheetsClientFromBase64 } = require('./_sheetsAuth');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';

/** getSheets: produce google sheets client from env */
function getSheets() {
  const b64 = process.env.GOOGLE_CREDENTIALS_BASE64 || process.env.GOOGLE_SVC_BASE64 || null;
  const jsonStr = process.env.GOOGLE_CREDENTIALS_JSON || null;
  if (b64) return getSheetsClientFromBase64(b64);
  if (jsonStr) {
    try {
      const parsed = (typeof jsonStr === 'string') ? JSON.parse(jsonStr) : jsonStr;
      const b = Buffer.from(JSON.stringify(parsed)).toString('base64');
      return getSheetsClientFromBase64(b);
    } catch (e) {
      throw new Error('Invalid GOOGLE_CREDENTIALS_JSON: ' + e.message);
    }
  }
  throw new Error('GOOGLE_CREDENTIALS_BASE64 (or equivalent) not set');
}

/** parse event for Netlify (handles JSON body and query params) */
function parseEvent(event) {
  let params = {};
  try {
    if (event.httpMethod === 'POST') {
      const ct = (event.headers && (event.headers['content-type'] || event.headers['Content-Type'])) || '';
      if (ct.toLowerCase().indexOf('application/json') !== -1) {
        params = JSON.parse(event.body || '{}');
      } else {
        // try to parse as urlencoded
        const kv = {};
        (event.body || '').split('&').forEach(pair => {
          if (!pair) return;
          const [k, v] = pair.split('=');
          try { kv[decodeURIComponent(k)] = decodeURIComponent((v||'').replace(/\+/g,' ')); } catch(e){ kv[k]=v; }
        });
        params = kv;
      }
    } else {
      params = event.queryStringParameters || {};
    }
  } catch (e) {
    console.error('parseEvent error', e);
    params = {};
  }
  return params || {};
}

/** normalize text */
const norm = s => ('' + (s || '')).toString().trim().toLowerCase();

/** normalize rows to rectangular array */
function normalizeRows(rows) {
  const max = rows.length ? Math.max(...rows.map(r => r.length)) : 0;
  return rows.map(r => {
    const c = r.slice();
    while (c.length < max) c.push('');
    return c;
  });
}

/** handler */
exports.handler = async function(event) {
  try {
    const params = parseEvent(event);
    const action = params.action || (params.payload && params.payload.action) || '';
    const payload = params.payload || params || {};

    if (!action) {
      return { statusCode: 400, body: JSON.stringify({ ok:false, error: 'no action specified' }) };
    }

    // lazy create sheets client & validate spreadsheet id
    let sheets;
    try {
      if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID not set in env');
      sheets = getSheets();
    } catch (e) {
      console.error('Auth/Config error:', e && e.message ? e.message : e);
      return { statusCode: 500, body: JSON.stringify({ ok:false, error: e.message || String(e) }) };
    }

    // ---------- getDropdownData ----------
    if (action === 'getDropdownData') {
      const rDate = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet11!A2' });
      const updateTime = (rDate.data && rDate.data.values && rDate.data.values[0] && rDate.data.values[0][0]) || '';

      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet11!A5:V' });
      const rows = r.data.values || [];
      const filtered = rows.filter(row => (row[0]||'').toString().trim() !== '');

      const uniq = arr => Array.from(new Set(arr.filter(Boolean).map(x=>x.toString().trim())));
      const engineers = uniq(filtered.map(r => r[1]));
      const works = uniq(filtered.map(r => r[3]));
      const status = uniq(filtered.map(r => r[6]));
      const years = uniq(filtered.map(r => r[5]));
      const allPanchayats = uniq(filtered.map(r => r[2]));

      const gpsByEngineer = {};
      filtered.forEach(rw => {
        const eng = (rw[1]||'').toString().trim();
        const gp = (rw[2]||'').toString().trim();
        if (!eng) return;
        gpsByEngineer[eng] = gpsByEngineer[eng] || new Set();
        if (gp) gpsByEngineer[eng].add(gp);
      });
      Object.keys(gpsByEngineer).forEach(k => gpsByEngineer[k] = Array.from(gpsByEngineer[k]));

      return { statusCode: 200, body: JSON.stringify({ ok:true, data:{ engineers, works, status, years, allPanchayats, gpsByEngineer, updateTime } }) };
    }

    // ---------- getFilteredData ----------
    if (action === 'getFilteredData') {
      const fil = (payload && payload.filter) || {};
      const userid = (payload && payload.userid) || (params && params.userid) || '';

      // Read data rows
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet11!A5:V' });
      const rows = r.data.values || [];
      const dataRows = rows.filter(row => (row[0]||'').toString().trim() !== '');

      // determine allowed panchayats for this userid
      let allowedPans = [];
      if (userid) {
        const us = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'userid!A2:F' });
        const users = us.data.values || [];
        const val = norm(userid);
        for (let i=0;i<users.length;i++){
          const name = norm(users[i][1]||'');
          const uid = norm(users[i][5]||'');
          if (val === name || val === uid) {
            allowedPans = (users[i][3]||'').toString().split(/\s*,\s*/).map(x => x.trim().toLowerCase()).filter(Boolean);
            break;
          }
        }
      }

      const out = dataRows.filter(row => {
        const eng = norm(row[1]);
        const gp = norm(row[2]);
        const work = norm(row[3]);
        const yr = norm(row[5]);
        const st = norm(row[6]);

        if (allowedPans.length && allowedPans.indexOf(gp) === -1) return false;
        if (fil.engineer && fil.engineer !== '' && eng !== norm(fil.engineer)) return false;
        if (fil.gp && fil.gp !== '' && gp !== norm(fil.gp)) return false;
        if (fil.work && fil.work !== '' && work !== norm(fil.work)) return false;
        if (fil.status && fil.status !== '' && st !== norm(fil.status)) return false;
        if (fil.year && fil.year !== '' && yr !== norm(fil.year)) return false;
        if (fil.search && fil.search.trim() !== '') {
          const s = norm(fil.search);
          const hay = (row.join(' ')||'').toString().toLowerCase();
          if (!hay.includes(s)) return false;
        }
        return true;
      });

      const normal = normalizeRows(out);
      return { statusCode: 200, body: JSON.stringify({ ok:true, rows: normal }) };
    }

    // ---------- appendOrUpdateUser ----------
    if (action === 'appendOrUpdateUser') {
      const p = payload || {};
      if (!p || !p.name || !p.post || !p.panchayats || !Array.isArray(p.panchayats) || p.panchayats.length === 0) {
        return { statusCode:400, body: JSON.stringify({ ok:false, error:'Missing required fields: name, post, panchayats[]' }) };
      }
      const us = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'userid!A2:F' });
      const users = us.data.values || [];
      const lowerName = p.name.toString().trim().toLowerCase();

      let foundIdx = -1;
      for (let i=0;i<users.length;i++){
        if ((users[i][1]||'').toString().trim().toLowerCase() === lowerName) { foundIdx = i; break; }
      }

      if (foundIdx >= 0) {
        const rowNum = 2 + foundIdx;
        const existingPans = (users[foundIdx][3]||'').toString().split(/\s*,\s*/).filter(Boolean);
        const merged = Array.from(new Set(existingPans.concat(p.panchayats)));
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `userid!D${rowNum}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[ merged.join(', ') ]] }
        });
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `userid!C${rowNum}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[ p.post ]] }
        });
        return { statusCode:200, body: JSON.stringify({ ok:true, result:{ action:'updated', row: rowNum } }) };
      } else {
        const srCol = users.map(r => r[0]).filter(Boolean).map(x=>Number(x)).filter(n=>!isNaN(n));
        let sr = 1; if (srCol.length) sr = Math.max(...srCol) + 1;
        const dcode = (p.dcode||'77').toString();
        const userid = (p.name.substr(0,3)+p.post.substr(0,2)+(''+dcode).slice(-2)+(''+sr).slice(-2)).toLowerCase();
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: 'userid!A:F',
          valueInputOption: 'RAW',
          requestBody: { values: [[ sr, p.name, p.post, p.panchayats.join(', '), dcode, userid ]] }
        });
        return { statusCode:200, body: JSON.stringify({ ok:true, result:{ action:'created', sr, userid
