-- Move existing deployments from the former external-login owner columns to
-- the provider-neutral Supabase Auth user_id naming used by the application.
-- Fresh databases already receive user_id from migrations 0001 and 0002.

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'gallery_items',
    'aigc_jobs',
    'aigc_generations',
    'aigc_assets'
  ]
  loop
    if exists (
      select 1
      from information_schema.columns as columns
      where columns.table_schema = 'public'
        and columns.table_name = target_table
        and columns.column_name = 'user_open_id'
    ) and not exists (
      select 1
      from information_schema.columns as columns
      where columns.table_schema = 'public'
        and columns.table_name = target_table
        and columns.column_name = 'user_id'
    ) then
      execute format('alter table public.%I rename column user_open_id to user_id', target_table);
    end if;
  end loop;
end $$;
