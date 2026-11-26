# Catalog Helper

A web UI, and later an MCP server, over Feedsmith, so buyers can make product
sets, set up catalogs and check status without the admin API. Not built yet: the
PRD and ADRs come first, and this is the working feature list.

## Approach

A separate app at `catalog.ignitetoolbelt.com`, served from the Feedsmith Worker,
behind Ignite SSO. It stays out of the Meta ads audit dashboard, whose Meta token
must stay read-only. Open: whether the `ignitetoolbelt.com` zone is on the same
Cloudflare account, and whether all buyers have Ignite logins.

## Features

| Feature | Engine | UI |
|---|---|---|
| Sign in, per-site access | Not built | Not built |
| Site status: last run, feed age, why a run was rejected | Partial (`/admin/.../runs`) | Not built |
| Product set builder with live counts | Built, admin only | Not built |
| Request a new site or catalog, operator approves | Not built | Not built |
| Image hosting: on/off per site, progress, images with problems | Built (`mirrorImages`, `/admin/sites/{id}/images`) | Not built |
| Links from the Meta ads audit dashboard | n/a | Not built |

## MCP server

From a code review on 2026-11-06. All of it needs the same sign-in and per-site
grants as the UI, plus a shared service layer pulled out of `src/api/app.ts`
(guessed at 2 to 3 days). The admin token is never handed to an MCP client.

**First version:** `list_my_sites`, `get_site_status`, `get_filter_values`,
`list_product_sets`, `preview_product_set`, `save_product_set`. These cover making
and checking a set, put no load on stores, and only `save_product_set` writes to
another system. Keep it operator-only at first, and fix the adopted-set rename in
[followups](followups.md) before it ships.

**Later:** `find_items`, `get_meta_push_status`, `check_set_on_meta`,
`preview_product_page`, `start_run` (operator only, with a cooldown), `audit_feed`,
and an `onboard_site` prompt.

**Don't expose:** site creation and feed password rotation (the password would land
in the transcript), `PUT` and `DELETE /meta` (the token would be a tool argument),
and site config changes such as publish gates.

**Guard rails:**
- Product titles and descriptions are scraped text, so treat them as a prompt
  injection path: leave descriptions out by default and label scraped fields.
- A human approves set writes, after seeing before and after counts. Feedsmith
  can't see which ads use a set, so narrowing one can starve live ads.
- There's no "collection" in Feedsmith today. Hand-picked sets can use
  `retailer_id is_any` (500 SKUs), but new sizes won't join them. Meta's own
  collections would be new work.
