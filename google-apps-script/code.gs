const SPREADSHEET_ID = "1EEDpYqHejXRJtRWvVLhWRIXZUi6acrvzFM_Tlaog62Q";
const SHEET_NAME = "Leads";

const HEADERS = [
  "received_at",
  "lead_id",
  "submitted_at",
  "first_name",
  "last_name",
  "date_of_birth",
  "move_timeline",
  "preferred_city",
  "move_reason",
  "annual_income",
  "credit_score",
  "beds_needed",
  "rent_budget",
  "current_rent",
  "contact_method",
  "email",
  "phone",
  "source_page",
  "referrer",
  "user_agent"
];

function doGet(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  const payload = (e && e.parameter) ? e.parameter : {};
  const callback = payload.callback;

  try {
    let response;
    if (!hasLeadData_(payload)) {
      response = {
        ok: true,
        service: "lead-capture",
        sheetName: SHEET_NAME
      };
      return callback ? jsCallbackResponse_(callback, response) : jsonResponse_(response);
    }

    response = writeLead_(payload);
    return callback ? jsCallbackResponse_(callback, response) : jsonResponse_(response);
  } finally {
    lock.releaseLock();
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const payload = parsePayload_(e);

    if (payload.action === "sendEmail") {
      return jsonResponse_(sendAssetEmail_(payload));
    }

    return jsonResponse_(writeLead_(payload));
  } catch (err) {
    return jsonResponse_( {
      ok: false,
      error: String(err)
    });
  } finally {
    lock.releaseLock();
  }
}

// Called by the Netlify email-asset function after it has already
// verified server-side that the purchase is real. This function's only
// job is sending the email — it does not re-check entitlement, so only
// the Netlify functions should ever call it (the URL itself is the only
// thing that needs to stay private).
function sendAssetEmail_(payload) {
  const to = String(payload.to || "").trim();
  if (!to || to.indexOf("@") === -1) {
    return { ok: false, error: "Missing or invalid recipient email." };
  }

  const firstName = payload.firstName || "there";
  const subject = payload.subject || "Your RentReady Download";
  const downloadUrl = payload.downloadUrl || "";

  const body =
    "Hi " + firstName + ",\n\n" +
    "Here is your secure download link:\n" + downloadUrl + "\n\n" +
    "This link is unique to your account and will expire after a few days " +
    "for security. If it expires, just log back in to the RentReady site " +
    "and request it again.\n\n" +
    "— RentReady Network";

  MailApp.sendEmail(to, subject, body);

  return { ok: true };
}

function parsePayload_(e) {
  if (!e) return {};

  if (e.postData && e.postData.contents) {
    const body = e.postData.contents;
    try {
      return JSON.parse(body);
    } catch (_err) {
      return e.parameter || {};
    }
  }

  return e.parameter || {};
}

function hasLeadData_(payload) {
  return !!(
    payload.first_name ||
    payload.last_name ||
    payload.email ||
    payload.phone
  );
}

function writeLead_(payload) {
  const sheet = getSheet_();
  ensureHeader_(sheet);

  const leadId = payload.lead_id || "";
  if (leadId && isDuplicateLeadId_(sheet, leadId)) {
    return {
      ok: true,
      message: "Lead already captured",
      deduped: true,
      lead_id: leadId
    };
  }

  const row = [
    new Date(),
    leadId,
    payload.submitted_at || "",
    payload.first_name || "",
    payload.last_name || "",
    payload.date_of_birth || "",
    payload.move_timeline || "",
    payload.preferred_city || "",
    payload.move_reason || "",
    payload.annual_income || "",
    payload.credit_score || "",
    payload.beds_needed || "",
    payload.rent_budget || "",
    payload.current_rent || "",
    payload.contact_method || "",
    payload.email || "",
    payload.phone || "",
    payload.source_page || "",
    payload.referrer || "",
    payload.user_agent || ""
  ];

  sheet.appendRow(row);

  return {
    ok: true,
    message: "Lead captured",
    lead_id: leadId
  };
}

function getSheet_() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID.indexOf("PASTE_") === 0) {
    throw new Error("SPREADSHEET_ID is not configured.");
  }
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function ensureHeader_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsCallbackResponse_(callback, obj) {
  const safeCallback = String(callback).replace(/[^\w.$]/g, "");
  const body = safeCallback + "(" + JSON.stringify(obj) + ");";
  return ContentService
    .createTextOutput(body)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function isDuplicateLeadId_(sheet, leadId) {
  if (!leadId) return false;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const ids = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(leadId)) return true;
  }
  return false;
}
