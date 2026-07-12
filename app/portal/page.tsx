import { redirect } from "next/navigation"
import { getSession } from "@/lib/session"
import { PortalWorkbench } from "@/components/portal-workbench"
import { providerNameForKind } from "@/lib/jobs/providers"
import {
  emptyPublicWorkflowCatalog,
  publicWorkflowCatalogForProviders,
} from "@/lib/workflows/definitions"

export const dynamic = "force-dynamic"

export default async function PortalPage() {
  const session = await getSession()
  if (!session) redirect("/")

  let workflowCatalog = emptyPublicWorkflowCatalog()
  try {
    workflowCatalog = publicWorkflowCatalogForProviders({
      image: providerNameForKind("image"),
      video: providerNameForKind("video"),
      model3d: providerNameForKind("model3d"),
    })
  } catch {
    // Keep the portal usable when a provider selector is invalid. Submit will return the existing
    // provider configuration error; the client must not advertise reference inputs in that state.
  }

  return (
    <PortalWorkbench
      userName={session.name}
      userAvatar={session.avatar}
      workflowCatalog={workflowCatalog}
    />
  )
}
