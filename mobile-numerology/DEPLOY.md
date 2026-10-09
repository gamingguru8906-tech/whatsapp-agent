# Going live (free)

Everything runs on free plans: Cloudflare Workers (the site and its server), Kamala's database (Neon), Kamala's
Google Sheet and Cloudflare Turnstile (the spam check). The site's code stays separate from Kamala's; it only writes
its leads into Kamala's database and Sheet, and Kamala reads them back for you with `/numerology`. Allow about 30 minutes.

## 1. Database: Kamala's database
Nothing to create. The site uses the same database as Kamala and makes its own table (`numerology_leads`) the first
time someone submits the form. It never touches Kamala's tables.

1. Open Render > the WhatsApp bot service > **Environment**. Copy the value of `DATABASE_URL`
   (starts with `postgresql://`). The site uses this same value as its `DATABASE_URL`.

## 2. Google Sheet: Kamala's CRM spreadsheet
Leads go to a new **Numerology Leads** tab (plus **Numerology Stats**) in Kamala's CRM spreadsheet:
https://docs.google.com/spreadsheets/d/1Le23X0BniY9hBpv3wuA3gPTaBGMFFfEwwEpQLLiowRU/edit
(The separate Sheet from the earlier plan is no longer used.)

1. Open that spreadsheet > **Extensions > Apps Script** (the project that already runs Kamala).
2. Next to **Files** press **+ > Script**, name it `numerology-leads`, paste all of `apps-script/numerology-leads.gs`,
   press **Save**.
3. Open the file that has `doPost`. Find the line that reads the request into `data`
   (like `var data = JSON.parse(e.postData.contents);`). Right **after** it, and **before** the apiSecret check, add:
   ```js
   var numerologyResult = handleNumerologyTarget_(data);
   if (numerologyResult) return numerologyResult;
   ```
   These lines answer only the numerology site, which has its own key. Kamala's requests carry on as before, and the
   site never gets Kamala's apiSecret. Press **Save**.
4. At the top choose **setupNumerologySheets** and press **Run** (approve permissions if asked). In the
   **Execution log**:
   - **Hook OK** means step 3 is right. **Hook NOT working** means the two lines are missing or below the apiSecret
     check: move them and run it again.
   - Copy the value after `NUMEROLOGY_SHEET_SECRET:`. This is the site's `SHEET_SECRET`.
5. **Deploy > Manage deployments >** pencil icon on the web app **> Version: New version > Deploy**. The `/exec` URL
   stays the same (it is Kamala's `GOOGLE_APPS_SCRIPT_URL` on Render). This URL is the site's `SHEET_WEBAPP_URL`.
   Saving alone never updates the live URL.

## 3. Cloudflare
1. Create a free account at cloudflare.com.
2. **Turnstile > Add widget**. Name it, add the hostname you will use (your `*.workers.dev` address, shown after the first
   deploy; you can edit it then), choose **Managed**. Copy the **site key** and the **secret key**.

## 4. Deploy
From the `mobile-numerology` folder on a computer with Node.js 20+:

```bash
npm install
npx wrangler login                      # opens Cloudflare in the browser
npx wrangler secret put DATABASE_URL    # Kamala's DATABASE_URL from Render (paste each value when asked)
npx wrangler secret put SHEET_WEBAPP_URL # Kamala's Apps Script /exec URL
npx wrangler secret put SHEET_SECRET     # NUMEROLOGY_SHEET_SECRET from step 2 (not Kamala's apiSecret)
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put OWNER_KEY       # any long random string; opens the owner view
npm run deploy
```

Then, in the Cloudflare dashboard, open the worker **veshannastro-numerology > Settings > Variables** and set:
- `WHATSAPP_NUMBER`: your WhatsApp business number with country code, digits only (for example `919812345678`).
- `TURNSTILE_SITE_KEY`: the Turnstile site key.

(Or put both in `wrangler.toml` under `[vars]` and run `npm run deploy` again.)

Prefer that Claude deploys it? Add a Cloudflare API token (template **Edit Cloudflare Workers**) and your account ID to
this cloud environment's secrets as `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, plus the values above.

## 5. Check it
1. Open the `https://veshannastro-numerology.<your-subdomain>.workers.dev` link and get a reading.
2. A new row appears in the **Numerology Leads** tab of Kamala's Sheet within a few seconds. Submitting the same
   details again adds no row.
3. Message Kamala **/numerology** from your owner number: she replies with the counts and the latest leads.
   `/numerology 25` shows more; `/numerology rahul` or `/numerology 98110` searches. (Needs the Kamala update that
   adds this command.)
4. Owner view (shows the rule and source behind every line): add `?owner=YOUR_OWNER_KEY` to the link.
5. If a row is missing from the Sheet, it is retried every 10 minutes automatically. The reason is in the
   `sheet_error` column of `numerology_leads`; "Unauthorized" means the two lines from step 2.3 are not in place.

## Before changing any rule
Edit the files in `rules/`, then run `npm test`. It fails if a quote is not in the sources, if wording adds anything the
source does not say, or if a slide item has no rule. See `AUDIT.md`.
