import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const sql = readFileSync("supabase/migrations/0010_asset_delete_operations.sql", "utf8")

describe("0010 asset delete operations contract", () => {
  it("stores an append-only, non-sensitive redrive audit behind RLS", () => {
    expect(sql).toMatch(/create table if not exists public\.aigc_asset_delete_redrive_events/)
    for (const field of [
      "asset_id",
      "generation_id",
      "job_id",
      "user_id",
      "actor",
      "reason",
      "redrive_version",
      "previous_attempts",
      "previous_error_code",
      "created_at",
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${field}\\b`))
    }
    expect(sql).toMatch(/enable row level security/)
    expect(sql).toMatch(/events are append-only/)
    expect(sql).toMatch(/before update or delete or truncate on public\.aigc_asset_delete_redrive_events/)
    const auditInsert = sql.match(/insert into public\.aigc_asset_delete_redrive_events \([\s\S]*?\) values \([\s\S]*?\);/)?.[0]
    expect(auditInsert).toBeTruthy()
    expect(auditInsert).not.toMatch(/r2_key|delete_error|provider_job_id/)
  })

  it("redrives only a locked error row with authority and namespace fences", () => {
    expect(sql).toMatch(/function public\.redrive_asset_delete\([\s\S]*p_actor text[\s\S]*p_reason text/)
    expect(sql).toMatch(/asset\.state = 'error'[\s\S]*for update/)
    expect(sql).toMatch(/asset\.delete_attempts >= 5/)
    expect(sql).toMatch(/asset\.delete_claim_token is null/)
    expect(sql).toMatch(/asset\.delete_lease_until is null/)
    expect(sql).toMatch(/asset\.delete_redrive_version = p_expected_redrive_version/)
    expect(sql).toMatch(/generation\.deleted_at is not null/)
    expect(sql).toMatch(/generation\.job_id = v_asset\.job_id/)
    expect(sql).toMatch(/generation\.user_id = v_asset\.user_id/)
    expect(sql).toMatch(/job\.user_id = v_asset\.user_id/)
    expect(sql).toMatch(/safeDirectR2Segment\(\)[\s\S]*regexp_replace/)
    expect(sql).toMatch(/v_current_prefix[\s\S]*v_direct_prefix[\s\S]*v_legacy_prefix/)
    expect(sql).toMatch(/key ownership is inconsistent/)
  })

  it("audits the prior stable state and atomically resets every retry fence", () => {
    expect(sql).toMatch(/v_previous_error_code := case[\s\S]*unclassified_asset_delete_error/)
    expect(sql).toMatch(/insert into public\.aigc_asset_delete_redrive_events[\s\S]*update public\.aigc_assets/)
    expect(sql).toMatch(/set state = 'pending_delete'/)
    expect(sql).toMatch(/delete_attempts = 0/)
    expect(sql).toMatch(/delete_error = null/)
    expect(sql).toMatch(/delete_retry_after = statement_timestamp\(\)/)
    expect(sql).toMatch(/delete_claim_token = null/)
    expect(sql).toMatch(/delete_lease_until = null/)
    expect(sql).toMatch(/delete_redrive_version = v_next_redrive_version/)
    expect(sql).toMatch(/and state = 'error'/)
    expect(sql).toMatch(/redrive actor must be an attributable identifier/)
    expect(sql).toMatch(/redrive reason must be a stable lowercase code/)
  })

  it("exposes only aggregate due, leased, pending, and error counts", () => {
    expect(sql).toMatch(/function public\.asset_delete_backlog_counts\(\)/)
    for (const field of [
      "observed_at",
      "pending_total",
      "pending_due",
      "pending_leased",
      "retry_wait",
      "deadletter_due",
      "error_total",
      "oldest_pending_at",
      "oldest_error_at",
    ]) {
      expect(sql).toContain(`'${field}'`)
    }
    const backlogFunction = sql.match(/create or replace function public\.asset_delete_backlog_counts\(\)[\s\S]*?\$\$;/)?.[0]
    expect(backlogFunction).toBeTruthy()
    expect(backlogFunction).not.toMatch(/user_id|job_id|r2_key'|delete_error|actor|reason/)
  })

  it("denies browser roles and provides no user-facing redrive endpoint", () => {
    expect(sql).toMatch(/revoke all on table public\.aigc_asset_delete_redrive_events[\s\S]*from public, anon, authenticated, service_role/)
    expect(sql).toMatch(/grant select on table public\.aigc_asset_delete_redrive_events to service_role/)
    for (const signature of [
      "asset_delete_backlog_counts\\(\\)",
      "redrive_asset_delete\\(uuid, bigint, text, text\\)",
    ]) {
      expect(sql).toMatch(new RegExp(`revoke execute on function public\\.${signature}[\\s\\S]*from public, anon, authenticated`))
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${signature} to service_role`))
    }
    expect(existsSync("app/api/assets/redrive/route.ts")).toBe(false)
  })
})
