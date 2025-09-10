// netlify/functions/_sheetsAuth.js
const { google } = require('googleapis');

function getSheetsClientFromBase64(base64json) {
  if (!base64json) throw new Error('GOOGLE_CREDENTIALS_BASE64 not set');
  // decode base64 -> JSON
  let key;
  try {
    key = JSON.parse(Buffer.from(base64json, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error('Failed to parse base64 JSON: ' + err.message);
  }
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

module.exports = { getSheetsClientFromBase64 };

