// netlify/functions/envtest.js
exports.handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      spreadsheet: process.env.SPREADSHEET_ID || null,
      hasCreds: !!process.env.GOOGLE_CREDENTIALS_BASE64
    })
  };
};
