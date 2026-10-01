-- Mobility (Caspian Redshift) switch queries for Switch Accuracy
-- Server caspian-redshift-us-west-2.db.amazon.com:8192, db redshiftdb, schema infrabi_stg
-- Table/column names taken from AWSSCMAssetsDocumentation runbook handling_blocked_inventory_snapshot.md
-- Run Q0-Q2 first (small), paste results back, then run Q3 and export to CSV.

-- Q0a. Which part types are switches? (pick the switch type names from this list)
select t.part_type_id, t.type_name, count(*) as parts
from infrabi_stg.o_infr_dly_part p
join infrabi_stg.o_infr_part_model m on p.part_model_id = m.part_model_id
join infrabi_stg.o_infr_part_type  t on m.part_type_id  = t.part_type_id
where p.snapshot_day = current_date - 2
group by 1, 2
order by parts desc;

-- Q0b. What columns does the daily part snapshot have? (looking for state / site / location / asset columns)
select column_name, data_type
from svv_columns
where table_schema = 'infrabi_stg' and table_name = 'o_infr_dly_part'
order by ordinal_position;

-- Q1. Is Mobility still getting repairs after the 31 Mar 2026 Boost cutover?
select date_trunc('month', create_dtt) as month, count(*) as repairs
from infrabi_stg.o_infr_part_repair
where create_dtt >= '2025-01-01'
group by 1
order by 1;

-- Q2. Size check: switch parts in the latest snapshot
select count(*) as switch_parts,
       count(distinct p.serial_id) as distinct_serials,
       count(distinct m.apn) as distinct_apns
from infrabi_stg.o_infr_dly_part p
join infrabi_stg.o_infr_part_model m on p.part_model_id = m.part_model_id
join infrabi_stg.o_infr_part_type  t on m.part_type_id  = t.part_type_id
where p.snapshot_day = current_date - 2
  and upper(t.type_name) like '%SWITCH%';   -- tighten to the exact names from Q0a

-- Q3. The extract: every switch part, its current snapshot row, IPN, and its latest repair
--     (as the part put in, or the part taken out). Export the result to CSV.
with sw as (
    -- state + bin joins from the HWEng "Memory_Misc_mobility_C2_query" wiki (same tables, WH13 copy)
    select p.*, s.state, m.model, m.mpn, m.apn, t.type_name,
           b.part_bin_name, b.location_code, b.dc_cluster_code, b.availability_zone_code
    from infrabi_stg.o_infr_dly_part p
    join infrabi_stg.o_infr_part_model m on p.part_model_id = m.part_model_id
    join infrabi_stg.o_infr_part_type  t on m.part_type_id  = t.part_type_id
    left join infrabi_stg.o_infr_part_state s on p.part_state_id = s.part_state_id
    left join infrabi_stg.d_infr_part_bin_dim b on p.bin_id = b.part_bin_key
    where p.snapshot_day = current_date - 2
      and upper(t.type_name) like '%SWITCH%'   -- tighten to the exact names from Q0a
),
ev as (
    select consumed_part_id as part_id, repair_id, asset_id, create_dtt, 'consumed' as role
    from infrabi_stg.o_infr_part_repair where consumed_part_id is not null
    union all
    select broken_part_id   as part_id, repair_id, asset_id, create_dtt, 'broken'   as role
    from infrabi_stg.o_infr_part_repair where broken_part_id is not null
),
last_ev as (
    select part_id, repair_id, asset_id, create_dtt, role,
           count(*) over (partition by part_id) as repair_count,
           row_number() over (partition by part_id order by create_dtt desc) as rn
    from ev
    where part_id in (select part_id from sw)
)
select sw.*,
       e.repair_count,
       e.repair_id  as last_repair_id,
       e.role       as last_repair_role,      -- 'broken' = this part was taken out
       e.asset_id   as last_repair_asset_id,  -- where the swap happened, NOT where it sits now
       e.create_dtt as last_repair_at
from sw
left join last_ev e on e.part_id = sw.part_id and e.rn = 1;
