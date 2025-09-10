// netlify/functions/api.js
const { getSheetsClientFromBase64 } = require('./_sheetsAuth');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';

/**
 * Try to produce a google sheets client.
 * Accepts:
 *  - process.env.GOOGLE_CREDENTIALS_BASE64  (recommended)
 *  - process.env.GOOGLE_CREDENTIALS_JSON   (single-line JSON)
 *  - process.env.GOOGLE_SVC_BASE64         (legacy)
 */
function getSheets() {
  const b64 = process.env.GOOGLE_CREDENTIALS_BASE64 || process.env.GOOGLE_SVC_BASE64 || null;
  const jsonStr = process.env.GOOGLE_CREDENTIALS_JSON || null;
  if (b64) {
    return getSheetsClientFromBase64(b64);
  }
  if (jsonStr) {
    try {
      // if user provided JSON, encode to base64 and reuse same helper
      const parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
      const b = Buffer.from(JSON.stringify(parsed)).toString('base64');
      return getSheetsClientFromBase64(b);
    } catch (e) {
      throw new Error('Invalid GOOGLE_CREDENTIALS_JSON: ' + e.message);
    }
  }
  throw new Error('GOOGLE_CREDENTIALS_BASE64 (or equivalent) not set');
}

/**
 * Helpers to parse event/query/post body
 */
function parseEvent(event) {
  let params = {};
  try {
    if (event.httpMethod === 'POST') {
      if (event.headers && event.headers['content-type'] && event.headers['content-type'].indexOf('application/json') !== -1) {
        params = JSON.parse(event.body || '{}');
      } else {
        // parse x-www-form-urlencoded style body if needed
        try {
          const kv = {};
          (event.body || '').split('&').forEach(pair => {
            const [k, v] = pair.split('=');
            if (k) kv[decodeURIComponent(k)] = decodeURIComponent((v||'').replace(/\+/g,' '));
          });
          params = kv;
        } catch (e) { params = {}; }
      }
    } else {
      params = event.queryStringParameters || {};
    }
  } catch (e) {
    params = {};
  }
  return params || {};
}

/**
 * Normalize rows (pad to same length)
 */
function normalizeRows(rows) {
  const max = rows.length ? Math.max(...rows.map(r => r.length)) : 0;
  return rows.map(r => {
    const c = r.slice();
    while (c.length < max) c.push('');
    return c;
  });
}

/**
 * Lambda handler
 */
exports.handler = async function(event) {
  try {
    const params = parseEvent(event);
    const action = params.action || (params.payload && params.payload.action) || '';
    const payload = params.payload || params || {};

    if (!action) {
      return { statusCode: 400, body: JSON.stringify({ ok:false, error: 'no action specified' }) };
    }

    // create sheets client lazily
    let sheets;
    try {
      sheets = getSheets();
    } catch (e) {
      console.error('Auth error:', e.message);
      return { statusCode: 500, body: JSON.stringify({ ok:false, error: e.message }) };
    }

    // ------- ACTION: getDropdownData -------
    if (action === 'getDropdownData') {
      // A2 = update time
      const rDate = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet11!A2' });
      const updateTime = (rDate.data && rDate.data.values && rDate.data.values[0] && rDate.data.values[0][0]) || '';

      // A5:V data
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet11!A5:V' });
      const rows = r.data.values || [];
      const filtered = rows.filter(row => (row[0]||'').toString().trim() !== '');

      const uniq = arr => Array.from(new Set(arr.filter(Boolean).map(x => x.toString().trim())));
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

      return {
        statusCode: 200,
        body: JSON.stringify({ ok:true, data:{ engineers, works, status, years, allPanchayats, gpsByEngineer, updateTime } })
      };
    }

    // ------- ACTION: getFilteredData -------
    if (action === 'getFilteredData') {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet11!A5:V' });
      const rows = r.data.values || [];
      const filtered = rows.filter(row => (row[0]||'').toString().trim() !== '');
      const normal = normalizeRows(filtered);
      return { statusCode: 200, body: JSON.stringify({ ok:true, rows: normal }) };
    }

    // ------- ACTION: appendOrUpdateUser -------
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
        return { statusCode:200, body: JSON.stringify({ ok:true, result:{ action:'created', sr, userid } }) };
      }
    }

    // ------- ACTION: validateUser (name or userid) -------
    if (action === 'validateUser' || action === 'validateUserCredential' || action === 'validateUserCredential') {
      const input = (payload && payload.input) || params.input || params.userid || params.inputValue;
      if (!input) return { statusCode:400, body: JSON.stringify({ ok:false, error:'no input provided' }) };
      const us = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'userid!A2:F' });
      const users = us.data.values || [];
      const val = (''+input).toString().trim().toLowerCase();
      for (let i=0;i<users.length;i++){
        const name = (users[i][1]||'').toString().trim(), userid = (users[i][5]||'').toString().trim();
        if (name.toLowerCase()===val || userid.toLowerCase()===val) {
          const pans = (users[i][3]||'').toString().split(/\s*,\s*/).filter(Boolean);
          return { statusCode:200, body: JSON.stringify({ ok:true, user:{ valid:true, name, userid, panchayats:pans } }) };
        }
      }
      return { statusCode:200, body: JSON.stringify({ ok:false, user:{ valid:false } }) };
    }

    // unknown action
    return { statusCode:400, body: JSON.stringify({ ok:false, error:'unknown action: ' + action }) };

  } catch (err) {
    console.error('API error:', err && err.stack ? err.stack : err);
    return { statusCode:500, body: JSON.stringify({ ok:false, error: (err && err.message) ? err.message : String(err) }) };
  }
};
