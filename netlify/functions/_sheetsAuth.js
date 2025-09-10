const { google } = require("googleapis");
const path = require("path");

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "../../key.json"), // adjust path as needed
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

module.exports = auth;
