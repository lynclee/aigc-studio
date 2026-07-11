import { redirect } from "next/navigation"
import { getSession } from "@/lib/session"
import { PortalWorkbench } from "@/components/portal-workbench"

export const dynamic = "force-dynamic"

export default async function PortalPage() {
  const session = await getSession()
  if (!session) redirect("/")

  return <PortalWorkbench userName={session.name} userAvatar={session.avatar} />
}
