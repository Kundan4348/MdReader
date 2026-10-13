# Switch data in Assets Service: where each field comes from

**Owner:** Kundan (kunoku@), AWS SCM Assets Service · **Updated:** 12 Oct 2026 · **Status:** proposal for alignment

## In short

**Assets Service (PAS)** is the central record of AWS data center hardware: what each item is, where it sits and whether it is live.

**What we are doing.** Making the ~5.41M switch records in PAS complete and correct, in two steps:

1. **Create the missing switches.** Switches that our sources know about but PAS has no record for.
2. **Fix the data field by field** (serial, sticker tag, part number, parent rack and so on).

**How.** Every switch fact is already held by one or more other systems (NSM, InfraDB, Happoshu, Strider, AsBuilt, GutCheck, Townsend and Mobility). For each field we read the value from all of them and keep the value that **multiple sources agree on**. Those agreeing sources are the source of truth for that field. Where sources disagree, we leave PAS alone and a person decides. A few fields have only one owner, or are looked up from another field; the rules under the field table cover those.

**What we need from you.** Your team reads this data, so we want your agreement on the sources we use for each field (table below), and to hear if you trust or own a better source, or need a field we have not listed.

## The sources


<table data-id="94cJH1njLK" data-col-sizes="169,400,400">
  <tr data-id="ifeBw6UGbD">
    <th data-id="_a9JR0xP1R">Source</th>
    <th data-id="7rHqQBEdpF">What it is</th>
    <th data-id="iIr83AvJ8Z">What it can tell us about a switch</th>
  </tr>
  <tr data-id="pUfpg1DgO1">
    <td data-id="hpjIeyABfL"><strong>NSM</strong></td>
    <td data-id="DW58C1nyz2">Network team's device management system</td>
    <td data-id="gwHAbAKfEv">Whether it is live or retired, its device name (network hostname), its serial (read from the device)</td>
  </tr>
  <tr data-id="2v8-HOVW5A">
    <td data-id="hFZil3opmi"><strong>InfraDB</strong></td>
    <td data-id="OedJ-VLi5T">Data center floor plan (Provisioning's <code>phys_location</code> table, also shown in the Provisioning Location Browser)</td>
    <td data-id="uaiBtwkJIB">Which rack it sits in today, and the slot. InfraDB labels switches <code>NETWORK</code>, and a few as <code>FABRIC_SWITCH</code> or <code>Switch</code>; we count all of these as switches</td>
  </tr>
  <tr data-id="oQRME2EdbV">
    <td data-id="gV_kFfq7O1"><strong>Happoshu</strong></td>
    <td data-id="GxykdGcRSa">NSM's view of devices and racks</td>
    <td data-id="XIhyZjvHfO">Which rack it sits in today (second opinion to InfraDB)</td>
  </tr>
  <tr data-id="DjKCrunNag">
    <td data-id="5kTKz-1sbL"><strong>Strider</strong></td>
    <td data-id="Ekm7bWJafu">DC receiving</td>
    <td data-id="y740BsrWX2">Which rack it was received into</td>
  </tr>
  <tr data-id="bDwi9TW_1n">
    <td data-id="gO4lTuKYRK"><strong>AsBuilt</strong></td>
    <td data-id="oJqp-xea7W">Build sheets from the rack integrator, 2015 to now</td>
    <td data-id="FLCFfe7hNp">Sticker tag, serial, part number, MAC addresses, rack it shipped in</td>
  </tr>
  <tr data-id="8gloC8eiP0">
    <td data-id="5bVbVUiAP7"><strong>GutCheck</strong></td>
    <td data-id="d5FSjCWwZP">Rack test results, Jul 2024 onwards</td>
    <td data-id="Y12iGLX-PH">Tag, serial, part number and rack seen at test time</td>
  </tr>
  <tr data-id="jnP8zGXoN2">
    <td data-id="d_cMPAfZWK"><strong>Townsend</strong></td>
    <td data-id="dUS3gUA6yi">Hardware part catalog</td>
    <td data-id="VGGsyPL78z">Whether a part number is a switch, and its manufacturer and model</td>
  </tr>
  <tr data-id="_KZIda2kGG">
    <td data-id="AN0wyqTsMt"><strong>Mobility</strong></td>
    <td data-id="OSE6Wzb97C">Spares and repair inventory</td>
    <td data-id="6WYhqtlPUy">Serial and part number for switches that went through spares or repair (754K), and whether a part was destroyed or recycled</td>
  </tr>
</table>

Some sources copy each other, so they count as **one** opinion, not two: InfraDB and Strider (agree on all but 23 of 4.1M switches), and, for the rack, GutCheck and AsBuilt (99.95% the same).

## <!-- comment:96885e85-669d-4307-85bb-92eea4bbb22b -->Sources per field<!-- /comment:96885e85-669d-4307-85bb-92eea4bbb22b -->

No single source is the master. For each field we compare every source that holds it, and the value they **agree on** is the one PAS keeps.


<table data-id="228EzP4EsM" data-col-sizes="200,368,400">
  <tr data-id="k5AMu-r6S5">
    <th data-id="cTQUtLwwMf"><!-- comment:85c72612-5a27-41b5-aaaa-59811f1afb9d -->Field<!-- /comment:85c72612-5a27-41b5-aaaa-59811f1afb9d --></th>
    <th data-id="F9-jn1UQkp">PAS field</th>
    <th data-id="WNhKFcrflJ">Sources we compare</th>
  </tr>
  <tr data-id="z-NBxHf6rV" data-row-size="48">
    <td data-id="0f3f-3EsqQ"><!-- comment:b63daf9b-c463-49ef-b00b-f162806200d6 -->Switch exists<!-- /comment:b63daf9b-c463-49ef-b00b-f162806200d6 --></td>
    <td data-id="ZRFoXKfx9n">the record itself</td>
    <td data-id="bx12IDW6V-">NSM, AsBuilt, InfraDB, Happoshu, GutCheck</td>
  </tr>
  <tr data-id="5dctSgkaeA">
    <td data-id="HqEO7D-9xc">Live or retired</td>
    <td data-id="oEFt7G9cY2"><code>lifecycleState</code></td>
    <td data-id="J1P3VQkhT7">NSM, Mobility (destroyed / recycled / failed)</td>
  </tr>
  <tr data-id="X8XIY9_gjR">
    <td data-id="-FSnItLRtD">Sticker tag</td>
    <td data-id="sABlJR39nC"><code>physicalTagId</code></td>
    <td data-id="T56UrHGZtT">AsBuilt, NSM, GutCheck</td>
  </tr>
  <tr data-id="3pojj-kRZk">
    <td data-id="MBeJD9fPId">Serial</td>
    <td data-id="sMPdVDc0v2"><code>physicalSerialId</code></td>
    <td data-id="JiSOfacnrj">NSM, AsBuilt, GutCheck, Mobility</td>
  </tr>
  <tr data-id="w9BFw15Zdq">
    <td data-id="sul83bdpKa">Part number</td>
    <td data-id="wNE9OtIxI-"><code>internalPartNumber</code></td>
    <td data-id="SzcfOOwG9K">AsBuilt, GutCheck, Mobility</td>
  </tr>
  <tr data-id="Qm6oH2YFbR">
    <td data-id="q_BRIxfobo">Type (is it a switch?)</td>
    <td data-id="9tu874GV5B"><code>materialDefinitionId</code>, <code>materialClass</code></td>
    <td data-id="mQpFiqYeyC">Townsend, looked up from the agreed part number (NSM device layer as a cross-check)</td>
  </tr>
  <tr data-id="9w-Vo1fHrd">
    <td data-id="vaGFuay_YM">Manufacturer, model</td>
    <td data-id="pwQ25Bwt9C"><code>manufacturer</code>, <code>manufacturerPartNumber</code>, <code>model</code></td>
    <td data-id="SS4B_mu1TP">Townsend, looked up from the agreed part number (Mobility, NSM as cross-checks)</td>
  </tr>
  <tr data-id="FHMd6yL7bb">
    <td data-id="UGlAIT6lEJ"><!-- comment:3d816ca7-0de5-4c15-ab7c-63d4ea43249f -->Device name (network hostname)<!-- /comment:3d816ca7-0de5-4c15-ab7c-63d4ea43249f --></td>
    <td data-id="6GrePlOfER"><code>properties.device_name</code> (the only name field on switch records)</td>
    <td data-id="rexJo9OhVU">NSM device hostname (Happoshu <code>name</code> as cross-check); not the InfraDB / Provisioning server hostname</td>
  </tr>
  <tr data-id="rM19s2bCry">
    <td data-id="wuOYqhjM_0">Parent rack</td>
    <td data-id="_TJBEeGJg2"><code>parentPhysicalAssetId</code></td>
    <td data-id="pawGCbMYYa">InfraDB, Happoshu, Strider, AsBuilt, GutCheck</td>
  </tr>
  <tr data-id="6HsTOUCvGg">
    <td data-id="2oqyn4IpuK">Slot in the rack</td>
    <td data-id="bDzERN05by"><code>unit_position</code></td>
    <td data-id="ZDv2Ylxc07">InfraDB, Happoshu, AsBuilt</td>
  </tr>
  <tr data-id="e6sD_Jg84r">
    <td data-id="qjC8NppMMa">Site and room</td>
    <td data-id="nGfyWVzoVB"><code>physical_site_code</code>, <code>phys_location_room_id</code></td>
    <td data-id="mAFyA9UnM7">Taken from the agreed parent rack (Happoshu, InfraDB as cross-checks)</td>
  </tr>
  <tr data-id="ZA1k9Vo4D5">
    <td data-id="iFC8Ew6LZw">MAC addresses</td>
    <td data-id="tK_XDl6sVp"><code>host_mac_addresses</code>, <code>bmc_mac_addresses</code></td>
    <td data-id="id89hBKNt2">AsBuilt</td>
  </tr>
</table>

**Rules:**

- **Multiple sources agree:** PAS takes that value. This is the main rule.
- <!-- comment:abd8666a-f0ea-4287-a05b-b30a6344e6ff -->**Sources disagree:**<!-- /comment:abd8666a-f0ea-4287-a05b-b30a6344e6ff --><!-- comment:abd8666a-f0ea-4287-a05b-b30a6344e6ff --> PAS is left alone and the switch goes to a person to review.<!-- /comment:abd8666a-f0ea-4287-a05b-b30a6344e6ff -->
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

Please add comments on this doc or reach out to kunoku\@.
