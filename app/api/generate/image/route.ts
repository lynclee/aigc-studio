import { handleGeneratePost } from "@/lib/jobs/submit-route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// OpenRouter 的图片接口在一次请求内直接返回成品；给它比队列提交更长的执行窗口。
export const maxDuration = 300

export async function POST(req: Request) {
  return handleGeneratePost(req, "image")
}
