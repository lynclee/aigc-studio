import { handleGeneratePost } from "@/lib/jobs/submit-route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  return handleGeneratePost(req, "model3d")
}
