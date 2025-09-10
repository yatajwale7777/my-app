// api.js
const { getSheetsClientFromBase64 } = require('./_sheetsAuth');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';

exports.handler = async function(event) {
  try {
    const body = (event.httpMethod === 'POST') ? JSON.parse(event.body || '{}') : (event.queryStringParameters || {});
    const action = body.action || (body.payload && body.payload.action) || (event.queryStringParameters && event.queryStringParameters.action);
    const payload = body.payload || {};
    const sheets = getSheetsClientFromBase64(process.env.GOOGLE_SVC_BASE64);

    // column mapping note (0-based)
    // Sheet11 columns: 0:A SR, 1:B Engineer, 2:C GP, 3:D Type, 4:E Name, 5:F Year, 6:G Status, ... up to V

    if (!action) return { statusCode:400, body: JSON.stringify({ ok:false, error:'no action' }) };

    if (action === 'getDropdownData') {
      // read A2 (date) and A5:V (data rows)
      const rDate = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet11!A2' });
      const updateTime = (rDate.data.values && rDate.data.values[0] && rDate.data.values[0][0]) || '';

      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet11!A5:V' });
      const rows = r.data.values || [];
      const filtered = rows.filter(r => (r[0]||'').toString().trim() !== '');

      const uniq = arr => Array.from(new Set(arr.filter(Boolean)));
      const engineers = uniq(filtered.map(r => (r[1]||'').toString().trim()));
      const works = uniq(filtered.map(r => (r[3]||'').toString().trim()));
      const status = uniq(filtered.map(r => (r[6]||'').toString().trim()));
      const years = uniq(filtered.map(r => (r[5]||'').toString().trim()));
      const allPanchayats = uniq(filtered.map(r => (r[2]||'').toString().trim()));

      // gpsByEngineer
      const gpsByEngineer = {};
      filtered.forEach(rw => {
        const eng = (rw[1]||'').toString().trim();
        const gp = (rw[2]||'').toString().trim();
        if (!eng) return;
        if (!gpsByEngineer[eng]) gpsByEngineer[eng] = new Set();
        if (gp) gpsByEngineer[eng].add(gp);
      });
      Object.keys(gpsByEngineer).forEach(k => gpsByEngineer[k] = Array.from(gpsByEngineer[k]));

      return { statusCode:200, body: JSON.stringify({ ok:true, data:{ engineers, works, status, years, allPanchayats, gpsByEngineer, updateTime } }) };
    }

    if (action === 'getFilteredData') {
      // Implement filtering logic similar to Apps Script backend
      // For starter, return all rows normalized
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet11!A5:V' });
      const rows = r.data.values || [];
      const filtered = rows.filter(r => (r[0]||'').toString().trim() !== '');
      // normalize columns (pad)
      const maxCols = Math.max(...filtered.map(r=>r.length), 1);
      const normal = filtered.map(r => { const c = r.slice(); while (c.length < maxCols) c.push(''); return c; });
      return { statusCode:200, body: JSON.stringify({ ok:true, rows: normal }) };
    }

    if (action === 'appendOrUpdateUser') {
      // payload: { name, post, panchayats:[], dcode }
      const p = payload;
      if (!p || !p.name || !p.post || !p.panchayats || p.panchayats.length===0) {
        return { statusCode:400, body: JSON.stringify({ ok:false, error:'Missing required fields' }) };
      }
      // read userid sheet
      const us = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'userid!A2:F' });
      const users = us.data.values || [];
      const lowerName = p.name.toString().trim().toLowerCase();
      // try find by name
      let foundIdx = -1;
      for (let i=0;i<users.length;i++){
        if ((users[i][1]||'').toString().trim().toLowerCase() === lowerName) { foundIdx = i; break; }
      }
      if (foundIdx >= 0) {
        // update row: merge panchayats & set post & dcode
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
        // append new row
        // compute next SR
        const srCol = users.map(r => r[0]).filter(Boolean).map(x=>Number(x)).filter(n=>!isNaN(n));
        let sr = 1; if (srCol.length) sr = Math.max(...srCol) + 1;
        const userid = (p.name.substr(0,3)+p.post.substr(0,2)+(''+(p.dcode||'77')).slice(-2)+(''+sr).slice(-2)).toLowerCase();
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: 'userid!A:F',
          valueInputOption: 'RAW',
          requestBody: { values: [[ sr, p.name, p.post, p.panchayats.join(', '), p.dcode||'77', userid ]] }
        });
        return { statusCode:200, body: JSON.stringify({ ok:true, result:{ action:'created', sr, userid } }) };
      }
    }

    if (action === 'validateUser') {
      const input = (payload && payload.input) || (body.payload && body.payload.input) || (body.input);
      if (!input) return { statusCode:400, body: JSON.stringify({ ok:false, error:'no input' }) };
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

    return { statusCode:400, body: JSON.stringify({ ok:false, error:'unknown action' }) };

  } catch (err) {
    console.error(err);
    return { statusCode:500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
};
