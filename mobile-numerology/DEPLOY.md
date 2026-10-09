# Going live (free)

Everything runs on free plans: Cloudflare Workers (the site and its server), Neon (the database you already use),
Google Apps Script (your Sheet) and Cloudflare Turnstile (the spam check). Allow about 30 minutes.

## 1. Database (Neon)
1. Open your Neon project. Go to **SQL Editor**, paste the contents of `db/schema.sql`, and press **Run**.
2. On the project **Dashboard**, open **Connection details** and copy the connection string (starts with `postgresql://`).
   This is `DATABASE_URL`.

## 2. Google Sheet
1. Create a new, empty Google Sheet (for example "Numerology leads").
2. **Extensions > Apps Script**. Delete what is there, paste all of `apps-script/numerology-leads.gs`, and save.
3. **Project Settings** (gear icon) **> Script Properties > Add**: name `SHEET_SECRET`, value a long random string
   (for example 40 random letters and digits). Keep it; it is also `SHEET_SECRET` below.
4. Back in the editor, choose the function `setup` and press **Run**. Approve the permissions. The **Leads** and **Stats**
   tabs appear.
5. **Deploy > New deployment > Web app**. Execute as: **Me**. Who has access: **Anyone**. Press **Deploy** and copy the
   URL ending in `/exec`. This is `SHEET_WEBAPP_URL`.

## 3. Cloudflare
1. Create a free account at cloudflare.com.
2. **Turnstile > Add widget**. Name it, add the hostname you will use (your `*.workers.dev` address, shown after the first
   deploy; you can edit it then), choose **Managed**. Copy the **site key** and the **secret key**.

## 4. Deploy
From the `mobile-numerology` folder on a computer with Node.js 20+:

```bash
npm install
npx wrangler login                      # opens Cloudflare in the browser
npx wrangler secret put DATABASE_URL    # paste each value when asked
npx wrangler secret put SHEET_WEBAPP_URL
npx wrangler secret put SHEET_SECRET
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
2. A new row appears in the **Leads** tab within a few seconds. Submitting the same details again adds no row.
3. Owner view (shows the rule and source behind every line): add `?owner=YOUR_OWNER_KEY` to the link.
4. If a row is missing, it is retried every 10 minutes automatically (see `sheet_error` in the `numerology_leads` table).

## Before changing any rule
Edit the files in `rules/`, then run `npm test`. It fails if a quote is not in the sources, if wording adds anything the
source does not say, or if a slide item has no rule. See `AUDIT.md`.
