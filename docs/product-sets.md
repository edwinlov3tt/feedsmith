# Product sets

Filters for product sets in Meta Commerce Manager (Catalog > Sets > Create set >
"Use filters") and TikTok Catalog Manager. Sets built on filters update as the
feed changes. Counts are items (one per size and color) in the University of
Alabama Supply Store feed of 2026-10-27 (6,698 items).

The feeds carry these fields for filtering:

| Field | Values |
|---|---|
| `custom_label_0` (department) | the store's departments: Apparel, Bama Gear, Tide Tech, Home & Office, Graduation Supplies, Accessories, Art & School, Athletics, Media |
| `custom_label_1` (clearance) | `clearance`, or empty |
| `custom_label_2` (price band) | Under $25, $25-$50, $50-$100, $100+ |
| `custom_label_3` (promotions) | `featured`, `new` (the store's New Items category), `featured new` when both, or empty; filter with "contains" |
| `custom_label_4` (clothing type) | T-Shirts, Sweatshirts & Hoodies, Shirts & Tops, Hats, Polos, Pants & Leggings, Shorts, Jackets & Outerwear, Jerseys, Bras, Dresses & Skirts, Footwear, and a few smaller ones; empty when not clothing |
| `google_product_category` | Google's category for clothing, e.g. Apparel & Accessories > Clothing > Shirts & Tops; empty when not clothing |
| `gender` | female, male, unisex |
| `age_group` | adult, kids, toddler, infant |
| `product_type` | the store's category, e.g. T-Shirts; Sweats, Jackets, & Pullovers; All Clearance Items |

The clothing type and Google category come from fixed rules over the product
name and store category (ADR 0001, 7f). Sweatshirts and hoodies sit in Google's
Shirts & Tops, since Google has no category for them; use `custom_label_4` to
split them from T-shirts.

## Meta

Feedsmith creates and syncs these on Meta (`POST .../product-sets/defaults`;
New Items with `PUT .../product-sets/new-items`).

| Set | Filter | Items |
|---|---|---|
| All in stock (default prospecting) | Availability is in stock AND Custom label 1 is not `clearance` | ~5,000 |
| One per department | Custom label 0 is the department, e.g. `Apparel` | Apparel ~4,090 |
| Women's | Gender is `female` | ~1,620 |
| Kids | Age group is any of `kids`, `toddler`, `infant`, `newborn` | ~445 |
| Clearance | Custom label 1 is `clearance` | ~780 |
| New Items (`new-items`, added 2026-10-29) | Custom label 3 contains `new` | 156 products on the store's New Items page |

Useful for specific pushes:

| Set | Filter |
|---|---|
| Gifts under $25 | Custom label 2 is `Under $25` AND Custom label 1 is not `clearance` |
| One clothing type | Custom label 4 is `T-Shirts` (or `Hats`, `Sweatshirts & Hoodies`, ...) |
| Store picks | Custom label 3 contains `featured` (small: ~43) |

The Supply Store split its "Bama Merchandise" department into Apparel, Bama
Gear, Accessories, Home & Office, Athletics and Media in October 2026. The
`dept-bama-merchandise` set from 2026-10-04 now matches 2 items; see
docs/followups.md.

## TikTok

TikTok product sets are made in Catalog Manager (Products > Product sets >
Create product set > filter rules); Feedsmith doesn't sync them. Use the TikTok
feed (`/feeds/{siteId}/tiktok.csv`), which carries the same fields.

| Set | Filter rule | Items |
|---|---|---|
| All clothing | Google product category contains `Apparel & Accessories` | ~4,900 |
| T-shirts | Custom label 4 is `T-Shirts` | ~1,490 |
| Sweatshirts & hoodies | Custom label 4 is `Sweatshirts & Hoodies` | ~1,190 |
| Hats | Custom label 4 is `Hats` | ~460 |
| Polos | Custom label 4 is `Polos` | ~405 |
| New Items | Custom label 3 contains `new` | 156 products |
| Women's clothing | Google product category contains `Apparel & Accessories` AND Gender is `female` | |

Counts are across both stock states; add "Availability is in stock" to a set to
leave sold-out sizes out. If a field isn't offered in TikTok's filter list, the
next best is "Product type", which holds the store's own category.
