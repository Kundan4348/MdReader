# Switch data in Assets Service: where each field comes from

**Owner:** Kundan (kunoku@), AWS SCM Assets Service · **Updated:** 12 Oct 2026 · **Status:** proposal for alignment

## In short

**Assets Service (PAS)** is the central record of AWS data center hardware: what each item is, where it sits and whether it is live.

**What we are doing.** Making the switch records in PAS complete and correct, in two steps:

1. **Create the missing switches.** Switches that our sources know about but PAS has no record for.
2. **Fix the data field by field** (serial, sticker tag, part number, parent rack and so on).

**How.** Every switch fact is already held by one or more other systems (NSM, InfraDB, Happoshu, Strider, AsBuilt, GutCheck, Townsend and Mobility). For each field we read the value from all of them and keep the value that **multiple sources agree on**. Those agreeing sources are the source of truth for that field. Where sources disagree, we leave PAS alone and a person decides. A few fields have only one owner, or are looked up from another field; the rules under the field table cover those.

**What we need from you.** Your team reads this data, so we want your agreement on the sources we use for each field (table below), and to hear if you trust or own a better source, or need a field we have not listed.

## The sources

| Source | What it is | What it can tell us about a switch |
|---|---|---|
| **NSM** | Network team's device management system | Whether it is live or retired, its device name (network hostname), its serial (read from the device) |
| **InfraDB** | Data center floor plan (Provisioning's `phys_location` table, also shown in the Provisioning Location Browser) | Which rack it sits in today, and the slot. InfraDB labels switches `NETWORK`, and a few as `FABRIC_SWITCH` or `Switch`; we count all of these as switches |
| **Happoshu** | NSM's view of devices and racks | Which rack it sits in today (second opinion to InfraDB) |
| **Strider** | DC receiving | Which rack it was received into |
| **AsBuilt** | Build sheets from the rack integrator, 2015 to now | Sticker tag, serial, part number, MAC addresses, rack it shipped in |
| **GutCheck** | Rack test results, Jul 2024 onwards | Tag, serial, part number and rack seen at test time |
| **Townsend** | Hardware part catalog | Whether a part number is a switch, and its manufacturer and model |
| **Mobility** | Spares and repair inventory | Serial and part number for switches that went through spares or repair (754K), and whether a part was destroyed or recycled |

Some sources copy each other, so they count as **one** opinion, not two: InfraDB and Strider (agree on all but 23 of 4.1M switches), and, for the rack, GutCheck and AsBuilt (99.95% the same).

## Sources per field

No single source is the master. For each field we compare every source that holds it, and the value they **agree on** is the one PAS keeps.

| Field | PAS field | Sources we compare |
|---|---|---|
| Switch exists | the record itself | NSM, AsBuilt, InfraDB, Happoshu, GutCheck |
| Live or retired | `lifecycleState` | NSM, Mobility (destroyed / recycled / failed) |
| Sticker tag | `physicalTagId` | AsBuilt, NSM, GutCheck |
| Serial | `physicalSerialId` | NSM, AsBuilt, GutCheck, Mobility |
| Part number | `internalPartNumber` | AsBuilt, GutCheck, Mobility |
| Type (is it a switch?) | `materialDefinitionId`, `materialClass` | Townsend, looked up from the agreed part number (NSM device layer as a cross-check) |
| Manufacturer, model | `manufacturer`, `manufacturerPartNumber`, `model` | Townsend, looked up from the agreed part number (Mobility, NSM as cross-checks) |
| Device name (network hostname) | `properties.device_name` (the only name field on switch records) | NSM device hostname (Happoshu `name` as cross-check); not the InfraDB / Provisioning server hostname |
| Parent rack | `parentPhysicalAssetId` | InfraDB, Happoshu, Strider, AsBuilt, GutCheck |
| Slot in the rack | `unit_position` | InfraDB, Happoshu, AsBuilt |
| Site and room | `physical_site_code`, `phys_location_room_id` | Taken from the agreed parent rack (Happoshu, InfraDB as cross-checks) |
| MAC addresses | `host_mac_addresses`, `bmc_mac_addresses` | AsBuilt |

**Rules:**
- **Multiple sources agree:** PAS takes that value. This is the main rule.
- **Sources disagree:** PAS is left alone and the switch goes to a person to review.
- **Only one source has a value:** PAS takes it only if that source is the field's natural owner (AsBuilt for part number and MAC, InfraDB or Happoshu for the rack) and no other source says something different. These are sample-checked before each batch. Any other single-source value goes to a person.
- **Looked-up fields:** type, manufacturer and model come from Townsend using the agreed part number, so they are right when the part number is.
- **Derived fields:** site and room come from the agreed parent rack.
- **Copies count once:** InfraDB and Strider hold the same record, and for the rack GutCheck copies AsBuilt, so each pair counts as one source. For other fields we suspect GutCheck copies AsBuilt but have not proven it.
- **Rack:** AsBuilt and GutCheck show the rack a switch was built in, so they only count when the switch has not moved since.
- **Device name:** PAS keeps a switch's name only in `properties.device_name`, filled from NSM's device hostname. The InfraDB / Provisioning server hostname is not used for it.

## How fixes go in

Creating a missing switch follows the same rules: every value in the new record must meet them. Creates and fixes are written in small batches, with a test batch first and a check after. A batch holds back anything that is retired or disposed, any switch where sources disagree, and any value that already sits on another PAS record.

## What we need from you

You use switch data from PAS, so we want your agreement before we create switches and fix fields at scale:

- **Sources:** are the sources listed for each field ones your team trusts? Tell us if you use a different or better source for any field.
- **Agreement rule:** are you fine with PAS taking a value when multiple sources agree (or, for a few fields, when the field's owner has it and nobody contradicts it), and leaving it alone when sources disagree?
- **Fields:** is any switch field you read from PAS missing from the table, or one you need fixed first?

Please add comments on this doc or reach out to kunoku@.
