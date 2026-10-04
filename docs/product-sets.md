# Product sets

Filters to build in Commerce Manager > Catalog > Sets > Create set > "Use
filters". Sets built on filters update as the feed changes. Counts are from the
University of Alabama Supply Store feed of 2026-10-04 (5,399 items).

The feed carries these fields for filtering:

| Field | Values |
|---|---|
| `custom_label_0` (department) | Bama Merchandise, Tide Tech, Graduation Supplies, Art & School |
| `custom_label_1` (clearance) | `clearance`, or empty |
| `custom_label_2` (price band) | Under $25, $25-$50, $50-$100, $100+ |
| `custom_label_3` (featured) | `featured`, or empty |
| `gender` | female, male, unisex |
| `age_group` | adult, kids, toddler, infant |
| `product_type` | the store's category, e.g. T-Shirts; Sweats, Jackets, & Pullovers; Caps, Hats, & Beanies |

## Recommended sets

Keep it to these. Meta delivers best with broad sets; split further only for a
specific campaign.

| Set | Filter | Items |
|---|---|---|
| All in stock (default prospecting) | Availability is in stock AND Custom label 1 is not `clearance` | ~4,600 |
| Bama Merchandise | Custom label 0 is `Bama Merchandise` | ~4,790 |
| Tide Tech | Custom label 0 is `Tide Tech` | ~276 |
| Graduation | Custom label 0 is `Graduation Supplies` | ~224 |
| Art & School | Custom label 0 is `Art & School` | ~104 |
| Women's | Gender is `female` | ~1,242 |
| Kids | Age group is any of `kids`, `toddler`, `infant` | ~322 |
| Clearance | Custom label 1 is `clearance` | ~799 |

Useful for specific pushes:

| Set | Filter |
|---|---|
| Gifts under $25 | Custom label 2 is `Under $25` AND Custom label 1 is not `clearance` |
| Headwear | Product type contains `Caps` |
| Store picks | Custom label 3 is `featured` (small: ~26) |

Notes:
- "Bama Merchandise" is nearly the whole store; it is the store's own name for
  its apparel and gear department. Use gender/age sets to split it.
- 486 items are only listed under the store's clearance category, so their
  product type reads "All Clearance Items". They are still labeled clearance.
