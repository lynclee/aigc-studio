import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const sql = readFileSync("supabase/migrations/0009_aigc_asset_deletion.sql", "utf8")

describe("0009 asset deletion database contract", () => {
  it("atomically owner-guards, locks, tombstones, and queues in one RPC", () => {
    expect(sql).toMatch(/function public\.tombstone_generation_assets/)
    expect(sql).toMatch(/join public\.aigc_jobs[\s\S]*job\.user_id = p_user_id/)
    expect(sql).toMatch(/for update;/)
    expect(sql).toMatch(/generation asset ownership is inconsistent/)
    expect(sql).toMatch(/update public\.aigc_generations[\s\S]*deleted_at/)
    expect(sql).toMatch(/update public\.aigc_assets[\s\S]*state = 'pending_delete'/)
  })

  it("claims with SKIP LOCKED, increments attempts, and fences completion by token", () => {
    expect(sql).toMatch(/function public\.deadletter_expired_asset_deletes[\s\S]*for update skip locked[\s\S]*limit greatest/)
    expect(sql).toMatch(/function public\.claim_pending_asset_deletes/)
    expect(sql).toMatch(/for update skip locked/)
    expect(sql).toMatch(/delete_attempts = asset\.delete_attempts \+ 1/)
    expect(sql).toMatch(/delete_lease_until = statement_timestamp\(\)/)
    expect(sql).toMatch(/function public\.complete_asset_delete/)
    expect(sql).toMatch(/delete_retry_after = case[\s\S]*when 1 then 30[\s\S]*when 3 then 120/)
    expect(sql.match(/delete_claim_token = p_claim_token/g)?.length).toBe(2)
  })

  it("caps retries, indexes pending rows, and restricts every RPC to service_role", () => {
    expect(sql).toMatch(/delete_attempts between 0 and 5/)
    expect(sql).toMatch(/aigc_assets_pending_delete_idx/)
    for (const signature of [
      "tombstone_generation_assets\\(uuid, text\\)",
      "deadletter_expired_asset_deletes\\(integer\\)",
      "claim_pending_asset_deletes\\(integer, integer\\)",
      "complete_asset_delete\\(uuid, uuid, boolean, text\\)",
    ]) {
      expect(sql).toMatch(new RegExp(`revoke execute on function public\\.${signature}[\\s\\S]*from public, anon, authenticated`))
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${signature} to service_role`))
    }
  })
})
