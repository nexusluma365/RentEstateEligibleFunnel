# Google Sheets Lead Capture Setup

## 1) Create the destination Google Sheet
1. Create a new Google Sheet.
2. Copy the spreadsheet ID from the URL:
`https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`

## 2) Create Apps Script Web App
1. Go to `script.google.com` and create a new Apps Script project.
2. Replace the default code with `google-apps-script/Code.gs`.
3. In `Code.gs`, set:
   - `SPREADSHEET_ID`
   - (optional) `SHEET_NAME`
4. Deploy:
   - Click `Deploy` -> `New deployment`
   - Type: `Web app`
   - Execute as: `Me`
   - Who has access: `Anyone`
5. Copy the deployed Web App URL.
6. If you update script code later, deploy a **new version** (or update deployment) before testing again.

## 3) Connect the website form
1. In Netlify, add the deployed Apps Script Web App URL as `GOOGLE_SCRIPT_URL`.
2. The website posts to `/.netlify/functions/submit-lead`, and that function forwards the lead to Apps Script.
3. Do not paste the Apps Script URL into public HTML.

## 4) Test end-to-end
1. Run site locally.
2. Fill the full lead modal and submit.
3. Confirm a new row appears in the `Leads` sheet.

## Captured fields
- lead_id
- submitted_at
- first_name
- last_name
- date_of_birth
- move_timeline
- preferred_city
- move_reason
- annual_income
- credit_score
- beds_needed
- rent_budget
- current_rent
- contact_method
- email
- phone
- source_page
- referrer
- user_agent
