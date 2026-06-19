import { prisma } from './prisma'

export type LimitResource = 'leads' | 'listas' | 'campanhas'

interface PlanLimits {
  leads?: number
  listas?: number
  campanhas?: number
  validacoesWhatsapp?: number
  enriquecimentos?: number
}

const RESOURCE_LABELS: Record<LimitResource, string> = {
  leads: 'leads',
  listas: 'listas',
  campanhas: 'campanhas',
}

/**
 * Throws 403 if the account has hit its plan limit for the given resource.
 * Accounts without a plan (planId = null) are always unrestricted.
 */
export async function checkLimit(accountId: string, resource: LimitResource): Promise<void> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { plan: { select: { limits: true } } },
  })

  const limits = account?.plan?.limits as PlanLimits | null
  if (!limits) return

  const limit = limits[resource]
  if (limit === undefined || limit === null) return

  let current = 0
  if (resource === 'leads') {
    current = await prisma.listaContato.count({ where: { lista: { accountId } } })
  } else if (resource === 'listas') {
    current = await prisma.lista.count({ where: { accountId } })
  } else if (resource === 'campanhas') {
    current = await prisma.campanha.count({ where: { accountId } })
  }

  if (current >= limit) {
    throw Object.assign(
      new Error(
        `Limite de ${RESOURCE_LABELS[resource]} atingido (${current}/${limit}). Faça upgrade do seu plano para continuar.`
      ),
      { statusCode: 403 }
    )
  }
}
